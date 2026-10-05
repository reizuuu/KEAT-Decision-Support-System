from decimal import Decimal
import math
from pathlib import Path
import threading

import pandas as pd
from flask import current_app
from sqlalchemy import func, tuple_

from config import MASTER_CATALOG_DIR
from models import Category, Products, RawTransaction, RuleItems, Rules, TransactionStatistics, db
from services.mining import RANKING_METRICS, compute_rules, rank_rules
from services.text import normalize_alias, to_title_case


# ---------------------------------------------------------------------------
# Upload pipeline helpers
# ---------------------------------------------------------------------------


def compute_true_receipt_ids(dataframe):
    """Builds RawTransaction.receipt_id ("true_receipt_id"): contiguous
    groups of the cleaned per-file "Receipt ID" column, scoped per
    (Year, Month, Day) and restarting at 1 for each day - matching how a
    till's own receipt counter resets daily.

    Restarting at 1 per day (instead of continuing from whatever's already
    stored for that day) is a deliberate choice: it's what makes the id
    reproducible across uploads. Re-uploading the same day's data yields the
    same true_receipt_id sequence, which is what drop_existing_rows() relies
    on to recognize the overlap - continuing from the stored max would give
    re-uploaded receipts fresh ids every time and dedup would never trigger.

    The tradeoff, called out here since the schema has no column for the
    original per-file receipt id to fall back on: if two separate uploads
    each contribute genuinely different NEW receipts for the same day,
    their local sequences can collide on the same true_receipt_id, merging
    them into one "basket" for mining/statistics purposes.
    """
    dataframe = dataframe.reset_index(drop=True)
    dataframe["true_receipt_id"] = 0
    for _, group in dataframe.groupby(["Year", "Month", "Day"], sort=False):
        changed = group["Receipt ID"].ne(group["Receipt ID"].shift())
        dataframe.loc[group.index, "true_receipt_id"] = changed.cumsum()
    dataframe["true_receipt_id"] = dataframe["true_receipt_id"].astype(int)
    return dataframe


def drop_existing_rows(dataframe):
    """Row-level dedup keyed on (receipt_id, product_name, day, month, year),
    compared against already-stored RawTransaction rows. Must run after
    compute_true_receipt_ids(), since RawTransaction.receipt_id stores the
    grouped true_receipt_id rather than the raw per-file receipt id.
    """
    if dataframe.empty:
        return dataframe, 0

    day_combos = list(
        dataframe[["Year", "Month", "Day"]]
        .drop_duplicates()
        .itertuples(index=False, name=None)
    )
    existing_keys = set()
    if day_combos:
        rows = (
            db.session.query(
                RawTransaction.receipt_id,
                # Compared against the raw CSV "Product Name" values below,
                # so this must be product_alias (the preserved raw POS text)
                # rather than product_name, which is Title-Case and editable.
                # Lowercased for the same case-insensitive comparison
                # find_active_product_by_alias() uses, so e.g. a re-upload
                # spelling a product "ICED TEA" against a stored "Iced Tea"
                # alias still registers as the same row instead of a false
                # new one.
                func.lower(Products.product_alias),
                RawTransaction.day,
                RawTransaction.month,
                RawTransaction.year,
            )
            .join(Products, Products.product_id == RawTransaction.product_id)
            .filter(tuple_(RawTransaction.year, RawTransaction.month, RawTransaction.day).in_(day_combos))
            .all()
        )
        existing_keys = set(rows)

    def is_duplicate(row):
        return (
            row["true_receipt_id"],
            # Normalized/lowercased the same way find_active_product_by_alias()
            # matches (see services/text.normalize_alias) - existing_keys
            # carries the stored alias, already normalized and lowercased
            # above.
            normalize_alias(row["Product Name"]).lower(),
            row["Day"],
            row["Month"],
            row["Year"],
        ) in existing_keys

    mask = dataframe.apply(is_duplicate, axis=1)
    duplicate_count = int(mask.sum())
    return dataframe.loc[~mask].copy(), duplicate_count


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


