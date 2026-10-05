from flask import Blueprint, current_app, jsonify, request
from sqlalchemy import func

from models import Category, Products, RawTransaction, db
from services.catalog import find_product_by_name_or_alias, get_or_create_category
from services.rules import prune_rules_for_product, start_background_remine
from services.text import to_title_case


products_bp = Blueprint("products_api", __name__)


@products_bp.get("/api/products")
def get_products():
    category_filters = [
        value.strip()
        for value in request.args.getlist("category")
        if value.strip() and value.strip().lower() != "all"
    ]

    query = (
        db.session.query(
            Products.product_id,
            Products.product_name,
            Products.product_alias,
            Products.price,
            Category.category_name,
            func.avg(RawTransaction.price),
        )
        .join(Category, Category.category_id == Products.category_id)
        .outerjoin(RawTransaction, RawTransaction.product_id == Products.product_id)
        .filter(Products.is_active.is_(True))
    )
    if category_filters:
        query = query.filter(Category.category_name.in_(category_filters))

    rows = (
        query.group_by(
            Products.product_id, Products.product_name, Products.product_alias, Products.price, Category.category_name
        )
        .order_by(func.lower(Products.product_name))
        .all()
    )
    products = [
        {
            "id": product_id,
            "name": product_name,
            "alias": product_alias,
            "category": category_name,
            # no master price -> average sold price -> 0
            "price": round(float(price if price is not None else (avg_price or 0)), 2),
        }
        for product_id, product_name, product_alias, price, category_name, avg_price in rows
    ]
    return jsonify({"products": products}), 200


@products_bp.get("/api/categories")
def get_categories():
    categories = Category.query.order_by(Category.category_name).all()
    return jsonify({"categories": [category.category_name for category in categories]}), 200


def _parse_price(raw_price):
    """Returns (price or None, error message or None). Blank means no price."""
    if raw_price in (None, ""):
        return None, None
    try:
        price = float(raw_price)
    except (TypeError, ValueError):
        return None, "price must be a number."
    if price < 0:
        return None, "price cannot be negative."
    return price, None


@products_bp.post("/api/products")
def create_product():
    data = request.get_json(silent=True) or {}
    name = (data.get("product_name") or "").strip()
    alias = (data.get("product_alias") or "").strip() or None
    category_name = (data.get("category") or "").strip()

    if not name or not category_name:
        return jsonify({"error": "product_name and category are required."}), 400

    price, error = _parse_price(data.get("price"))
    if error:
        return jsonify({"error": error}), 400

    existing = find_product_by_name_or_alias(name, alias)
    if existing is not None and existing.is_active:
        return jsonify({"error": "A product with this name or alias already exists."}), 400

    category = get_or_create_category(category_name)

    # re-adding a deleted product brings the old row back instead of making a duplicate
    if existing is not None and not existing.is_active:
        existing.is_active = True
        existing.product_name = to_title_case(name)
        existing.product_alias = alias
        existing.category_id = category.category_id
        existing.price = price
        db.session.commit()

        start_background_remine(current_app._get_current_object())

        return (
            jsonify(
                {
                    "id": existing.product_id,
                    "name": existing.product_name,
                    "alias": existing.product_alias,
                    "category": category.category_name,
                    "price": round(float(existing.price), 2) if existing.price is not None else 0,
                }
            ),
            200,
        )

    product = Products(
        product_name=to_title_case(name),
        product_alias=alias,
        category_id=category.category_id,
        price=price,
        is_active=True,
    )
    db.session.add(product)
    db.session.commit()

    start_background_remine(current_app._get_current_object())

    return (
        jsonify(
            {
                "id": product.product_id,
                "name": product.product_name,
                "alias": product.product_alias,
                "category": category.category_name,
                "price": round(float(product.price), 2) if product.price is not None else 0,
            }
        ),
        201,
    )


@products_bp.put("/api/products/<int:product_id>")
def update_product(product_id):
    product = db.session.get(Products, product_id)
    if product is None:
        return jsonify({"error": "Product not found."}), 404

    data = request.get_json(silent=True) or {}

    name = None
    if "product_name" in data:
        name = (data.get("product_name") or "").strip()
        if not name:
            return jsonify({"error": "product_name cannot be empty."}), 400

    alias_provided = "product_alias" in data
    alias = (data.get("product_alias") or "").strip() or None if alias_provided else None

    if "product_name" in data or alias_provided:
        candidate_name = name if "product_name" in data else product.product_name
        candidate_alias = alias if alias_provided else product.product_alias
        conflict = find_product_by_name_or_alias(candidate_name, candidate_alias, exclude_product_id=product_id)
        if conflict is not None and conflict.is_active:
            return jsonify({"error": "A product with this name or alias already exists."}), 400

    if "product_name" in data:
        product.product_name = to_title_case(name)

    if alias_provided:
        product.product_alias = alias

    if "category" in data:
        category_name = (data.get("category") or "").strip()
        if not category_name:
            return jsonify({"error": "category cannot be empty."}), 400
        category = get_or_create_category(category_name)
        product.category_id = category.category_id

    if "price" in data:
        price, error = _parse_price(data.get("price"))
        if error:
            return jsonify({"error": error}), 400
        product.price = price

    db.session.commit()

    category = db.session.get(Category, product.category_id)
    return jsonify(
        {
            "id": product.product_id,
            "name": product.product_name,
            "alias": product.product_alias,
            "category": category.category_name if category else None,
            "price": round(float(product.price), 2) if product.price is not None else 0,
        }
    ), 200


@products_bp.delete("/api/products/<int:product_id>")
def delete_product(product_id):
    product = db.session.get(Products, product_id)
    if product is None:
        return jsonify({"error": "Product not found."}), 404

    if not product.is_active:
        return jsonify({"id": product.product_id, "isActive": False}), 200

    # soft delete, past sales stay in the dashboard totals
    product.is_active = False

    # quick prune now, full remine in the background
    prune_rules_for_product(product.product_id)
    db.session.commit()

    start_background_remine(current_app._get_current_object())

    return jsonify({"id": product.product_id, "isActive": False}), 200
