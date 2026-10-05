from flask import Blueprint, jsonify, request, session
from werkzeug.security import check_password_hash

from models import UserAccounts
from services.auth import SESSION_USER_KEY, api_login_required, current_user


auth_bp = Blueprint("auth", __name__)


@auth_bp.post("/api/login")
def login():
    data = request.get_json(silent=True) or request.form
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    user = UserAccounts.query.filter_by(username=username).first()
    if user is None or not check_password_hash(user.password, password):
        return jsonify({"error": "Invalid username or password."}), 401

    session.clear()
    session[SESSION_USER_KEY] = user.user_id
    return jsonify({"username": user.username, "role": user.role}), 200


@auth_bp.post("/api/logout")
def logout():
    session.clear()
    return jsonify({}), 200


@auth_bp.get("/api/session")
@api_login_required
def get_session():
    user = current_user()
    if user is None:
        return jsonify({"error": "Authentication required."}), 401
    return jsonify({"username": user.username, "role": user.role}), 200
