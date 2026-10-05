import pandas as pd

from models import Category, Products, RawTransaction, RuleItems, Rules, db
from services.mining import RANKING_METRICS, rank_rules
from services.numbers import json_number


def build_full_transactions_dataframe():
    """All RawTransaction rows joined to Products, shaped for
    services/mining.py: one "Receipt ID" (globally-unique, composed from
    year/month/day/receipt_id since receipt_id itself only resets daily)
    and "Product Name" column. Also returns a product_name -> product_id
    map, used to persist RuleItems.
    """
    rows = (
        db.session.query(
            RawTransaction.year,
            RawTransaction.month,
            RawTransaction.day,
            RawTransaction.receipt_id,
            Products.product_name,
        )
        .join(Products, Products.product_id == RawTransaction.product_id)
        .all()
    )
    dataframe = pd.DataFrame(rows, columns=["Year", "Month", "Day", "ReceiptId", "Product Name"])
    if not dataframe.empty:
        dataframe["Receipt ID"] = (
            dataframe["Year"].astype(str)
            + "-"
            + dataframe["Month"].astype(str)
            + "-"
            + dataframe["Day"].astype(str)
            + "-"
            + dataframe["ReceiptId"].astype(str)
        )

    product_id_by_name = {product.product_name: product.product_id for product in Products.query.all()}
    return dataframe, product_id_by_name


def count_receipts():
    """Number of distinct receipts - the same figure as
    build_full_transactions_dataframe()["Receipt ID"].nunique(), counted in
    SQL rather than by loading every row.
    """
    return (
        db.session.query(
            RawTransaction.year,
            RawTransaction.month,
            RawTransaction.day,
            RawTransaction.receipt_id,
        )
        .join(Products, Products.product_id == RawTransaction.product_id)
        .distinct()
        .count()
    )


def build_transactions_dataframe(start_date=None, end_date=None, categories=None, products=None):
    """RawTransaction joined to Products/Category, shaped to match the old
    in-memory contract that services/aggregation.py expects: Receipt ID,
    Date, Product Name, Category, Quantity, Price, Total, and (when present)
    Timestamp - aggregation.py's hour-of-day chart already treats Timestamp
    as optional and falls back cleanly when every value is null.

    categories/products are pushed down to the join (same lookup
    routes/products.py's get_products() already does - both are lists,
    matching the dashboard's checkbox-based multi-select, and an empty/None
    list means no filter on that dimension); start_date/end_date are applied
    afterwards against the constructed "Date" column, since the requested
    range doesn't necessarily align to whole months.
    """
    query = (
        db.session.query(
            RawTransaction.receipt_id,
            RawTransaction.year,
            RawTransaction.month,
            RawTransaction.day,
            RawTransaction.timestamp,
            RawTransaction.quantity,
            RawTransaction.price,
            RawTransaction.total,
            Products.product_name,
            Category.category_name,
        )
        .join(Products, Products.product_id == RawTransaction.product_id)
        .join(Category, Category.category_id == Products.category_id)
    )
    if categories:
        query = query.filter(Category.category_name.in_(categories))
    if products:
        query = query.filter(Products.product_name.in_(products))

    rows = query.all()
    dataframe = pd.DataFrame(
        rows,
        columns=[
            "ReceiptId",
            "Year",
            "Month",
            "Day",
            "Timestamp",
            "Quantity",
            "Price",
            "Total",
            "Product Name",
            "Category",
        ],
    )
    if dataframe.empty:
        return dataframe

    dataframe["Receipt ID"] = (
        dataframe["Year"].astype(str)
        + "-"
        + dataframe["Month"].astype(str)
        + "-"
        + dataframe["Day"].astype(str)
        + "-"
        + dataframe["ReceiptId"].astype(str)
    )
    dataframe["Date"] = pd.to_datetime(
        dict(year=dataframe["Year"], month=dataframe["Month"], day=dataframe["Day"])
    )
    dataframe["Timestamp"] = pd.to_datetime(dataframe["Timestamp"])
    for column in ["Quantity", "Price", "Total"]:
        dataframe[column] = dataframe[column].astype(float)

    if start_date not in (None, ""):
        dataframe = dataframe[dataframe["Date"] >= pd.to_datetime(start_date)]
    if end_date not in (None, ""):
        dataframe = dataframe[dataframe["Date"] <= pd.to_datetime(end_date)]

    return dataframe


