import os

import click
from flask import Flask, jsonify, redirect, render_template, request, url_for
from werkzeug.exceptions import HTTPException
from werkzeug.security import generate_password_hash

from config import DATABASE_PATH, DATABASE_URI, MASTER_CATALOG_DIR, MAX_CONTENT_LENGTH, SECRET_KEY
from models import UserAccounts, db
from routes.auth import auth_bp
from routes.products import products_bp
from routes.results import results_bp
from routes.upload import upload_bp
from routes.users import users_bp
from services.auth import current_user, enforce_login, login_required, prevent_caching
from services.migrations import run_startup_migrations
from services.persistence import seed_master_catalog_if_empty


def create_app():
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.config["SQLALCHEMY_DATABASE_URI"] = DATABASE_URI
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH
    app.config["SECRET_KEY"] = SECRET_KEY
    db.init_app(app)

    # Initialize the empty schema once, before the app serves requests, then
    # bring an existing (pre-upgrade) database's schema up to date, then
    # (only on a from-scratch, product-less catalog) seed it from an
    # optional master catalog file.
    with app.app_context():
        os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)
        # Created eagerly (even though seed_master_catalog_if_empty()
        # tolerates a missing directory just fine) so the drop-a-file-in
        # location always exists and is easy to find, without anyone having
        # to create it by hand first.
        os.makedirs(MASTER_CATALOG_DIR, exist_ok=True)
        if not os.path.exists(DATABASE_PATH):
            db.create_all()
        run_startup_migrations()
        seed_master_catalog_if_empty()

    app.register_blueprint(auth_bp)
    app.register_blueprint(upload_bp)
    app.register_blueprint(results_bp)
    app.register_blueprint(products_bp)
    app.register_blueprint(users_bp)

    # Every request needs a logged-in user unless it's on the short public
    # list in services/auth.PUBLIC_ENDPOINTS, and no page is left in the
    # browser's cache for the Back button to show after signing out.
    app.before_request(enforce_login)
    app.after_request(prevent_caching)

    @app.errorhandler(413)
    def request_entity_too_large(error):
        return jsonify({"error": "File size exceeds the 50 MB limit."}), 413

    @app.errorhandler(Exception)
    def handle_unexpected_error(error):
        # Without this, an uncaught exception on an /api/* route falls
        # through to Flask's default HTML error page, and the frontend's
        # `await response.json()` blows up with a "Unexpected token '<'"
        # parse error instead of surfacing the real failure.
        if isinstance(error, HTTPException):
            return error
        if request.path.startswith("/api/"):
            app.logger.exception("Unhandled error on %s", request.path)
            return jsonify({"error": "Something went wrong processing your request."}), 500
        raise error

    # Browsers request /favicon.ico on their own (e.g. for non-HTML
    # responses), regardless of the <link rel="icon"> tags in the templates.
    @app.get("/favicon.ico")
    def favicon():
        return redirect(url_for("static", filename="assets/favicons/favicon.ico"))

    @app.get("/")
    def index():
        # Already signed in - skip the login form.
        if current_user() is not None:
            return redirect(url_for("dashboard"))
        return render_template("index.html")

    @app.get("/dashboard")
    @login_required
    def dashboard():
        return render_template("dashboard.html")

    @app.get("/analytics")
    @login_required
    def analytics():
        return render_template("analytics.html")

    @app.get("/products")
    @login_required
    def products():
        return render_template("products.html")

    @app.get("/upload")
    @login_required
    def upload():
        return render_template("upload.html")

    # Both commands seed an identical account - role is no longer tied to any
    # permission tier (every account can manage its own credentials, see
    # routes/users.py), so there's nothing left to distinguish them by.
    # Kept as two names since either may already be in use in setup scripts.
    @app.cli.command("create-admin")
    @click.option("--username", prompt=True)
    @click.option("--password", prompt=True, hide_input=True, confirmation_prompt=True)
    def create_admin(username, password):
        """Seed an account for this app."""
        _create_account(username, password, role="user", label="admin")

    @app.cli.command("create-user")
    @click.option("--username", prompt=True)
    @click.option("--password", prompt=True, hide_input=True, confirmation_prompt=True)
    def create_user(username, password):
        """Seed an account for this app (alias of create-admin)."""
        _create_account(username, password, role="user", label="admin")

    return app


def _create_account(username, password, role, label):
    if UserAccounts.query.filter_by(username=username).first() is not None:
        click.echo(f"User '{username}' already exists.")
        return
    user = UserAccounts(username=username, password=generate_password_hash(password), role=role)
    db.session.add(user)
    db.session.commit()
    click.echo(f"Created {label} user '{username}'.")


app = create_app()


if __name__ == "__main__":
    app.run(debug=True)
