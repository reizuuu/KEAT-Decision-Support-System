"""End-to-end smoke test against a throwaway sqlite file.

Run from the project root: python -m unittest tests.test_smoke -v
"""

import io
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import config  # noqa: E402

# point config at a temp dir before app.py runs create_app() on import
TMP_DIR = tempfile.mkdtemp(prefix="keat-test-")
config.INSTANCE_DIR = TMP_DIR
config.DATABASE_PATH = os.path.join(TMP_DIR, "keat.sqlite3")
config.DATABASE_URI = f"sqlite:///{config.DATABASE_PATH}"
config.MASTER_CATALOG_DIR = os.path.join(TMP_DIR, "master_catalog")

from app import app  # noqa: E402
from models import db  # noqa: E402

UPLOAD_CSV = """Receipt ID,Date,Product Name,Category,Quantity,Timestamp
1,2024-03-01,Iced Tea,Drinks,2,09:15
1,2024-03-01,Burger,Food,1,09:15
2,2024-03-01,Fries,Food,1,10:30
2,2024-03-01,Iced Tea,Drinks,1,10:30
3,2024-03-02,Burger,Food,2,13:00
3,2024-03-02,Fries,Food,2,13:00
4,2024-03-02,Mystery Item,Food,1,14:00
"""

PAGES = ["/dashboard", "/analytics", "/products", "/upload"]
API_GETS = [
    "/api/products",
    "/api/categories",
    "/api/results",
    "/api/analytics",
    "/api/analytics/status",
    "/api/users/me",
    "/api/session",
]


def wait_for_background_threads(timeout=60):
    deadline = time.time() + timeout
    for thread in threading.enumerate():
        if thread is threading.main_thread():
            continue
        thread.join(max(0, deadline - time.time()))


def tearDownModule():
    wait_for_background_threads()
    with app.app_context():
        db.session.remove()
        db.engine.dispose()
    shutil.rmtree(TMP_DIR, ignore_errors=True)


class SmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert config.DATABASE_PATH.startswith(TMP_DIR)
        result = app.test_cli_runner().invoke(
            args=["create-user", "--username", "tester", "--password", "secret"]
        )
        assert "Created" in result.output, result.output

    def setUp(self):
        self.client = app.test_client()

    def login(self):
        response = self.client.post("/api/login", json={"username": "tester", "password": "secret"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["username"], "tester")

    def test_1_logged_out(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        for path in PAGES:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 302, path)
            self.assertTrue(response.headers["Location"].endswith("/"), path)
        for path in API_GETS:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 401, path)
            self.assertEqual(response.get_json(), {"error": "Authentication required."})
        self.assertEqual(self.client.post("/api/upload").status_code, 401)
        self.assertEqual(self.client.post("/api/products", json={}).status_code, 401)
        self.assertEqual(self.client.put("/api/users/me", json={}).status_code, 401)

        bad = self.client.post("/api/login", json={"username": "tester", "password": "nope"})
        self.assertEqual(bad.status_code, 401)

    def test_2_full_flow(self):
        self.login()
        self.assertEqual(self.client.get("/").status_code, 302)
        for path in PAGES:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            self.assertEqual(response.headers["Cache-Control"], "no-store")

        self.assertEqual(self.client.get("/api/session").get_json(), {"username": "tester", "role": "user"})

        # products: create, duplicate, update. uploads match on alias, so set one
        ids = {}
        for name, category, price in [("iced tea", "Drinks", 50), ("Burger", "Food", 120), ("Fries", "Food", None)]:
            response = self.client.post(
                "/api/products",
                json={"product_name": name, "product_alias": name, "category": category, "price": price},
            )
            self.assertEqual(response.status_code, 201, response.get_json())
            body = response.get_json()
            self.assertEqual(set(body), {"id", "name", "alias", "category", "price"})
            ids[body["name"]] = body["id"]
        self.assertIn("Iced Tea", ids)

        dup = self.client.post("/api/products", json={"product_name": "Iced-Tea", "category": "Drinks"})
        self.assertEqual(dup.status_code, 400)
        bad_price = self.client.post(
            "/api/products", json={"product_name": "X", "category": "Food", "price": -1}
        )
        self.assertEqual(bad_price.get_json(), {"error": "price cannot be negative."})

        response = self.client.put(f"/api/products/{ids['Fries']}", json={"price": 60})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["price"], 60)
        self.assertEqual(self.client.put("/api/products/9999", json={}).status_code, 404)

        listing = self.client.get("/api/products").get_json()["products"]
        self.assertEqual([p["name"] for p in listing], ["Burger", "Fries", "Iced Tea"])
        self.assertEqual(self.client.get("/api/categories").get_json(), {"categories": ["Drinks", "Food"]})
        wait_for_background_threads()

        # upload
        self.assertEqual(self.client.post("/api/upload", data={}).status_code, 400)
        response = self.upload(UPLOAD_CSV)
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(
            response.get_json(),
            {
                "rowsProcessed": 6,
                "duplicateRowsDropped": 0,
                "invalidRowsDropped": 0,
                "skippedUnmatchedRows": 1,
                "unmatchedProductNames": ["Mystery Item"],
                "skippedUnpricedRows": 0,
                "unpricedProductNames": [],
                "insightsUpdating": True,
            },
        )
        wait_for_background_threads()

        # same file again: had unmatched rows, so it's let through and dedups row by row
        again = self.upload(UPLOAD_CSV).get_json()
        self.assertEqual(again["rowsProcessed"], 0)
        self.assertEqual(again["duplicateRowsDropped"], 6)
        wait_for_background_threads()

        missing = self.upload("Receipt ID,Date\n1,2024-03-01\n")
        self.assertEqual(missing.status_code, 400)
        self.assertIn("missingColumns", missing.get_json())

        # results
        results = self.client.get("/api/results").get_json()
        dashboard = results["dashboard"]
        self.assertEqual(dashboard["totalRevenue"], 100 + 120 + 60 + 50 + 240 + 120)
        self.assertEqual(dashboard["totalTransactions"], 3)
        self.assertTrue(dashboard["transactionsByHour"]["hasTimeData"])
        self.assertEqual(dashboard["transactionsByDayOfWeek"]["data"][4], 2)  # 2024-03-01 is a Friday
        filtered = self.client.get("/api/results?category=Drinks").get_json()["dashboard"]
        self.assertEqual(filtered["totalRevenue"], 150)
        empty = self.client.get("/api/results?start_date=2030-01-01").get_json()
        self.assertEqual(empty, {"empty": True})

        # analytics
        analytics = self.client.get("/api/analytics").get_json()
        self.assertEqual(set(analytics), {"rulesGenerated", "transactions", "categories", "bundles"})
        self.assertEqual(analytics["transactions"], 3)
        status = self.client.get("/api/analytics/status").get_json()
        self.assertEqual(status, {"hasApproximateRules": False})

        # delete (soft) - sales history still counts
        response = self.client.delete(f"/api/products/{ids['Fries']}")
        self.assertEqual(response.get_json(), {"id": ids["Fries"], "isActive": False})
        self.assertEqual(self.client.delete(f"/api/products/{ids['Fries']}").status_code, 200)
        wait_for_background_threads()
        names = [p["name"] for p in self.client.get("/api/products").get_json()["products"]]
        self.assertEqual(names, ["Burger", "Iced Tea"])
        self.assertEqual(
            self.client.get("/api/results").get_json()["dashboard"]["totalRevenue"], dashboard["totalRevenue"]
        )

        # re-adding a deleted product revives it
        revived = self.client.post(
            "/api/products", json={"product_name": "fries", "product_alias": "Fries", "category": "Food"}
        )
        self.assertEqual(revived.status_code, 200)
        self.assertEqual(revived.get_json()["id"], ids["Fries"])
        wait_for_background_threads()

        # users
        me = self.client.get("/api/users/me").get_json()
        self.assertEqual(set(me), {"id", "username", "role"})
        response = self.client.put("/api/users/me", json={"username": "tester2"})
        self.assertEqual(response.get_json()["username"], "tester2")
        self.client.put("/api/users/me", json={"username": "tester"})

        self.assertEqual(self.client.post("/api/logout").status_code, 200)
        self.assertEqual(self.client.get("/api/results").status_code, 401)

    def upload(self, text, name="sales.csv"):
        return self.client.post(
            "/api/upload",
            data={"file": (io.BytesIO(text.encode()), name)},
            content_type="multipart/form-data",
        )


if __name__ == "__main__":
    unittest.main()