def build_analytics_browse_payload(transaction_count):
    """Builds the category -> antecedent-product -> rule-row structure the
    /analytics page's three-level drill-down (landing -> category ->
    product) renders directly from, computed from the persisted
    Rules/RuleItems tables (mining only happens on upload - see
    remine_rules above).

    A multi-item-antecedent rule is attributed to EVERY product in its
    antecedent set, each getting its own row filed under its own
    category/product - not just a special case, this falls straight out of
    looping over each rule's antecedent product ids below. That's also what
    keeps a product's Level 2 "N generated rule(s)" count and its Level 3 row
    count guaranteed equal: both come from the same rows list built here (one
    row per (antecedent product, rule) pair - never more than one per pair,
    since a rule's antecedent is a set and a product can't appear in it
    twice), so there's no separate counting logic that could drift out of
    sync with what's actually rendered.

    Open question ("show empty categories?"): resolved automatically by
    construction rather than by a filter - a category only appears here at
    all if one of its products is some rule's antecedent, since that's the
    only way a product enters this structure.
    """
    rules = Rules.query.all()
    if not rules:
        return {"rulesGenerated": 0, "transactions": transaction_count, "categories": []}

    items_by_rule = {}
    for item in RuleItems.query.all():
        items_by_rule.setdefault(item.rule_id, {"antecedent": [], "consequent": []})
        items_by_rule[item.rule_id][item.side].append(item.product_id)

    products = {product.product_id: product for product in Products.query.all()}
    category_names = {category.category_id: category.category_name for category in Category.query.all()}

    # category_name -> product_name -> {"ruleIds": set(), "rows": [...]}
    tree = {}

    for rule in rules:
        items = items_by_rule.get(rule.rule_id, {"antecedent": [], "consequent": []})
        antecedent_ids = items["antecedent"]
        consequent_names = sorted(products[pid].product_name for pid in items["consequent"])
        confidence_percent = round(rule.confidence * 100)
        antecedent_names_by_id = {pid: products[pid].product_name for pid in antecedent_ids}

        for product_id in antecedent_ids:
            product = products[product_id]
            category_name = category_names.get(product.category_id) or "Uncategorized"
            other_antecedents = sorted(
                name for other_id, name in antecedent_names_by_id.items() if other_id != product_id
            )

            product_bucket = tree.setdefault(category_name, {}).setdefault(
                product.product_name, {"ruleIds": set(), "rows": []}
            )
            product_bucket["ruleIds"].add(rule.rule_id)
            product_bucket["rows"].append(
                {
                    "otherAntecedents": other_antecedents,
                    "consequents": consequent_names,
                    "confidencePercent": confidence_percent,
                    "isApproximate": bool(rule.is_approximate),
                }
            )

    categories_payload = []
    for category_name, products_in_category in tree.items():
        products_payload = sorted(
            (
                {"product": product_name, "ruleCount": len(bucket["ruleIds"]), "rows": bucket["rows"]}
                for product_name, bucket in products_in_category.items()
            ),
            key=lambda entry: entry["product"].lower(),
        )
        categories_payload.append({"category": category_name, "products": products_payload})

    categories_payload.sort(key=lambda entry: entry["category"].lower())

    return {
        "rulesGenerated": len(rules),
        "transactions": transaction_count,
        "categories": categories_payload,
    }


def build_rule_bundles_payload():
    """Flat "Product Bundles" table - one row per persisted rule, sourced
    from the Rules/RuleItems tables rather than re-running compute_rules()
    (mining only happens on upload - see remine_rules above, reads should
    never re-mine). Mirrors the shape services/mining.py's now-dead
    build_analytics_payload()/"bundles" used, just read from the DB.
    """
    rules = Rules.query.all()
    if not rules:
        return []

    products = {product.product_id: product.product_name for product in Products.query.all()}
    items_by_rule = {}
    for item in RuleItems.query.all():
        items_by_rule.setdefault(item.rule_id, {"antecedent": [], "consequent": []})
        items_by_rule[item.rule_id][item.side].append(item.product_id)

    bundles = []
    for rule in rules:
        items = items_by_rule.get(rule.rule_id, {"antecedent": [], "consequent": []})
        antecedent_names = sorted(products[pid] for pid in items["antecedent"])
        consequent_names = sorted(products[pid] for pid in items["consequent"])
        bundles.append(
            {
                "products": f"{', '.join(antecedent_names)} → {', '.join(consequent_names)}",
                # Raw floats (conviction may be inf) - rank_rules scores and
                # tie-breaks on these before they're made JSON-safe below.
                "support": float(rule.support),
                "confidence": float(rule.confidence),
                "lift": float(rule.lift),
                "leverage": float(rule.leverage),
                "conviction": float(rule.conviction),
                "isApproximate": bool(rule.is_approximate),
            }
        )

    rank_rules(bundles)
    for bundle in bundles:
        for metric in RANKING_METRICS:
            bundle[metric] = json_number(bundle[metric], whole_as_int=False)
    return bundles
