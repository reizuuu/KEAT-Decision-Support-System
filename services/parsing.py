import datetime as dt
from pathlib import Path

import pandas as pd


REQUIRED_COLUMNS = [
    "Receipt ID",
    "Date",
    "Product Name",
    "Category",
    "Quantity",
    "Timestamp",
]

# Price/Total are no longer required at upload time - a fully-priced catalog
# (every product's Products.price set) makes a file's own Price/Total columns
# vestigial (see services/persistence.apply_master_pricing), so a file may
# omit them entirely. When present, they're still read/cleaned like any other
# column below; when a row's price can't be resolved from either source, it's
# skipped and reported rather than persisted with a guessed value.
OPTIONAL_COLUMNS = ["Price", "Total"]

# Column-name variants seen in uploaded files, mapped to their canonical
# REQUIRED_COLUMNS name. Matched case-insensitively against the uploaded
# file's (stripped) column names, before the missing-columns check runs.
COLUMN_RENAME_MAP = {
    "RECEIPTID": "Receipt ID",
    "RECEIPT_ID": "Receipt ID",
    "RECEIPT NO": "Receipt ID",
}
_COLUMN_RENAME_LOOKUP = {key.upper(): value for key, value in COLUMN_RENAME_MAP.items()}

# Category values renamed to their canonical display form before filtering.
CATEGORY_RENAME_MAP = {
    "Sandwich": "Burger & Sandwiches",
}
_CATEGORY_RENAME_LOOKUP = {key.upper(): value for key, value in CATEGORY_RENAME_MAP.items()}

# Category values dropped outright (matched case-insensitively). "" also
# covers the blank/NaN-equivalent case, since null categories are normalized
# to "" earlier in cleaning.
CATEGORY_DROP_LIST = ["", "0", "Add On", "Beverage"]
_CATEGORY_DROP_SET = {value.upper() for value in CATEGORY_DROP_LIST}

CUSTOM_AMOUNT_PRODUCT_NAME = "CUSTOM AMOUNT"

# Receipt IDs are renumbered to clean sequential ints starting here, per
# file. This is only an intermediate grouping key: routes/upload.py takes it
# from here and rebuilds the persisted true_receipt_id, scoped per calendar
# day and continued from whatever's already stored for that day (see
# services/persistence.compute_true_receipt_ids), so restarting at 1 here on
# every file is fine.
STARTING_RECEIPT_ID = 1


