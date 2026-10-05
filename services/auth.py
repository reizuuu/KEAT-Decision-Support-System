from flask import jsonify, redirect, request, session, url_for

from models import UserAccounts, db


SESSION_USER_KEY = "user_id"

# The only endpoints reachable without a session: the login page itself, the
# static assets it needs, and the login/logout calls. Everything else - every
# page and every /api/ route, including any added later - requires a logged-in
# user (see enforce_login), so typing a URL directly can't get around the
# login page.
PUBLIC_ENDPOINTS = {"index", "static", "favicon", "auth.login", "auth.logout"}


def current_user():
    """Returns the logged-in UserAccounts row, or None if not authenticated.

    A session whose account no longer exists (deleted, or the database was
    replaced) counts as logged out, not as a valid login.
    """
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
    """App-wide before_request guard: default-deny for anything outside
    PUBLIC_ENDPOINTS. Pages redirect to the login page; API calls get a 401
    (the frontend sends the user back to the login page on any 401 - see
    script.js).
    """
    if request.endpoint in PUBLIC_ENDPOINTS:
        return None
    if current_user() is None:
        return _unauthenticated_response()
    return None


def prevent_caching(response):
    """App-wide after_request hook: pages and API responses must not be
    stored by the browser, so after signing out the Back button can't show a
    cached Dashboard - the browser has to ask the server again, which
    redirects to the login page. Static assets stay cacheable.
    """
    if request.endpoint != "static":
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response

