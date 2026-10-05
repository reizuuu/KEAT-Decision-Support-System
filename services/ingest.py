from decimal import Decimal

import pandas as pd
from sqlalchemy import func, tuple_

from models import Products, RawTransaction, TransactionStatistics, db
from services.catalog import find_active_product_by_alias
from services.text import normalize_alias


def compute_true_receipt_ids(dataframe):
    """Receipt ids restart at 1 each day so re-uploading the same day produces the same ids
    (dedup depends on that). Two different uploads for one day can collide and merge into one
    basket.
    """
    dataframe = dataframe.reset_index(drop=True)
    dataframe["true_receipt_id"] = 0
    for _, group in dataframe.groupby(["Year", "Month", "Day"], sort=False):
        changed = group["Receipt ID"].ne(group["Receipt ID"].shift())
        dataframe.loc[group.index, "true_receipt_id"] = changed.cumsum()
    dataframe["true_receipt_id"] = dataframe["true_receipt_id"].astype(int)
    return dataframe


def drop_existing_rows(dataframe):
    """Returns (rows not stored yet, number of duplicates)."""
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
                # alias, since rows are compared by their raw POS name
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
            normalize_alias(row["Product Name"]).lower(),
            row["Day"],
            row["Month"],
            row["Year"],
        ) in existing_keys

    mask = dataframe.apply(is_duplicate, axis=1)
    duplicate_count = int(mask.sum())
    return dataframe.loc[~mask].copy(), duplicate_count


def attach_product_ids(dataframe):
    """Matches rows to active products by alias. Returns (matched rows, unmatched names)."""
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
    """Price comes from the product's master price, or the file's price if it has none.
    Locked in at upload, later price edits don't touch stored rows.
    Returns (priced rows, unpriced names).
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
    # rows are already deduped, so add to the existing day totals
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