def attach_product_ids(dataframe):
    """Resolves each row's ProductId/CategoryId via lookup-only matching
    against ACTIVE products (find_active_product_by_alias) - no
    get-or-create fallback anymore now that Products is a curated,
    price-authoritative master catalog. A matched row's CategoryId comes
    from the matched Products row's OWN category, not the upload's raw
    "Category" column - once a product is in the catalog, the catalog's
    category is authoritative, the same way apply_master_pricing makes the
    catalog's price authoritative.

    get_or_create_category() is deliberately not called here anymore -
    there's nothing left to get-or-create a category FOR, since an
    unmatched row's raw category name is never used to catalog anything.
    (It stays in this module because routes/products.py's own add/edit
    flow still uses it.)

    Returns (matched_dataframe, unmatched_product_names): the second is the
    sorted, deduplicated list of raw "Product Name" values that didn't
    match any active product - routes/upload.py reports these to the
    caller instead of silently dropping them.
    """
    distinct_names = dataframe["Product Name"].unique()
    products_by_key = {}
    for raw_name in distinct_names:
        key = normalize_alias(raw_name).lower()
        if key not in products_by_key:
            products_by_key[key] = find_active_product_by_alias(raw_name)

    product_ids = []
    category_ids = []
    matched_mask = []
    unmatched_names = set()
    for _, row in dataframe.iterrows():
        product = products_by_key.get(normalize_alias(row["Product Name"]).lower())
        if product is None:
            matched_mask.append(False)
            unmatched_names.add(row["Product Name"])
            product_ids.append(None)
            category_ids.append(None)
        else:
            matched_mask.append(True)
            product_ids.append(product.product_id)
            category_ids.append(product.category_id)

    dataframe = dataframe.copy()
    dataframe["ProductId"] = product_ids
    dataframe["CategoryId"] = category_ids
    matched_dataframe = dataframe.loc[matched_mask].copy()
    return matched_dataframe, sorted(unmatched_names)


def apply_master_pricing(dataframe):
    """Overwrites each (already-matched) row's Price/Total with the
    matched product's CURRENT Products.price - the "Current Master Price"
    - captured once at the moment of ingestion and permanently locked into
    RawTransaction from then on. A later price edit on the Products page
    must never retroactively change historical RawTransaction/
    TransactionStatistics rows; this is enforced simply by construction -
    nothing re-touches an already-inserted row's price, ever, so there's no
    "recompute historical rows from current price" path to accidentally
    introduce here or anywhere else.

    Decision (documented per spec, not guessed silently): the master price
    is ALWAYS authoritative once a product has one set, overriding whatever
    the uploaded file's own Price/Total columns said - "Current Master
    Price active at the exact moment of ingestion" is what "master" means
    here. The file's own Price/Total are vestigial for a fully-priced
    catalog, which is exactly why they're optional upload columns (see
    services/parsing.OPTIONAL_COLUMNS) rather than required ones.

    FALLBACK: a product whose Products.price is still NULL (never priced -
    e.g. seeded without one, or created before this feature existed) keeps
    the row's own CSV price instead of the row being rejected - the least
    disruptive default, consistent with how GET /api/products already
    falls back to a sales-average display price for the same case.

    Price/Total are optional upload columns (see services/parsing.
    OPTIONAL_COLUMNS) - a file that omits them entirely leaves dataframe
    with no "Price" column at all, so the fallback above reads via
    row.get("Price") (None when the column is absent) rather than
    row["Price"], which would raise KeyError. A row that ends up with
    NO resolvable price (no master price AND no usable file price) is
    dropped here and its product name reported back, the same "skip and
    report rather than silently guess" treatment already given to
    catalog-unmatched rows (see attach_product_ids) - writing a None/NaN
    price into RawTransaction would be a silent data-integrity problem.

    Returns (priced_dataframe, unpriced_product_names).
    """
    product_ids = [int(product_id) for product_id in dataframe["ProductId"].unique()]
    master_prices = dict(
        db.session.query(Products.product_id, Products.price)
        .filter(Products.product_id.in_(product_ids))
        .all()
    )

    def resolve_price(row):
        master_price = master_prices.get(row["ProductId"])
        if master_price is not None:
            return float(master_price)
        return row.get("Price")

    dataframe = dataframe.copy()
    dataframe["Price"] = dataframe.apply(resolve_price, axis=1)

    unpriced_mask = dataframe["Price"].isna()
    unpriced_product_names = sorted(dataframe.loc[unpriced_mask, "Product Name"].unique().tolist())
    dataframe = dataframe.loc[~unpriced_mask].copy()

    dataframe["Total"] = dataframe["Price"] * dataframe["Quantity"]
    return dataframe, unpriced_product_names


