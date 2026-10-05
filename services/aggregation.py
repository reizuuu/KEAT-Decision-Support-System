from services.numbers import json_number


def build_dashboard_payload(dataframe):
    months = dataframe["Date"].dt.to_period("M")
    month_values = sorted(months.unique())
    month_labels = [period.strftime("%b %Y") for period in month_values]

    monthly_orders = dataframe.groupby(months)["Receipt ID"].nunique()
    monthly_revenue = dataframe.groupby(months)["Total"].sum()
    product_totals = (
        dataframe.groupby("Product Name")["Quantity"]
        .sum()
        .sort_values(ascending=False)
        .head(10)
    )
    category_month_totals = dataframe.groupby([months, "Category"])["Quantity"].sum()
    product_month_totals = dataframe.groupby([months, "Product Name"])["Quantity"].sum()
    categories = sorted(dataframe["Category"].unique())
    top_products = product_totals.index.tolist()

    category_revenue = (
        dataframe.groupby("Category")["Total"]
        .sum()
        .sort_values(ascending=False)
    )

    receipts = dataframe.drop_duplicates(subset="Receipt ID")
    day_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    day_of_week = receipts["Date"].dt.dayofweek
    day_counts = receipts.groupby(day_of_week)["Receipt ID"].nunique()

    if "Timestamp" in dataframe.columns and dataframe["Timestamp"].notna().any():
        hour_source = dataframe["Timestamp"].dt.hour
        has_time_data = True
    else:
        hour_source = dataframe["Date"].dt.hour
        has_time_data = bool((hour_source != 0).any())
    hour_of_day = hour_source.loc[receipts.index]
    hour_counts = receipts.groupby(hour_of_day)["Receipt ID"].nunique()

    transaction_volume = {
        "labels": month_labels,
        "datasets": [
            {
                "label": category,
                "data": [
                    json_number(category_month_totals.get((period, category), 0))
                    for period in month_values
                ],
            }
            for category in categories
        ],
    }

    top_products_monthly = {
        "labels": month_labels,
        "datasets": [
            {
                "label": product,
                "data": [
                    json_number(product_month_totals.get((period, product), 0))
                    for period in month_values
                ],
            }
            for product in top_products
        ],
    }

    total_transactions = int(dataframe["Receipt ID"].nunique())
    # "Average Number of Products per Transaction" = total quantity sold /
    # total transactions, over whatever `dataframe` already is - same as
    # every other stat/chart here, filtering (including the product
    # checkbox filter) happens once, upstream, in
    # build_transactions_dataframe(). A product filter restricts rows to
    # just the checked product(s) (consistent with how the category filter
    # works), so this becomes "average quantity of the checked product(s)
    # per transaction they appear in" - still a real, meaningful number,
    # not hidden/disabled in that case.
    average_products_per_transaction = (
        json_number(dataframe["Quantity"].sum() / total_transactions) if total_transactions else 0
    )
    # Currency counterpart of the above: total revenue / total transactions,
    # over the same already-filtered dataframe - same division-by-zero guard.
    average_sales_per_transaction = (
        json_number(dataframe["Total"].sum() / total_transactions) if total_transactions else 0
    )

    return {
        "totalRevenue": json_number(dataframe["Total"].sum()),
        "totalTransactions": total_transactions,
        "averageProductsPerTransaction": average_products_per_transaction,
        "averageSalesPerTransaction": average_sales_per_transaction,
        "orderSummary": {
            "labels": month_labels,
            "data": [int(monthly_orders.get(period, 0)) for period in month_values],
        },
        "bestSelling": {
            "labels": product_totals.index.tolist(),
            "data": [json_number(value) for value in product_totals.tolist()],
        },
        "transactionVolume": transaction_volume,
        "revenueByCategory": {
            "labels": category_revenue.index.tolist(),
            "data": [json_number(value) for value in category_revenue.tolist()],
        },
        "monthlySalesTrend": {
            "labels": month_labels,
            "data": [json_number(monthly_revenue.get(period, 0)) for period in month_values],
        },
        "topProductsMonthly": top_products_monthly,
        "transactionsByDayOfWeek": {
            "labels": day_names,
            "data": [int(day_counts.get(index, 0)) for index in range(7)],
        },
        "transactionsByHour": {
            "labels": [f"{hour:02d}:00" for hour in range(24)],
            "data": [int(hour_counts.get(hour, 0)) for hour in range(24)],
            "hasTimeData": has_time_data,
        },
    }

