from flask import Blueprint, jsonify, request

from models import Rules
from services.aggregation import build_dashboard_payload
from services.cache import get_or_build
from services.queries import (
    build_analytics_browse_payload,
    build_rule_bundles_payload,
    build_transactions_dataframe,
    count_receipts,
)


results_bp = Blueprint("results", __name__)


@results_bp.get("/api/results")
def get_results():
    start_date = request.args.get("start_date") or ""
    end_date = request.args.get("end_date") or ""
    categories = sorted(request.args.getlist("category"))
    products = sorted(request.args.getlist("product"))

    def build():
        df = build_transactions_dataframe(
            start_date=start_date, end_date=end_date, categories=categories, products=products
        )
        if df.empty:
            return {"empty": True}
        return {"dashboard": build_dashboard_payload(df)}

    cache_key = ("results", start_date, end_date, tuple(categories), tuple(products))
    return jsonify(get_or_build(cache_key, build)), 200


@results_bp.get("/api/analytics")
def get_analytics():
    def build():
        payload = build_analytics_browse_payload(count_receipts())
        payload["bundles"] = build_rule_bundles_payload()
        return payload

    return jsonify(get_or_build(("analytics",), build)), 200


@results_bp.get("/api/analytics/status")
def get_analytics_status():
    # polled by the analytics page while a remine is running
    has_approximate_rules = Rules.query.filter_by(is_approximate=True).first() is not None
    return jsonify({"hasApproximateRules": has_approximate_rules}), 200
