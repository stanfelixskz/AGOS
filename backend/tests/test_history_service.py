"""Tests for the history service (temp SQLite, no network)."""

import sqlite3
import unittest
from datetime import date

from app.services.history_service import history

MUNIS = {"Balanga": {"latitude": 14.676, "longitude": 120.5363}, "Hermosa": {"latitude": 14.8319, "longitude": 120.5087}}


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.con = sqlite3.connect(":memory:")
        self.con.row_factory = sqlite3.Row
        self.con.execute("CREATE TABLE observations (source TEXT, variable TEXT, observed_at TEXT, latitude REAL, longitude REAL, value REAL, unit TEXT, quality_flag TEXT, fetched_at TEXT)")

    def add(self, day, variable, value, lat=14.676, lon=120.5363):
        self.con.execute("INSERT INTO observations VALUES ('s', ?, ?, ?, ?, ?, 'mm', 'valid', 'x')", (variable, day, lat, lon, value))

    def test_missing_days_are_null_not_zero(self):
        self.add("2026-09-01", "precipitation_sum", 12.5)
        self.add("2026-09-03", "precipitation_sum", 0.0)
        self.add("2026-09-03", "river_discharge", 4.0)
        result = history(self.con, MUNIS, date(2026, 9, 1), date(2026, 9, 3))
        balanga = result["towns"][0]
        self.assertEqual([d["precipitation_mm"] for d in balanga["daily"]], [12.5, None, 0.0])
        self.assertEqual(balanga["rain_days_with_data"], 2)
        self.assertEqual(balanga["total_rain_mm"], 12.5)
        self.assertEqual(balanga["wettest_day"], {"date": "2026-09-01", "precipitation_mm": 12.5})
        self.assertEqual(balanga["days_with_10mm_or_more"], 1)
        self.assertEqual(balanga["highest_flow_day"]["river_discharge_m3s"], 4.0)
        self.assertTrue(result["any_data"])

    def test_town_without_data(self):
        result = history(self.con, MUNIS, date(2026, 9, 1), date(2026, 9, 2))
        hermosa = result["towns"][1]
        self.assertIsNone(hermosa["total_rain_mm"])
        self.assertIsNone(hermosa["wettest_day"])
        self.assertFalse(result["any_data"])

    def test_other_points_are_not_mixed_in(self):
        self.add("2026-09-01", "precipitation_sum", 50, lat=14.70, lon=120.50)
        result = history(self.con, MUNIS, date(2026, 9, 1), date(2026, 9, 1))
        self.assertIsNone(result["towns"][0]["daily"][0]["precipitation_mm"])


if __name__ == "__main__":
    unittest.main()
