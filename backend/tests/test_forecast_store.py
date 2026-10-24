"""Tests for forecast snapshot storage (temp SQLite file, no network)."""

import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone

from app.services import forecast_store as fs

TWO = {
    "Balanga": {"latitude": 14.6760, "longitude": 120.5363},
    "Mariveles": {"latitude": 14.4338, "longitude": 120.4858},
}
# 2026-09-07 10:20 Manila = 02:20 UTC
NOW = datetime(2026, 9, 7, 2, 20, tzinfo=timezone.utc)


def payload(precip, extra=None):
    hourly = {
        "time": [
            "2026-09-07T08:00",  # before the snapshot hour: must not be stored
            "2026-09-07T10:00",
            "2026-09-07T11:00",
            "2026-09-07T12:00",
        ],
        "precipitation": precip,
        "precipitation_probability": [10, 50, 60, 70],
    }
    hourly.update(extra or {})
    return {"latitude": 14.7, "longitude": 120.5, "hourly": hourly}


class CleanTests(unittest.TestCase):
    def test_valid_value(self):
        self.assertEqual(fs.clean_value("precipitation", 3.2), (3.2, "valid"))

    def test_missing_is_null_never_zero(self):
        for raw in (None, "", "abc", float("nan"), True):
            with self.subTest(raw=raw):
                self.assertEqual(
                    fs.clean_value("precipitation", raw), (None, "missing")
                )

    def test_zero_is_a_real_value(self):
        self.assertEqual(fs.clean_value("precipitation", 0), (0.0, "valid"))

    def test_out_of_range_is_kept_and_flagged(self):
        self.assertEqual(fs.clean_value("precipitation", 450), (450.0, "suspect"))
        self.assertEqual(fs.clean_value("precipitation", -1), (-1.0, "suspect"))
        self.assertEqual(
            fs.clean_value("precipitation_probability", 120), (120.0, "suspect")
        )


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        handle, self.path = tempfile.mkstemp(suffix=".sqlite3")
        os.close(handle)

    def tearDown(self):
        os.unlink(self.path)

    def connect(self):
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def run_snapshot(self, payloads, now=NOW):
        return fs.run_forecast_snapshot(
            municipalities=TWO,
            fetch=lambda names: payloads,
            connect=self.connect,
            now=now,
        )

    def test_stores_only_current_and_future_hours(self):
        summary = self.run_snapshot(
            [payload([9, 1.0, 2.0, 30.5]), payload([0, 0, 0, 0])]
        )
        self.assertEqual(summary["stored"], 2)
        self.assertEqual(summary["errors"], [])
        self.assertEqual(summary["issued_at"], "2026-09-07T10:00:00+08:00")

        con = self.connect()
        times = {
            r[0]
            for r in con.execute("SELECT DISTINCT valid_at FROM forecast_values")
        }
        self.assertNotIn("2026-09-07T08:00:00+08:00", times)
        self.assertEqual(len(times), 3)
        # 3 hours x 2 variables x 2 municipalities
        self.assertEqual(summary["values_stored"], 12)

    def test_missing_variable_is_not_invented(self):
        self.run_snapshot([payload([1, 1, 1, 1]), payload([1, 1, 1, 1])])
        con = self.connect()
        variables = {
            r[0] for r in con.execute("SELECT DISTINCT variable FROM forecast_values")
        }
        self.assertEqual(variables, {"precipitation", "precipitation_probability"})

    def test_none_value_stored_as_null_missing(self):
        self.run_snapshot([payload([0, None, 2, 3]), payload([0, 1, 2, 3])])
        row = self.connect().execute(
            "SELECT value, quality_flag FROM forecast_values v "
            "JOIN forecast_runs r ON r.id = v.run_id "
            "WHERE r.municipality = 'Balanga' AND variable = 'precipitation' "
            "AND valid_at = '2026-09-07T10:00:00+08:00'"
        ).fetchone()
        self.assertIsNone(row["value"])
        self.assertEqual(row["quality_flag"], "missing")

    def test_same_hour_rerun_replaces_not_duplicates(self):
        self.run_snapshot([payload([0, 1, 1, 1]), payload([0, 1, 1, 1])])
        later = datetime(2026, 9, 7, 2, 50, tzinfo=timezone.utc)
        self.run_snapshot([payload([0, 5, 5, 5]), payload([0, 5, 5, 5])], now=later)
        con = self.connect()
        self.assertEqual(con.execute("SELECT COUNT(*) FROM forecast_runs").fetchone()[0], 2)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM forecast_values").fetchone()[0], 12)
        value = con.execute(
            "SELECT value FROM forecast_values WHERE variable = 'precipitation' LIMIT 1"
        ).fetchone()[0]
        self.assertEqual(value, 5.0)

    def test_next_hour_keeps_history(self):
        self.run_snapshot([payload([0, 1, 1, 1]), payload([0, 1, 1, 1])])
        next_hour = datetime(2026, 9, 7, 3, 5, tzinfo=timezone.utc)
        self.run_snapshot([payload([0, 2, 2, 2]), payload([0, 2, 2, 2])], now=next_hour)
        issued = [
            r[0]
            for r in self.connect().execute(
                "SELECT DISTINCT issued_at FROM forecast_runs ORDER BY 1"
            )
        ]
        self.assertEqual(
            issued, ["2026-09-07T10:00:00+08:00", "2026-09-07T11:00:00+08:00"]
        )

    def test_one_municipality_failing_does_not_stop_others(self):
        bad = {"latitude": 1, "longitude": 1, "hourly": {"time": []}}
        summary = self.run_snapshot([bad, payload([0, 1, 1, 1])])
        self.assertEqual(summary["stored"], 1)
        self.assertEqual(len(summary["errors"]), 1)
        self.assertEqual(summary["errors"][0]["municipality"], "Balanga")

    def test_fetch_failure_is_reported_not_raised(self):
        def boom(names):
            raise RuntimeError("network down")

        summary = fs.run_forecast_snapshot(
            municipalities=TWO, fetch=boom, connect=self.connect, now=NOW
        )
        self.assertEqual(summary["stored"], 0)
        self.assertIn("network down", summary["errors"][0]["error"])

    def test_wrong_number_of_forecasts_is_an_error(self):
        summary = self.run_snapshot([payload([0, 1, 1, 1])])
        self.assertEqual(summary["stored"], 0)
        self.assertTrue(summary["errors"])

    def test_store_summary(self):
        self.run_snapshot([payload([0, 999, None, 3]), payload([0, 1, 2, 3])])
        info = fs.forecast_store_summary(connect=self.connect)
        self.assertEqual(info["runs"], 2)
        self.assertEqual(info["suspect_values"], 1)
        self.assertEqual(info["missing_values"], 1)
        self.assertEqual(info["last_issued_at"], "2026-09-07T10:00:00+08:00")


if __name__ == "__main__":
    unittest.main()
