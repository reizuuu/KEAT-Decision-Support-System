from flask import Blueprint, jsonify, request
from werkzeug.security import generate_password_hash

from models import UserAccounts, db
from services.auth import api_login_required, current_user


users_bp = Blueprint("users_api", __name__)


@users_bp.get("/api/users/me")
@api_login_required
def get_current_user_account():
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required."}), 401
    return jsonify({"id": user.user_id, "username": user.username, "role": user.role}), 200


@users_bp.put("/api/users/me")
@api_login_required
def update_current_user_account():
    # Scoped to the session's own user server-side (via current_user()),
    # regardless of what a request body might otherwise imply - there's no
    # id in this URL for a caller to substitute another account's into.
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required."}), 401

    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if username:
        existing = UserAccounts.query.filter_by(username=username).first()
        if existing is not None and existing.user_id != user.user_id:
            return jsonify({"error": "That username is already taken."}), 409
        user.username = username

    if password:
        user.password = generate_password_hash(password)

    db.session.commit()
    return jsonify({"id": user.user_id, "username": user.username, "role": user.role}), 200
