import threading

import pandas as pd

from models import Products, RuleItems, Rules, db
from services.mining import compute_rules
from services.queries import build_full_transactions_dataframe


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
    mineable = dataframe[dataframe["Product Name"].isin(active_product_names)]
    if mineable.empty:
        return replace_rules(pd.DataFrame(), product_id_by_name)

    rules, _ = compute_rules(mineable)
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
