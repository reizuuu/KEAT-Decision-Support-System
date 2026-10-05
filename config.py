import os


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
DATABASE_PATH = os.path.join(INSTANCE_DIR, "keat.sqlite3")
DATABASE_URI = f"sqlite:///{DATABASE_PATH}"
MAX_CONTENT_LENGTH = 50 * 1024 * 1024

# optional master_catalog.xlsx/.csv that seeds an empty products table
MASTER_CATALOG_DIR = os.path.join(INSTANCE_DIR, "master_catalog")

# set KEAT_SECRET_KEY outside of local dev
SECRET_KEY = os.environ.get("KEAT_SECRET_KEY", "dev-secret-key-change-in-production")

# association rule thresholds
MIN_SUPPORT = 0.003
MIN_LIFT = 2
MIN_LEVERAGE = 0.0015
MIN_CONVICTION = 1.05
