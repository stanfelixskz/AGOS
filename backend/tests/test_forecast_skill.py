"""Tests for forecast skill/bias (temp SQLite, no network, no FastAPI)."""

import os
import sqlite3
import tempfile
import unittest
from datetime import date, datetime, timedelta

from app.services import forecast_skill as sk
from app.services import forecast_store as fs

POINT = {"latitude": 14.676, "longitude": 120.5363}
PH = sk.PH_TZ


class ScoreTests(unittest.TestCase):
    def test_no_data(self):
        self.assertEqual(sk.score_pairs([])["status"], "no_data")

    def test_contingency_counts_and_percent(self):
        pairs = [(5, 5), (0, 4), (3, 0), (0, 0)]  # hit, miss, false alarm, correct neg
        score = sk.score_pairs(pairs)
        self.assertEqual(
            (score["hits"], score["misses"], score["false_alarms"], score["correct_negatives"]),
            (1, 1, 1, 1),
        )
        self.assertEqual(score["rain_no_rain_correct_percent"], 50.0)
        self.assertEqual(score["rain_detected_percent"], 50.0)

    def test_small_sample_offers_no_adjustment(self):
        score = sk.score_pairs([(10, 5)] * 5)
        self.assertEqual(score["status"], "insufficient_data")
        self.assertIsNone(score["adjustment_factor"])

    def test_overforecast_gives_factor_below_one(self):
        score = sk.score_pairs([(20, 10)] * 20)
        self.assertEqual(score["status"], "ok")
        self.assertEqual(score["bias_ratio"], 2.0)
        self.assertEqual(score["adjustment_factor"], 0.5)
        self.assertEqual(score["mean_error_mm"], 10.0)

    def test_no_observed_rain_means_no_ratio(self):
        score = sk.score_pairs([(2, 0)] * 30)
        self.assertIsNone(score["bias_ratio"])
        self.assertEqual(score["status"], "insufficient_data")


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        handle, self.path = tempfile.mkstemp(suffix=".sqlite3")
        os.close(handle)
        self.con = sqlite3.connect(self.path)
        self.con.row_factory = sqlite3.Row
        fs.init_tables(self.con)
        self.con.execute(
            "CREATE TABLE observations (source TEXT, variable TEXT, observed_at TEXT, "
            "latitude REAL, longitude REAL, value REAL, unit TEXT, "
            "quality_flag TEXT, fetched_at TEXT)"
        )

    def tearDown(self):
        self.con.close()
        os.unlink(self.path)

    def add_forecast(self, day, hourly_mm, hours=24, issued_before_hours=6):
        start = datetime(day.year, day.month, day.day, tzinfo=PH)
        issued = (start - timedelta(hours=issued_before_hours)).isoformat(timespec="seconds")
        cur = self.con.execute(
            "INSERT INTO forecast_runs (source, municipality, issued_at, fetched_at, "
            "requested_latitude, requested_longitude) VALUES (?,?,?,?,?,?)",
            (fs.SOURCE, "Balanga", issued, issued, 14.676, 120.5363),
        )
        for h in range(hours):
            self.con.execute(
                "INSERT INTO forecast_values VALUES (?,?,?,?,?,?)",
                (
                    cur.lastrowid,
                    (start + timedelta(hours=h)).isoformat(timespec="seconds"),
                    "precipitation",
                    hourly_mm,
                    "mm",
                    "valid",
                ),
            )

    def add_observed(self, day, mm):
        self.con.execute(
            "INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?)",
            ("open_meteo_archive", "precipitation_sum", day.isoformat(),
             14.676, 120.5363, mm, "mm", "valid", "x"),
        )

    def test_matches_forecast_and_observed_by_day(self):
        d = date(2026, 9, 7)
        self.add_forecast(d, 1.0)  # 24 mm over the day
        self.add_observed(d, 12.0)
        self.con.commit()
        result = sk.municipality_skill(self.con, "Balanga", POINT, d, d)
        self.assertEqual(result["days"], 1)
        self.assertEqual(result["forecast_total_mm"], 24.0)
        self.assertEqual(result["observed_total_mm"], 12.0)
        self.assertEqual(result["bias_ratio"], 2.0)

    def test_incomplete_day_is_skipped(self):
        d = date(2026, 9, 7)
        self.add_forecast(d, 1.0, hours=20)
        self.add_observed(d, 12.0)
        self.con.commit()
        self.assertEqual(sk.municipality_skill(self.con, "Balanga", POINT, d, d)["days"], 0)

    def test_forecast_issued_after_day_start_is_not_used(self):
        d = date(2026, 9, 7)
        self.add_forecast(d, 1.0, issued_before_hours=-3)  # issued 03:00 that day
        self.add_observed(d, 12.0)
        self.con.commit()
        self.assertEqual(sk.municipality_skill(self.con, "Balanga", POINT, d, d)["days"], 0)

    def test_day_without_observation_is_skipped(self):
        d = date(2026, 9, 7)
        self.add_forecast(d, 1.0)
        self.con.commit()
        self.assertEqual(sk.municipality_skill(self.con, "Balanga", POINT, d, d)["days"], 0)

    def test_report_runs_with_injected_connection(self):
        d = date(2026, 9, 7)
        self.add_forecast(d, 0.5)
        self.add_observed(d, 12.0)
        self.con.commit()
        report = sk.skill_report(
            days=7,
            municipalities={"Balanga": POINT},
            connect=self._fresh,
            today=date(2026, 9, 8),
        )
        self.assertEqual(report["municipalities"][0]["days"], 1)

    def _fresh(self):
        con = sqlite3.connect(self.path)
        con.row_factory = sqlite3.Row
        return con


if __name__ == "__main__":
    unittest.main()
