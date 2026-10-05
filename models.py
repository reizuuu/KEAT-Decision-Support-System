from datetime import datetime

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import UniqueConstraint


db = SQLAlchemy()


class UserAccounts(db.Model):
    __tablename__ = "user_accounts"

    user_id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(120), nullable=False, unique=True)
    # Column name kept as "password" per the schema spec, but it always
    # holds a werkzeug password hash - never plaintext.
    password = db.Column(db.String(255), nullable=False)
    # Legacy column - no longer gates any behavior. Every account can view
    # and change its own credentials (see routes/users.py); there's no
    # "manage any other account" tier anymore. Left in place rather than
    # migrated away since dropping it isn't required for anything functional
    # (see services/migrations.py for how a real schema change would look).
    role = db.Column(db.String(20), nullable=False, default="user")


class UploadLog(db.Model):
    __tablename__ = "upload_log"

    upload_id = db.Column(db.Integer, primary_key=True)
    file_hash = db.Column(db.String(64), nullable=False, unique=True)
    upload_date = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    # True when this exact file's most recent processing attempt had to
    # skip at least one row because its product wasn't in the (active)
    # catalog. routes/upload.py's whole-file dedup check only blocks a
    # re-upload of this same file when this is False - an upload that
    # skipped rows for a catalog reason isn't "done" in any meaningful
    # sense, and the same file re-uploaded after the catalog is fixed
    # should get a chance to pick up what it missed. Row-level dedup
    # (services/persistence.drop_existing_rows) independently guarantees a
    # re-upload never double-inserts whatever already succeeded.
    had_unmatched_rows = db.Column(db.Boolean, nullable=False, default=False)


class Category(db.Model):
    __tablename__ = "category"

    category_id = db.Column(db.Integer, primary_key=True)
    category_name = db.Column(db.String(120), nullable=False, unique=True)


class Products(db.Model):
    __tablename__ = "products"

    product_id = db.Column(db.Integer, primary_key=True)
    category_id = db.Column(db.Integer, db.ForeignKey("category.category_id"))
    product_name = db.Column(db.String(255), nullable=False)
    # POS/receipt-style short name, preserved as-is from the uploaded CSV.
    # This is the stable identifier CSV rows are matched against - see
    # services/persistence.find_active_product_by_alias - since product_name
    # is editable by staff and may drift from the raw POS text over time.
    product_alias = db.Column(db.String(255), nullable=True)
    # Staff-editable list/menu price. Null for a product that's never had one
    # set directly (e.g. auto-created from an upload) - GET /api/products
    # falls back to the average observed RawTransaction.price in that case
    # (see routes/products.get_products), so display still works before
    # anyone sets this explicitly. Since it's authoritative at upload time
    # (see services/persistence.apply_master_pricing), this is also the
    # "Current Master Price" written into RawTransaction.price/total going
    # forward - a later edit here never retroactively touches historical
    # RawTransaction rows, which are only ever written once, at insert.
    price = db.Column(db.Numeric(12, 2), nullable=True)
    # Soft-delete flag. False means "removed from the catalog" - it
    # disappears from every listing/dropdown (routes/products.get_products,
    # the dashboard's Category/Product filters, upload matching) but its
    # historical RawTransaction rows are untouched and keep counting in
    # dashboard totals forever (services/aggregation.py deliberately never
    # filters on this column). See routes/products.delete_product.
    is_active = db.Column(db.Boolean, nullable=False, default=True)


class TransactionStatistics(db.Model):
    __tablename__ = "transaction_statistics"

    statistic_id = db.Column(db.Integer, primary_key=True)
    category_id = db.Column(db.Integer, db.ForeignKey("category.category_id"))
    year = db.Column(db.Integer, nullable=False)
    month = db.Column(db.Integer, nullable=False)
    day = db.Column(db.Integer, nullable=False)
    total_customers = db.Column(db.Integer, default=0)
    total_revenue = db.Column(db.Numeric(12, 2), default=0)

    __table_args__ = (
        UniqueConstraint(
            "category_id", "year", "month", "day", name="uq_stat_category_day"
        ),
    )


class RawTransaction(db.Model):
    __tablename__ = "raw_transaction"

    record_id = db.Column(db.Integer, primary_key=True)
    upload_id = db.Column(db.Integer, db.ForeignKey("upload_log.upload_id"), nullable=False)
    # Stores the true_receipt_id produced by the contiguous-grouping step in
    # routes/upload.py, not the raw per-file receipt id from the CSV - this
    # schema has only one receipt-id column, so it has to carry the grouped
    # value. Ids reset per (year, month, day), not globally.
    receipt_id = db.Column(db.Integer, nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey("products.product_id"), nullable=False)
    month = db.Column(db.Integer, nullable=False)
    day = db.Column(db.Integer, nullable=False)
    year = db.Column(db.Integer, nullable=False)
    # Optional per-row time-of-day, carried over from the CSV's optional
    # "Timestamp" column (see services/parsing.py). Null when the source
    # file doesn't provide one - the dashboard's hour-of-day chart falls
    # back to an empty state in that case (services/aggregation.py).
    timestamp = db.Column(db.DateTime, nullable=True)
    quantity = db.Column(db.Numeric(12, 2), nullable=False)
    price = db.Column(db.Numeric(12, 2), nullable=False)
    total = db.Column(db.Numeric(12, 2), nullable=False)


class Rules(db.Model):
    __tablename__ = "rules"

    rule_id = db.Column(db.Integer, primary_key=True)
    support = db.Column(db.Float, nullable=False)
    confidence = db.Column(db.Float, nullable=False)
    lift = db.Column(db.Float, nullable=False)
    leverage = db.Column(db.Float, nullable=False)
    conviction = db.Column(db.Float, nullable=False)
    # True when this rule's stored metrics are stale: set by
    # services/persistence.prune_rules_for_product when a product deletion
    # structurally edits this rule's antecedent/consequent set (removing one
    # of several items on a side) without recomputing support/confidence/
    # lift/leverage/conviction for the new, smaller itemset. Cleared
    # implicitly by the next full remine (services/persistence.remine_rules)
    # replacing this row outright with a freshly-computed one - never
    # cleared in place.
    is_approximate = db.Column(db.Boolean, nullable=False, default=False)


class RuleItems(db.Model):
    __tablename__ = "rule_items"

    rule_item_id = db.Column(db.Integer, primary_key=True)
    rule_id = db.Column(db.Integer, db.ForeignKey("rules.rule_id"), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey("products.product_id"), nullable=False)
    side = db.Column(db.String(20), nullable=False)  # 'antecedent' or 'consequent'