def upsert_transaction_statistics(dataframe):
    # Ambiguity call: an upload's deltas are ADDED to any existing
    # (category, day) row rather than replacing it. Row-level dedup has
    # already removed rows already reflected in prior uploads, so the
    # remaining rows are strictly new activity - adding keeps cumulative
    # totals correct without needing to recompute the day from scratch.
    grouped = dataframe.groupby(["CategoryId", "Year", "Month", "Day"])
    for (category_id, year, month, day), group in grouped:
        customers = int(group["true_receipt_id"].nunique())
        revenue = Decimal(str(group["Total"].sum()))

        stat = TransactionStatistics.query.filter_by(
            category_id=int(category_id), year=int(year), month=int(month), day=int(day)
        ).first()
        if stat is None:
            stat = TransactionStatistics(
                category_id=int(category_id),
                year=int(year),
                month=int(month),
                day=int(day),
                total_customers=0,
                total_revenue=Decimal("0"),
            )
            db.session.add(stat)

        stat.total_customers = int(stat.total_customers or 0) + customers
        stat.total_revenue = Decimal(str(stat.total_revenue or 0)) + revenue


def insert_raw_transactions(dataframe, upload_id):
    has_timestamp = "Timestamp" in dataframe.columns
    records = [
        RawTransaction(
            upload_id=upload_id,
            receipt_id=int(row["true_receipt_id"]),
            product_id=int(row["ProductId"]),
            month=int(row["Month"]),
            day=int(row["Day"]),
            year=int(row["Year"]),
            timestamp=(
                row["Timestamp"].to_pydatetime()
                if has_timestamp and pd.notna(row["Timestamp"])
                else None
            ),
            quantity=Decimal(str(row["Quantity"])),
            price=Decimal(str(row["Price"])),
            total=Decimal(str(row["Total"])),
        )
        for _, row in dataframe.iterrows()
    ]
    db.session.bulk_save_objects(records)


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


def replace_rules(rules_dataframe, product_id_by_name):
    """Clears Rules + RuleItems and inserts the freshly-mined set."""
    RuleItems.query.delete()
    Rules.query.delete()

    if rules_dataframe.empty:
        return 0

    rules_generated = 0
    for _, rule in rules_dataframe.iterrows():
        rule_row = Rules(
            support=float(rule["support"]),
            confidence=float(rule["confidence"]),
            lift=float(rule["lift"]),
            leverage=float(rule["leverage"]),
            conviction=float(rule["conviction"]),
        )
        db.session.add(rule_row)
        db.session.flush()

        for name in rule["antecedents"]:
            db.session.add(
                RuleItems(rule_id=rule_row.rule_id, product_id=product_id_by_name[name], side="antecedent")
            )
        for name in rule["consequents"]:
            db.session.add(
                RuleItems(rule_id=rule_row.rule_id, product_id=product_id_by_name[name], side="consequent")
            )
        rules_generated += 1

    return rules_generated


def remine_rules():
    """Re-mines association rules over the full accumulated dataset and
    replaces Rules/RuleItems, so recommendations reflect everything ingested
    so far - not just the file that was just uploaded.

    Deliberately asymmetric with the dashboard: a soft-deleted product's
    PAST transactions still count everywhere in dashboard totals
    (build_transactions_dataframe/build_full_transactions_dataframe never
    filter on is_active - see services/aggregation.py), but they're
    excluded from what gets fed into compute_rules() here, so a deleted
    product stops contributing to NEWLY mined association rules. This
    filter is applied at this call site rather than inside
    build_full_transactions_dataframe() itself, since that function is also
    used (unfiltered, on purpose) for the analytics transaction count.
    """
    dataframe, product_id_by_name = build_full_transactions_dataframe()
    if dataframe.empty:
        return replace_rules(pd.DataFrame(), product_id_by_name)

    active_product_names = {
        product.product_name for product in Products.query.filter_by(is_active=True).all()
    }
    mineable_dataframe = dataframe[dataframe["Product Name"].isin(active_product_names)]
    if mineable_dataframe.empty:
        return replace_rules(pd.DataFrame(), product_id_by_name)

    rules, _ = compute_rules(mineable_dataframe)
    return replace_rules(rules, product_id_by_name)


