import threading

import pandas as pd

from models import Products, RuleItems, Rules, db
from services.mining import compute_rules
from services.queries import build_full_transactions_dataframe


def replace_rules(rules_dataframe, product_id_by_name):
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
    """Re-mines rules over all stored transactions. Inactive products are left out."""
    dataframe, product_id_by_name = build_full_transactions_dataframe()
    if dataframe.empty:
        return replace_rules(pd.DataFrame(), product_id_by_name)

    active_product_names = {
        product.product_name for product in Products.query.filter_by(is_active=True).all()
    }
    mineable = dataframe[dataframe["Product Name"].isin(active_product_names)]
    if mineable.empty:
        return replace_rules(pd.DataFrame(), product_id_by_name)

    rules, _ = compute_rules(mineable)
    return replace_rules(rules, product_id_by_name)


def _remine_rules_in_background(app):
    # the thread needs its own app context for db.session
    with app.app_context():
        try:
            remine_rules()
            db.session.commit()
        except Exception:
            db.session.rollback()
            app.logger.exception("Background remine failed.")


def start_background_remine(app):
    """Remines on a daemon thread. app must be the real app object, not the current_app proxy."""
    threading.Thread(target=_remine_rules_in_background, args=(app,), daemon=True).start()


def prune_rules_for_product(product_id):
    """Removes a deleted product from existing rules without re-mining. Rules where it was
    the only item on a side are deleted, the rest are flagged approximate. Doesn't commit.
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
