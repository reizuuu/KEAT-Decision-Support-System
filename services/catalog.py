from pathlib import Path

import pandas as pd
from flask import current_app
from sqlalchemy import func

from config import MASTER_CATALOG_DIR
from models import Category, Products, db
from services.text import normalize_alias, to_title_case


def get_or_create_category(name):
    category = Category.query.filter_by(category_name=name).first()
    if category is None:
        category = Category(category_name=name)
        db.session.add(category)
        db.session.flush()
    return category


def find_active_product_by_alias(raw_name):
    """Lookup-only match against ACTIVE products, by normalized+lowercased
    alias - the stable POS identifier, not product_name (staff can edit
    product_name into something that no longer matches the raw POS text,
    and uploads must still resolve to the same product). Normalized via
    normalize_alias() so minor POS formatting drift ("Iced-Tea" vs
    "iced  tea") still resolves to the same product, case-insensitively so
    "BT SMASH" and "BT Smash" do too.

    No create-on-miss fallback (this used to be get_or_create_product):
    once Products is a curated, price-authoritative master catalog (see
    apply_master_pricing), silently auto-creating a product from a
    possibly-mistyped CSV cell would create a priceless, uncategorized
    ad-hoc entry - the right move now is to skip the row and report it
    (see attach_product_ids), not invent a product.

    Matching only against is_active=True is deliberate: a soft-deleted
    product shouldn't silently start accepting new transaction rows again
    just because a re-upload happens to reference it - see
    routes/products.create_product's explicit revive-on-re-add flow for
    the only sanctioned way to bring one back.
    """
    normalized_alias = normalize_alias(raw_name).lower()
    return Products.query.filter(
        Products.is_active.is_(True),
        func.lower(Products.product_alias) == normalized_alias,
    ).first()


def find_product_by_name_or_alias(name, alias, exclude_product_id=None):
    """Looks up an existing product - ACTIVE OR INACTIVE - matching the
    submitted name/alias, via the same normalize_alias()-based comparison
    used everywhere else, checked against both the stored product_name and
    product_alias (a manual Products-page entry may not always provide an
    alias, so name-to-name is a legitimate match path here too, unlike the
    stricter alias-only upload matching above). Used by
    routes/products.create_product's revive-on-re-add flow (to detect a
    name/alias collision with a soft-deleted row before creating a new one)
    and its duplicate-active-product guard, and by update_product (via
    exclude_product_id, so a product doesn't collide with itself when its
    own name/alias is left unchanged).

    A full Python-side scan (not a SQL filter) because the comparison needs
    normalize_alias() applied to the STORED value too (e.g. a stored
    "Iced-Tea" product_name must match a submitted "Iced Tea"), which a
    plain SQL func.lower() can't express - fine at this app's catalog scale
    (a single café's menu, not a large table).
    """
    candidate_keys = {normalize_alias(name).lower()}
    if alias:
        candidate_keys.add(normalize_alias(alias).lower())

    for product in Products.query.all():
        if exclude_product_id is not None and product.product_id == exclude_product_id:
            continue
        stored_keys = {normalize_alias(product.product_name).lower()}
        if product.product_alias:
            stored_keys.add(normalize_alias(product.product_alias).lower())
        if candidate_keys & stored_keys:
            return product
    return None


_MASTER_CATALOG_FILENAMES = ("master_catalog.xlsx", "master_catalog.csv")


def seed_master_catalog_if_empty():
    """On a from-scratch (Products-table-empty) database, bulk-populates
    Category/Products from a master catalog file, if one exists in
    config.MASTER_CATALOG_DIR. This is a bulk version of what
    POST /api/products already does per-row (same get_or_create_category +
    product-creation shape as routes/products.create_product), not a
    parallel path.

    Checking Products.query.count() == 0 (not Category) is deliberate -
    it's the one guard that keeps a populated database, including one
    that's had products edited since, from ever being touched by this on a
    later restart. A category with zero products isn't meaningfully
    "seeded" either way, so it isn't the signal to check.

    A missing directory or file is NOT an error - this is an optional
    from-scratch bootstrap, not a hard requirement to run the app. It's
    logged and skipped, same as a file that fails to parse.
    """
    if Products.query.count() != 0:
        return

    catalog_path = _find_master_catalog_file()
    if catalog_path is None:
        current_app.logger.info(
            "No master catalog file found in %s - skipping catalog seed.", MASTER_CATALOG_DIR
        )
        return

    try:
        dataframe = (
            pd.read_csv(catalog_path)
            if catalog_path.suffix.lower() == ".csv"
            else pd.read_excel(catalog_path, engine="openpyxl")
        )
    except Exception:
        current_app.logger.exception("Unable to read master catalog file %s.", catalog_path)
        return

    dataframe.columns = [str(column).strip() for column in dataframe.columns]
    required_columns = {"Product Name", "Category"}
    missing_columns = required_columns - set(dataframe.columns)
    if missing_columns:
        current_app.logger.error(
            "Master catalog file %s is missing required column(s): %s",
            catalog_path,
            ", ".join(sorted(missing_columns)),
        )
        return

    seeded_count = 0
    for _, row in dataframe.iterrows():
        name = str(row.get("Product Name") or "").strip()
        category_name = str(row.get("Category") or "").strip()
        if not name or not category_name or name.lower() == "nan" or category_name.lower() == "nan":
            continue

        raw_alias = row.get("Product Alias")
        raw_alias = str(raw_alias).strip() if pd.notna(raw_alias) else ""
        # Normalized (unlike routes/products.create_product's raw-stored
        # manual alias) because this alias is the master matching key
        # upload rows get resolved against (find_active_product_by_alias) -
        # it has to be in the same normalized form that lookup compares
        # with, regardless of how the catalog file happened to format it.
        # Falls back to the product name itself when the catalog row leaves
        # it blank, same as services/migrations._backfill_product_names_and_aliases
        # already does for pre-existing rows.
        stored_alias = normalize_alias(raw_alias) if raw_alias else normalize_alias(name)

        raw_price = row.get("Price")
        price = float(raw_price) if pd.notna(raw_price) else None

        category = get_or_create_category(category_name)
        product = Products(
            product_name=to_title_case(name),
            product_alias=stored_alias,
            category_id=category.category_id,
            price=price,
            is_active=True,
        )
        db.session.add(product)
        seeded_count += 1

    db.session.commit()
    current_app.logger.info("Seeded %d product(s) from master catalog %s.", seeded_count, catalog_path)


def _find_master_catalog_file():
    directory = Path(MASTER_CATALOG_DIR)
    for filename in _MASTER_CATALOG_FILENAMES:
        candidate = directory / filename
        if candidate.exists():
            return candidate
    return None
