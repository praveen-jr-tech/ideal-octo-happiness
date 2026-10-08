import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from local_server import app as server


class MerchantSalesTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "campus-wallet.sqlite"
        self.db_path_patch = patch.object(server, "DB_PATH", self.db_path)
        self.db_path_patch.start()
        server.ensure_database()
        self.client = server.app.test_client()
        self.student_headers = self._login("students", "STU1001")
        self.merchant_headers = self._login("merchants", "CANTEEN1")

        db = server.connect()
        student = db.execute(
            "SELECT id FROM accounts WHERE college_id = 'STU1001'"
        ).fetchone()
        db.execute(
            """INSERT INTO ledger_entries
               (id, account_id, amount_paise, entry_type, note, created_at)
               VALUES (?, ?, ?, 'test_topup', 'Test credit', ?)""",
            ("test-credit", student["id"], 10000, server.utcnow()),
        )
        db.commit()
        db.close()

    def tearDown(self):
        self.db_path_patch.stop()
        self.temp_dir.cleanup()

    def _login(self, endpoint, college_id):
        response = self.client.post(
            f"/{endpoint}/login",
            json={"collegeId": college_id, "pin": "1234"},
        )
        self.assertEqual(response.status_code, 200)
        return {"Authorization": f"Bearer {response.get_json()['token']}"}

    def _new_qr(self):
        response = self.client.get("/students/qr", headers=self.student_headers)
        self.assertEqual(response.status_code, 200)
        return response.get_json()["token"]

    def test_charge_marks_qr_used_and_records_order_note(self):
        token = self._new_qr()
        response = self.client.post(
            "/merchants/charge",
            headers=self.merchant_headers,
            json={"token": token, "amountPaise": 2500, "note": "Dosa and tea"},
        )

        self.assertEqual(response.status_code, 200)
        retry = self.client.post(
            "/merchants/charge",
            headers=self.merchant_headers,
            json={"token": token, "amountPaise": 2500},
        )
        self.assertEqual(retry.status_code, 409)
        self.assertIn("already used", retry.get_json()["error"])

        ledger = self.client.get(
            "/merchants/ledger", headers=self.merchant_headers
        ).get_json()["entries"]
        self.assertEqual(len(ledger), 1)
        self.assertEqual(ledger[0]["note"], "From STU1001 · Dosa and tea")

    def test_summary_and_search_report_charged_sales(self):
        response = self.client.post(
            "/merchants/charge",
            headers=self.merchant_headers,
            json={
                "token": self._new_qr(),
                "amountPaise": 2500,
                "note": "Dosa and tea",
            },
        )
        self.assertEqual(response.status_code, 200)

        summary = self.client.get(
            "/merchants/summary", headers=self.merchant_headers
        ).get_json()
        self.assertEqual(summary["sales_count"], 1)
        self.assertEqual(summary["gross_paise"], 2500)
        self.assertEqual(summary["average_paise"], 2500)

        filtered = self.client.get(
            "/merchants/ledger?period=today&search=STU1001",
            headers=self.merchant_headers,
        ).get_json()["entries"]
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0]["student_name"], "Alex Test")

        by_amount = self.client.get(
            "/merchants/ledger?search=25.00",
            headers=self.merchant_headers,
        ).get_json()["entries"]
        self.assertEqual(len(by_amount), 1)


if __name__ == "__main__":
    unittest.main()
