from flask import jsonify, redirect, request, session, url_for

from models import UserAccounts, db


SESSION_USER_KEY = "user_id"

# everything else needs a logged-in user
PUBLIC_ENDPOINTS = {"index", "static", "favicon", "auth.login", "auth.logout"}


def current_user():
    user_id = session.get(SESSION_USER_KEY)
    if user_id is None:
        return None
    return db.session.get(UserAccounts, user_id)


def _unauthenticated_response():
    session.clear()
    if request.path.startswith("/api/"):
        return jsonify({"error": "Authentication required."}), 401
    return redirect(url_for("index"))


def enforce_login():
    """before_request guard: pages redirect to the login page, api calls get a 401."""
    if request.endpoint in PUBLIC_ENDPOINTS:
        return None
    if current_user() is None:
        return _unauthenticated_response()
    return None


def prevent_caching(response):
    # no-store so the back button can't show a page after sign out
    if request.endpoint != "static":
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response