def _remine_rules_in_background(app):
    # A background thread can't reuse the request's app context/db.session -
    # Flask-SQLAlchemy's session is tied to the context it was created in.
    # Pushing a fresh app context here (from the real Flask app object, not
    # the `current_app` proxy) is what makes remine_rules()'s db.session
    # calls work safely off the request thread.
    with app.app_context():
        try:
            remine_rules()
            db.session.commit()
        except Exception:
            # No caller to propagate to - this runs unsupervised on a
            # daemon thread, well after the triggering request already
            # responded. Rolling back at least restores the last-known-good
            # state instead of leaving the session half-mutated.
            db.session.rollback()
            app.logger.exception("Background remine failed.")


def start_background_remine(app):
    """Kicks off a full re-mine on a daemon thread and returns immediately -
    used after any change that should regenerate association rules (a
    product added, soft-deleted, or a new dataset uploaded) without making
    the triggering request wait for mlxtend to finish. `app` must be the
    real Flask app object (current_app._get_current_object()), not the
    current_app proxy, since the background thread needs it to push its own
    app context.
    """
    threading.Thread(target=_remine_rules_in_background, args=(app,), daemon=True).start()


def prune_rules_for_product(product_id):
    """Synchronous, structural-only edit of the EXISTING Rules/RuleItems
    rows when a product is soft-deleted - NOT a re-mine (that's the
    caller's job, in the background - see routes/products.delete_product).
    Does not commit; the caller controls the transaction boundary.

    For every rule referencing product_id (via RuleItems):
      - it's the SOLE antecedent, or the SOLE consequent -> delete the
        whole rule (cascading its RuleItems) - there's no meaningful rule
        left without that side.
      - it's one of SEVERAL items on whichever side it's on -> delete just
        that one RuleItems row, leaving the rest of the set intact, and
        flag the rule is_approximate=True - its stored support/confidence/
        lift/leverage/conviction were computed for the original, now-
        changed itemset and are stale until the background remine
        recomputes them from scratch. Rules this function deletes outright
        are never flagged - they're just gone.
    """
    affected_rule_ids = {
        item.rule_id for item in RuleItems.query.filter_by(product_id=product_id).all()
    }

    for rule_id in affected_rule_ids:
        items = RuleItems.query.filter_by(rule_id=rule_id).all()
        antecedent_items = [item for item in items if item.side == "antecedent"]
        consequent_items = [item for item in items if item.side == "consequent"]

        is_sole_antecedent = len(antecedent_items) == 1 and antecedent_items[0].product_id == product_id
        is_sole_consequent = len(consequent_items) == 1 and consequent_items[0].product_id == product_id

        if is_sole_antecedent or is_sole_consequent:
            RuleItems.query.filter_by(rule_id=rule_id).delete()
            Rules.query.filter_by(rule_id=rule_id).delete()
            continue

        RuleItems.query.filter_by(rule_id=rule_id, product_id=product_id).delete()
        rule = db.session.get(Rules, rule_id)
        if rule is not None:
            rule.is_approximate = True


# ---------------------------------------------------------------------------
# Read-endpoint helpers
# ---------------------------------------------------------------------------


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
            bundle[metric] = _safe_number(bundle[metric])
    return bundles


def _safe_number(value):
    numeric_value = float(value)
    if math.isnan(numeric_value) or math.isinf(numeric_value):
        # e.g. conviction is infinite whenever a rule's confidence is
        # exactly 1.0 - Python's json module would otherwise emit the
        # non-standard "Infinity" token, which browsers reject.
        return None
    return numeric_value


# ---------------------------------------------------------------------------
# Startup catalog seeding
# ---------------------------------------------------------------------------


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