def read_and_clean_upload(file_storage):
    extension = Path(file_storage.filename or "").suffix.lower()
    if extension not in {".csv", ".xlsx"}:
        raise ValueError("Only .csv and .xlsx files are supported.")

    try:
        dataframe = (
            pd.read_csv(file_storage)
            if extension == ".csv"
            else pd.read_excel(file_storage, engine="openpyxl")
        )
    except Exception as exc:
        raise ValueError(f"Unable to read the uploaded file: {exc}") from exc

    original_row_count = len(dataframe)

    # --- Column/rename normalization -------------------------------------
    dataframe.columns = [str(column).strip() for column in dataframe.columns]
    dataframe = dataframe.rename(
        columns={
            column: _COLUMN_RENAME_LOOKUP[column.upper()]
            for column in dataframe.columns
            if column.upper() in _COLUMN_RENAME_LOOKUP
        }
    )
    columns_by_lower_name = {column.casefold(): column for column in dataframe.columns}

    # --- Date fallback (Year/Month/Day -> Date) ---------------------------
    # Built by parsing "<year>-<month>-<day>" as free-form text rather than
    # coercing each part to a number, since Month may be a name ("June")
    # rather than a numeral - pd.to_numeric("June") silently yields NaN,
    # which previously turned Date into NaT for every row.
    if "date" not in columns_by_lower_name:
        year_col = columns_by_lower_name.get("year")
        month_col = columns_by_lower_name.get("month")
        day_col = columns_by_lower_name.get("day")
        if year_col is not None and month_col is not None and day_col is not None:
            date_strings = (
                dataframe[year_col].astype(str).str.strip()
                + "-"
                + dataframe[month_col].astype(str).str.strip()
                + "-"
                + dataframe[day_col].astype(str).str.strip()
            )
            dataframe["Date"] = pd.to_datetime(date_strings, errors="coerce")
            columns_by_lower_name["date"] = "Date"

    # Only rename columns we actually recognize - a still-missing required
    # column is left absent and caught by the required-columns check below,
    # once the rest of preprocessing has had a chance to run.
    rename_map = {
        columns_by_lower_name[column.casefold()]: column
        for column in REQUIRED_COLUMNS
        if column.casefold() in columns_by_lower_name
    }
    for column in OPTIONAL_COLUMNS:
        if column.casefold() in columns_by_lower_name:
            rename_map[columns_by_lower_name[column.casefold()]] = column
    dataframe = dataframe.rename(columns=rename_map)

    # --- Dtype coercion (skipped for columns the file doesn't have) ---------
    if "Date" in dataframe.columns:
        dataframe["Date"] = pd.to_datetime(dataframe["Date"], errors="coerce")
    if "Timestamp" in dataframe.columns:
        dataframe["Timestamp"] = pd.to_datetime(
            dataframe["Timestamp"].map(_parse_timestamp_value)
        )
    for column in ["Quantity", "Price", "Total"]:
        if column in dataframe.columns:
            dataframe[column] = pd.to_numeric(dataframe[column], errors="coerce")

    for column in ["Receipt ID", "Product Name", "Category"]:
        if column in dataframe.columns:
            dataframe[column] = _clean_str_column(dataframe[column])

    # --- Category taxonomy cleanup + CUSTOM AMOUNT drop ----------------------
    # Comparisons are done against an uppercased copy so stored/displayed
    # values keep their original casing, except where CATEGORY_RENAME_MAP
    # explicitly rewrites a value to its canonical display form.
    if "Category" in dataframe.columns:
        category_upper = dataframe["Category"].str.upper()
        renamed = category_upper.map(_CATEGORY_RENAME_LOOKUP)
        dataframe["Category"] = renamed.where(renamed.notna(), dataframe["Category"])

        category_upper = dataframe["Category"].str.upper()
        dataframe = dataframe.loc[~category_upper.isin(_CATEGORY_DROP_SET)].copy()

    if "Product Name" in dataframe.columns:
        product_upper = dataframe["Product Name"].str.upper()
        dataframe = dataframe.loc[product_upper.ne(CUSTOM_AMOUNT_PRODUCT_NAME)].copy()

    # --- Null / empty-string filtering (only over columns present) ----------
    # Timestamp is excluded from this row-level check even though it's a
    # required COLUMN now (a file missing the Timestamp column entirely is
    # rejected below, by the required-columns check) - a per-row blank or
    # unparseable Timestamp value still just becomes NaT rather than
    # silently dropping an otherwise-valid sale, same as before Timestamp
    # became required. Row-level drops here would understate transaction
    # counts/revenue, which is exactly the kind of drift this app needs to
    # avoid.
    present_required_columns = [
        column for column in REQUIRED_COLUMNS if column in dataframe.columns and column != "Timestamp"
    ]
    valid_rows = dataframe[present_required_columns].notna().all(axis=1)
    dataframe = dataframe.loc[valid_rows].copy()

    present_string_columns = [
        column
        for column in ["Receipt ID", "Product Name", "Category"]
        if column in dataframe.columns
    ]
    if present_string_columns:
        non_empty_rows = pd.Series(True, index=dataframe.index)
        for column in present_string_columns:
            non_empty_rows &= dataframe[column].ne("")
        dataframe = dataframe.loc[non_empty_rows].copy()

    # --- Receipt ID renumbering (on the final cleaned row set only) ---------
    if "Receipt ID" in dataframe.columns:
        dataframe = dataframe.reset_index(drop=True)
        receipt_changed = dataframe["Receipt ID"].ne(dataframe["Receipt ID"].shift())
        dataframe["Receipt ID"] = (
            receipt_changed.cumsum() - 1 + STARTING_RECEIPT_ID
        ).astype(int)

    # --- Required-columns check (after preprocessing has run) ---------------
    missing = [column for column in REQUIRED_COLUMNS if column not in dataframe.columns]
    if missing:
        raise MissingColumnsError(missing)

    return dataframe, original_row_count - len(dataframe)


def _clean_str_column(series):
    return series.where(series.notna(), "").astype(str).str.strip()


def _parse_timestamp_value(value):
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return pd.NaT
    if isinstance(value, dt.datetime):
        return value
    if isinstance(value, dt.time):
        return dt.datetime.combine(dt.date(1900, 1, 1), value)
    if isinstance(value, (int, float)):
        try:
            return dt.datetime(1900, 1, 1) + dt.timedelta(seconds=round(value * 86400))
        except (OverflowError, ValueError):
            return pd.NaT
    parsed = pd.to_datetime(str(value), format="mixed", errors="coerce")
    return parsed if pd.notna(parsed) else pd.NaT


class MissingColumnsError(ValueError):
    def __init__(self, columns):
        self.columns = columns
        super().__init__(f"Missing required columns: {', '.join(columns)}")
