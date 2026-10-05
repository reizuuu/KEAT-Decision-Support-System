import inspect
import math

import pandas as pd
from mlxtend.frequent_patterns import association_rules, fpgrowth
from mlxtend.preprocessing import TransactionEncoder

from config import MIN_CONVICTION, MIN_LEVERAGE, MIN_LIFT, MIN_SUPPORT

# some mlxtend versions require num_itemsets, others reject it
_ASSOCIATION_RULES_PARAMS = inspect.signature(association_rules).parameters


def compute_rules(dataframe):
    """Mines rules from (Receipt ID, Product Name) rows. Returns (rules, transaction count)."""
    transactions = (
        dataframe.groupby("Receipt ID")["Product Name"]
        .apply(lambda products: sorted(set(products)))
        .tolist()
    )
    # single-item baskets stay in, they still count toward support
    if not transactions:
        return pd.DataFrame(), 0

    encoder = TransactionEncoder()
    encoded = encoder.fit(transactions).transform(transactions)
    encoded_df = pd.DataFrame(encoded, columns=encoder.columns_)
    itemsets = fpgrowth(
        encoded_df,
        min_support=MIN_SUPPORT,
        use_colnames=True,
    )
    if itemsets.empty:
        return pd.DataFrame(), len(transactions)

    rules_kwargs = {"metric": "lift", "min_threshold": MIN_LIFT}
    if "num_itemsets" in _ASSOCIATION_RULES_PARAMS:
        rules_kwargs["num_itemsets"] = len(transactions)
    rules = association_rules(itemsets, **rules_kwargs)
    actionable_rules = rules[(rules["leverage"] >= MIN_LEVERAGE) & (rules["conviction"] >= MIN_CONVICTION)]
    return actionable_rules, len(transactions)


RANKING_METRICS = ("support", "confidence", "lift", "leverage", "conviction")
RANKING_WEIGHT = 0.20
TIE_BREAKER_METRICS = ("leverage", "lift", "conviction", "support", "confidence")


def rank_rules(rules):
    """Min-max scales each metric, sums them with equal weights into rule["score"], then sorts
    and sets rule["rank"]. Exact ties fall back to TIE_BREAKER_METRICS.
    """
    if not rules:
        return rules

    normalized = {}
    for metric in RANKING_METRICS:
        values = [float(rule[metric]) for rule in rules]
        if metric == "conviction":
            # conviction is inf when confidence is 1, cap it at the largest finite value
            finite_values = [value for value in values if math.isfinite(value)]
            cap = max(finite_values) if finite_values else 0.0
            values = [value if math.isfinite(value) else cap for value in values]

        low, high = min(values), max(values)
        if low == high:
            normalized[metric] = [0.0] * len(values)
        else:
            span = high - low
            normalized[metric] = [(value - low) / span for value in values]

    for index, rule in enumerate(rules):
        rule["score"] = sum(RANKING_WEIGHT * normalized[metric][index] for metric in RANKING_METRICS)

    rules.sort(
        key=lambda rule: (rule["score"], *(float(rule[metric]) for metric in TIE_BREAKER_METRICS)),
        reverse=True,
    )
    for position, rule in enumerate(rules, start=1):
        rule["rank"] = position
    return rules
