import os


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
DATABASE_PATH = os.path.join(INSTANCE_DIR, "keat.sqlite3")
DATABASE_URI = f"sqlite:///{DATABASE_PATH}"
MAX_CONTENT_LENGTH = 50 * 1024 * 1024

# Directory scanned once at startup for an optional master catalog file
# (master_catalog.xlsx or .csv) to bulk-seed Category/Products from - see
# services/persistence.seed_master_catalog_if_empty(). Missing directory or
# file is not an error; it's an optional from-scratch bootstrap. Lives
# under instance/ (auto-created alongside it, see app.py) rather than a
# separate top-level folder, since it's instance-specific input the same
# way the sqlite file itself is.
MASTER_CATALOG_DIR = os.path.join(INSTANCE_DIR, "master_catalog")

# Single-admin prototype: a fixed dev fallback is fine here, but production
# deployments should set KEAT_SECRET_KEY so session cookies aren't signed
# with a key that's checked into source control.
SECRET_KEY = os.environ.get("KEAT_SECRET_KEY", "dev-secret-key-change-in-production")



MIN_CONFIDENCE = 0.2
MIN_SUPPORT = 0.003
MIN_LIFT = 1.2