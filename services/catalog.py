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
    """Upload matching: active products only, by normalized alias, case-insensitive."""
    normalized_alias = normalize_alias(raw_name).lower()
    return Products.query.filter(
        Products.is_active.is_(True),
        func.lower(Products.product_alias) == normalized_alias,
    ).first()


def find_product_by_name_or_alias(name, alias, exclude_product_id=None):
    """Any product, active or not, whose name or alias matches name or alias."""
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
    """Seeds categories and products from the master catalog file when there are no products yet."""
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
        # uploads match on the alias, so store it normalized. blank -> product name
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
