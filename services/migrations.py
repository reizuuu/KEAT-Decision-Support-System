"""Startup schema migrations for the existing instance/keat.sqlite3 file.

db.create_all() only creates tables that don't exist yet - it never adds
columns to a table that's already there. Since this prototype ships with a
pre-existing sqlite file, new columns (Products.product_alias,
UserAccounts.role) need an explicit ALTER TABLE + backfill so upgrading
doesn't require deleting the database.
"""

from sqlalchemy import func, inspect, text

from models import Products, RawTransaction, Rules, RuleItems, UploadLog, UserAccounts, db
from services.text import to_title_case


def run_startup_migrations():
    inspector = inspect(db.engine)

    _add_column_if_missing(inspector, "products", "product_alias", "VARCHAR(255)")
    _add_column_if_missing(inspector, "products", "price", "NUMERIC(12, 2)")
    _add_column_if_missing(inspector, "user_accounts", "role", "VARCHAR(20)")
    _add_column_if_missing(inspector, "products", "is_active", "BOOLEAN")
    _add_column_if_missing(inspector, "rules", "is_approximate", "BOOLEAN")
    _add_column_if_missing(inspector, "upload_log", "had_unmatched_rows", "BOOLEAN")

    _backfill_product_names_and_aliases()
    _merge_duplicate_products()
    _backfill_user_roles()
    _backfill_product_prices()
    _backfill_product_active_flag()
    _backfill_rule_approximate_flag()
    _backfill_upload_log_unmatched_flag()

    db.session.commit()


def _add_column_if_missing(inspector, table_name, column_name, column_type):
    existing_columns = {column["name"] for column in inspector.get_columns(table_name)}
    if column_name not in existing_columns:
        db.session.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}"))
        db.session.commit()


def _backfill_product_names_and_aliases():
    for product in Products.query.all():
        if not product.product_alias:
            product.product_alias = product.product_name
        title_cased = to_title_case(product.product_name)
        if product.product_name != title_cased:
            product.product_name = title_cased


def _merge_duplicate_products():
    """Collapses products that only differ by casing, e.g. "BT SMASH" and
    "BT Smash" ending up as two separate rows because get_or_create_product
    (services/persistence.py) used to match product_alias case-sensitively.
    _backfill_product_names_and_aliases above already title-cases every
    product_name, so duplicates now share an identical name - group on that,
    keep the oldest row per group, and move its sales/rule history over
    before dropping the rest.
    """
    products_by_name = {}
    for product in Products.query.order_by(Products.product_id).all():
        products_by_name.setdefault(product.product_name, []).append(product)

    for duplicates in products_by_name.values():
        if len(duplicates) < 2:
            continue
        canonical, *extras = duplicates
        for extra in extras:
            RawTransaction.query.filter_by(product_id=extra.product_id).update(
                {"product_id": canonical.product_id}
            )
            RuleItems.query.filter_by(product_id=extra.product_id).update(
                {"product_id": canonical.product_id}
            )
            if not canonical.product_alias and extra.product_alias:
                canonical.product_alias = extra.product_alias
            if canonical.price is None and extra.price is not None:
                canonical.price = extra.price
            db.session.delete(extra)


def _backfill_user_roles():
    # role is purely informational now (see models.UserAccounts.role) - any
    # pre-existing account missing one just gets the same default new
    # accounts get.
    for user in UserAccounts.query.filter((UserAccounts.role.is_(None)) | (UserAccounts.role == "")).all():
        user.role = "user"


def _backfill_product_prices():
    # Products.price is new and starts NULL for every existing row. Seed it
    # from each product's average observed RawTransaction.price - the same
    # number GET /api/products was already displaying via that fallback -
    # so upgrading doesn't change what anyone sees; it's now just editable.
    # Products with no sales history yet are left NULL (displayed as ₱0.00
    # until someone sets a price or real sales come in).
    averages = dict(
        db.session.query(RawTransaction.product_id, func.avg(RawTransaction.price)).group_by(
            RawTransaction.product_id
        )
    )
    for product in Products.query.filter(Products.price.is_(None)).all():
        if product.product_id in averages:
            product.price = averages[product.product_id]


def _backfill_product_active_flag():
    # is_active is new and starts NULL for every existing row (raw ALTER
    # TABLE ADD COLUMN, no default enforced at the SQLite level) - every
    # pre-existing product was, by definition, an active one, so it
    # backfills to True rather than being silently soft-deleted.
    for product in Products.query.filter(Products.is_active.is_(None)).all():
        product.is_active = True


def _backfill_rule_approximate_flag():
    # Same reasoning as above: a rule that existed before this column did
    # was mined normally, not structurally patched, so it backfills to
    # False (not approximate).
    for rule in Rules.query.filter(Rules.is_approximate.is_(None)).all():
        rule.is_approximate = False


def _backfill_upload_log_unmatched_flag():
    # Every pre-existing UploadLog row predates the "skip unmatched
    # products" feature - back when auto-create meant no row was ever
    # skipped for a catalog reason, so False (fully matched) is the
    # correct/safe backfill regardless of what that upload actually
    # contained.
    for upload_log in UploadLog.query.filter(UploadLog.had_unmatched_rows.is_(None)).all():
        upload_log.had_unmatched_rows = False
