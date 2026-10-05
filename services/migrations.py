"""Adds columns that were introduced after the first databases were created.

db.create_all() never alters an existing table, so new columns get an ALTER TABLE and a backfill.
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
    """Merges products that only differed by casing, keeping the oldest row."""
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
    for user in UserAccounts.query.filter((UserAccounts.role.is_(None)) | (UserAccounts.role == "")).all():
        user.role = "user"


def _backfill_product_prices():
    # same average price the products page already showed
    averages = dict(
        db.session.query(RawTransaction.product_id, func.avg(RawTransaction.price)).group_by(
            RawTransaction.product_id
        )
    )
    for product in Products.query.filter(Products.price.is_(None)).all():
        if product.product_id in averages:
            product.price = averages[product.product_id]


def _backfill_product_active_flag():
    for product in Products.query.filter(Products.is_active.is_(None)).all():
        product.is_active = True


def _backfill_rule_approximate_flag():
    for rule in Rules.query.filter(Rules.is_approximate.is_(None)).all():
        rule.is_approximate = False


def _backfill_upload_log_unmatched_flag():
    for upload_log in UploadLog.query.filter(UploadLog.had_unmatched_rows.is_(None)).all():
        upload_log.had_unmatched_rows = False
