import inspect
import math

import pandas as pd
from mlxtend.frequent_patterns import association_rules, fpgrowth
from mlxtend.preprocessing import TransactionEncoder

from config import MIN_CONVICTION, MIN_LEVERAGE, MIN_LIFT, MIN_SUPPORT

# Some mlxtend 0.23.x releases require an explicit `num_itemsets` argument to
# association_rules(); others don't accept it at all. Detect which signature
# is installed once, instead of hardcoding a version check.
_ASSOCIATION_RULES_PARAMS = inspect.signature(association_rules).parameters


def compute_rules(dataframe):
    """Mines association rules from a (Receipt ID, Product Name) dataframe.

    Returns (rules_dataframe, transaction_count). rules_dataframe carries the
    raw mlxtend columns (antecedents/consequents as frozensets of product
    names, plus support/confidence/lift/leverage/conviction) so callers can
    either format it for display (build_analytics_payload) or persist it
    (routes/upload.py, which re-mines over the full accumulated dataset).
    """
    transactions = (
        dataframe.groupby("Receipt ID")["Product Name"]
        .apply(lambda products: sorted(set(products)))
        .tolist()
    )
    # No basket-size floor here, deliberately: a basket left with only one
    # active item (e.g. after remine_rules excludes now-inactive products)
    # can't itself supply a 2-item rule, but it's still a real transaction
    # that happened - dropping it from the denominator would inflate every
    # support/confidence figure relative to what the system's actual full
    # basket population supports. Keeping it in gives the true rate at
    # which a pattern occurs across everything that was actually bought,
    # which is what "the rules the system could produce" is meant to mean.
    if not transactions:
        return pd.DataFrame(), 0

    encoder = TransactionEncoder()
    encoded = encoder.fit(transactions).transform(transactions)
    encoded_dataframe = pd.DataFrame(encoded, columns=encoder.columns_)
    itemsets = fpgrowth(
        encoded_dataframe,
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
# Strict tie-breaker order for rules whose composite scores are exactly equal.
TIE_BREAKER_METRICS = ("leverage", "lift", "conviction", "support", "confidence")


def rank_rules(rules):
    """Scores and ranks rules in place by a weighted composite score.

    `rules` is a list of dicts carrying raw, unrounded float values for each
    of RANKING_METRICS (conviction may be math.inf). Each metric is Min-Max
    scaled to 0-1 across the current pool, weighted 0.20 and summed into
    rule["score"]. The list is then sorted by score descending, with exact
    ties broken by TIE_BREAKER_METRICS (raw values, highest first), and each
    rule gets a 1-based rule["rank"].
    """
    if not rules:
        return rules

    normalized = {}
    for metric in RANKING_METRICS:
        values = [float(rule[metric]) for rule in rules]
        if metric == "conviction":
            # Conviction is infinite when confidence is exactly 1.0. Cap those
            # at the largest finite conviction in the pool so they still score
            # highest without breaking the scaling.
            finite_values = [value for value in values if math.isfinite(value)]
            cap = max(finite_values) if finite_values else 0.0
            values = [value if math.isfinite(value) else cap for value in values]

        low, high = min(values), max(values)
        if low == high:
            # Every rule shares the same value, so this metric can't separate
            # them - skip the scaling (it would divide by zero).
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
