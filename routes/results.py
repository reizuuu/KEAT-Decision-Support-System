from flask import Blueprint, jsonify, request

from models import Rules
from services.aggregation import build_dashboard_payload
from services.auth import api_login_required
from services.cache import get_or_build
from services.persistence import (
    build_analytics_browse_payload,
    build_rule_bundles_payload,
    build_transactions_dataframe,
    count_receipts,
)


results_bp = Blueprint("results", __name__)


@results_bp.get("/api/results")
@api_login_required
def get_results():
    """Dashboard data for the given filters. Analytics has its own endpoint
    (/api/analytics) so neither page pays for the other's data.
    """
    start_date = request.args.get("start_date") or ""
    end_date = request.args.get("end_date") or ""
    categories = sorted(request.args.getlist("category"))
    products = sorted(request.args.getlist("product"))

    def build():
        dashboard_dataframe = build_transactions_dataframe(
            start_date=start_date, end_date=end_date, categories=categories, products=products
        )
        if dashboard_dataframe.empty:
            return {"empty": True}
        return {"dashboard": build_dashboard_payload(dashboard_dataframe)}

    cache_key = ("results", start_date, end_date, tuple(categories), tuple(products))
    return jsonify(get_or_build(cache_key, build)), 200


@results_bp.get("/api/analytics")
@api_login_required
def get_analytics():
    """Analytics page data - always the full accumulated dataset, never the
    dashboard filters.
    """

    def build():
        payload = build_analytics_browse_payload(count_receipts())
        payload["bundles"] = build_rule_bundles_payload()
        return payload

    return jsonify(get_or_build(("analytics",), build)), 200


@results_bp.get("/api/analytics/status")
@api_login_required
def get_analytics_status():
    """Cheap poll target for the Analytics page's "recalculating" badge -
    just whether any Rules row is still flagged is_approximate (stale
    pending a background remine, see services/persistence.
    prune_rules_for_product), rather than recomputing/returning the full
    analytics payload on every poll tick.
    """
    has_approximate_rules = Rules.query.filter_by(is_approximate=True).first() is not None
    return jsonify({"hasApproximateRules": has_approximate_rules}), 200
