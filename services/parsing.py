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

# used as a fallback when a product has no master price
OPTIONAL_COLUMNS = ["Price", "Total"]

COLUMN_RENAME_MAP = {
    "RECEIPTID": "Receipt ID",
    "RECEIPT_ID": "Receipt ID",
    "RECEIPT NO": "Receipt ID",
}
_COLUMN_RENAME_LOOKUP = {key.upper(): value for key, value in COLUMN_RENAME_MAP.items()}

CATEGORY_RENAME_MAP = {
    "Sandwich": "Burger & Sandwiches",
}
_CATEGORY_RENAME_LOOKUP = {key.upper(): value for key, value in CATEGORY_RENAME_MAP.items()}

# matched case-insensitively, "" covers blank categories
CATEGORY_DROP_LIST = ["", "0", "Add On", "Beverage"]
_CATEGORY_DROP_SET = {value.upper() for value in CATEGORY_DROP_LIST}

CUSTOM_AMOUNT_PRODUCT_NAME = "CUSTOM AMOUNT"

# per-file receipt numbering, the stored ids are rebuilt per day later
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

    dataframe.columns = [str(column).strip() for column in dataframe.columns]
    dataframe = dataframe.rename(
        columns={
            column: _COLUMN_RENAME_LOOKUP[column.upper()]
            for column in dataframe.columns
            if column.upper() in _COLUMN_RENAME_LOOKUP
        }
    )
    columns_by_lower_name = {column.casefold(): column for column in dataframe.columns}

    # no Date column: build one from Year/Month/Day. parsed as text since Month can be a name
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

    # missing required columns are reported at the end
    rename_map = {
        columns_by_lower_name[column.casefold()]: column
        for column in REQUIRED_COLUMNS
        if column.casefold() in columns_by_lower_name
    }
    for column in OPTIONAL_COLUMNS:
        if column.casefold() in columns_by_lower_name:
            rename_map[columns_by_lower_name[column.casefold()]] = column
    dataframe = dataframe.rename(columns=rename_map)

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

    # compare uppercased, keep the original casing
    if "Category" in dataframe.columns:
        category_upper = dataframe["Category"].str.upper()
        renamed = category_upper.map(_CATEGORY_RENAME_LOOKUP)
        dataframe["Category"] = renamed.where(renamed.notna(), dataframe["Category"])

        category_upper = dataframe["Category"].str.upper()
        dataframe = dataframe.loc[~category_upper.isin(_CATEGORY_DROP_SET)].copy()

    if "Product Name" in dataframe.columns:
        product_upper = dataframe["Product Name"].str.upper()
        dataframe = dataframe.loc[product_upper.ne(CUSTOM_AMOUNT_PRODUCT_NAME)].copy()

    # a blank or bad Timestamp becomes NaT, the sale is kept
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

    if "Receipt ID" in dataframe.columns:
        dataframe = dataframe.reset_index(drop=True)
        receipt_changed = dataframe["Receipt ID"].ne(dataframe["Receipt ID"].shift())
        dataframe["Receipt ID"] = (
            receipt_changed.cumsum() - 1 + STARTING_RECEIPT_ID
        ).astype(int)

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
