from decimal import Decimal

import pandas as pd
from sqlalchemy import func, tuple_

from models import Products, RawTransaction, TransactionStatistics, db
from services.catalog import find_active_product_by_alias
from services.text import normalize_alias


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

    Returns (matched, unmatched_product_names): the second is the
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
    matched = dataframe.loc[matched_mask].copy()
    return matched, sorted(unmatched_names)


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
