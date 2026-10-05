from datetime import datetime

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import UniqueConstraint


db = SQLAlchemy()


class UserAccounts(db.Model):
    __tablename__ = "user_accounts"

    user_id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(120), nullable=False, unique=True)
    # werkzeug hash, not plaintext
    password = db.Column(db.String(255), nullable=False)
    # unused, kept so existing databases don't need a migration
    role = db.Column(db.String(20), nullable=False, default="user")


class UploadLog(db.Model):
    __tablename__ = "upload_log"

    upload_id = db.Column(db.Integer, primary_key=True)
    file_hash = db.Column(db.String(64), nullable=False, unique=True)
    upload_date = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    # set when rows were skipped (unknown product or no price), so the same file can be retried
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
    # raw POS name, what upload rows are matched on
    product_alias = db.Column(db.String(255), nullable=True)
    # master price, copied onto transactions at upload time. editing it doesn't touch old rows
    price = db.Column(db.Numeric(12, 2), nullable=True)
    # soft delete: hidden from listings and uploads, but old sales still count in dashboard totals
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
    # grouped receipt id, restarts at 1 each day
    receipt_id = db.Column(db.Integer, nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey("products.product_id"), nullable=False)
    month = db.Column(db.Integer, nullable=False)
    day = db.Column(db.Integer, nullable=False)
    year = db.Column(db.Integer, nullable=False)
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
    # metrics are stale after a product was pruned out, until the next remine
    is_approximate = db.Column(db.Boolean, nullable=False, default=False)


class RuleItems(db.Model):
    __tablename__ = "rule_items"

    rule_item_id = db.Column(db.Integer, primary_key=True)
    rule_id = db.Column(db.Integer, db.ForeignKey("rules.rule_id"), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey("products.product_id"), nullable=False)
    side = db.Column(db.String(20), nullable=False)  # 'antecedent' or 'consequent'
