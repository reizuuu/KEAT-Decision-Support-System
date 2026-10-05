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
from services.auth import current_user, enforce_login, prevent_caching
from services.migrations import run_startup_migrations
from services.catalog import seed_master_catalog_if_empty


def create_app():
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.config["SQLALCHEMY_DATABASE_URI"] = DATABASE_URI
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH
    app.config["SECRET_KEY"] = SECRET_KEY
    db.init_app(app)

    with app.app_context():
        os.makedirs(os.path.dirname(DATABASE_PATH), exist_ok=True)
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

    app.before_request(enforce_login)
    app.after_request(prevent_caching)

    @app.errorhandler(413)
    def request_entity_too_large(error):
        return jsonify({"error": "File size exceeds the 50 MB limit."}), 413

    @app.errorhandler(Exception)
    def handle_unexpected_error(error):
        # api routes should always answer with json, even on a crash
        if isinstance(error, HTTPException):
            return error
        if request.path.startswith("/api/"):
            app.logger.exception("Unhandled error on %s", request.path)
            return jsonify({"error": "Something went wrong processing your request."}), 500
        raise error

    @app.get("/favicon.ico")
    def favicon():
        return redirect(url_for("static", filename="assets/favicons/favicon.ico"))

    @app.get("/")
    def index():
        if current_user() is not None:
            return redirect(url_for("dashboard"))
        return render_template("index.html")

    @app.get("/dashboard")
    def dashboard():
        return render_template("dashboard.html")

    @app.get("/analytics")
    def analytics():
        return render_template("analytics.html")

    @app.get("/products")
    def products():
        return render_template("products.html")

    @app.get("/upload")
    def upload():
        return render_template("upload.html")

    # create-admin and create-user do the same thing
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
