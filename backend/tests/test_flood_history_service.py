"""
Flood-risk history. No network: payloads are faked; the numbers are invented.
"""

import unittest
from datetime import date, datetime, timedelta

from app.data.municipalities import MUNICIPALITIES
from app.services import flood_history_service as fh
from app.services.analysis_service import MODELS

PH = fh.PH_TZ
START = date(2026, 8, 1)


def hourly_axis(first: date, days: int):
    base = datetime(first.year, first.month, first.day, tzinfo=PH)
    return [base + timedelta(hours=h) for h in range(days * 24)]


class DailyValueTests(unittest.TestCase):
    def setUp(self):
        # 6 days from 29 Jul: 1 mm/h every hour, except 5 mm/h on 1 Aug between 10:00 and 12:59 (all six models)
        self.axis = hourly_axis(date(2026, 7, 29), 6)
        rain = [5.0 if t.date() == START and 10 <= t.hour < 13 else 1.0 for t in self.axis]
        self.series = {"axis": self.axis, "models": [list(rain) for _ in MODELS], "best": rain, "soil": [0.3] * len(self.axis)}

    def test_windows(self):
        v = fh.daily_values(self.series, START)
        self.assertEqual(v["peak_24h_mm_h"], 5.0)
        self.assertEqual(v["peak_3h_mm"], 15.0)
        self.assertEqual(v["total_24h_mm"], 36.0)        # 21 x 1 + 3 x 5
        self.assertEqual(v["total_72h_mm"], 84.0)        # 30 Jul, 31 Jul (24 each) + 1 Aug (36)
        self.assertEqual(v["past_72h_mm"], 72.0)         # 29, 30, 31 Jul
        self.assertEqual(v["soil_moisture"], 0.3)
        self.assertIsNone(v["upstream_24h_mm"])

    def test_missing_hours_give_none_not_zero(self):
        empty = [None if t.date() == START else 1.0 for t in self.axis]
        series = {**self.series, "models": [list(empty) for _ in MODELS], "best": empty}
        v = fh.daily_values(series, START)
        self.assertIsNone(v["total_24h_mm"])
        self.assertIsNone(v["peak_24h_mm_h"])

    def test_upstream_is_the_wettest_high_ground_point(self):
        dry = {"axis": self.axis, "models": [[0.5] * len(self.axis) for _ in MODELS]}
        wet = {"axis": self.axis, "models": [[4.0] * len(self.axis) for _ in MODELS]}
        v = fh.daily_values(self.series, START, upstream=[dry, wet])
        self.assertEqual(v["upstream_24h_mm"], 96.0)


class BaselineTests(unittest.TestCase):
    def test_discharge_against_previous_30_days(self):
        days = [START - timedelta(days=k) for k in range(30, -1, -1)]
        flow = {"daily": {"time": [d.isoformat() for d in days], "river_discharge": [10.0] * 30 + [35.0]}}
        d = fh.daily_discharge(flow, START)
        self.assertEqual((d["ratio"], d["median_30d"], d["forecast_max"]), (3.5, 10.0, 35.0))
        self.assertIsNone(fh.daily_discharge(None, START)["ratio"])

    def test_tide_against_previous_daily_highs(self):
        highs = {START - timedelta(days=k): 1.0 + (k % 5) * 0.05 for k in range(1, 31)}
        highs[START] = 1.5
        tide = fh.daily_tide(highs, START)
        self.assertTrue(tide["high"])
        self.assertEqual(tide["peak_24h_m"], 1.5)
        highs[START] = 1.0
        self.assertFalse(fh.daily_tide(highs, START)["high"])


def fake_fetch(rain_mm=1.0):
    def fetch(start, end):
        first = start - timedelta(days=fh.ANTECEDENT_DAYS)
        days = (end - first).days + 1
        times = [t.strftime("%Y-%m-%dT%H:%M") for t in hourly_axis(first, days)]
        hourly = {"time": times, "precipitation_best_match": [rain_mm] * len(times),
                  "soil_moisture_0_to_10cm_best_match": [0.3] * len(times)}
        for m in MODELS:
            hourly[f"precipitation_{m}"] = [rain_mm] * len(times)
        names = list(MUNICIPALITIES)
        return {"names": names, "rain": [{"hourly": hourly}] * len(names), "flood": [None] * len(names), "marine": [None] * len(names)}
    return fetch


class BuildTests(unittest.TestCase):
    def test_build_history(self):
        h = fh.build_history(START, date(2026, 8, 5), fetcher=fake_fetch(1.0), static_loader=lambda: {"towns": {}}, today=date(2026, 10, 26))
        self.assertEqual(len(h["days"]), 5)
        town = h["municipalities"][0]
        self.assertEqual(len(town["days"]), 5)
        day = town["days"][0]
        self.assertEqual(day["rain_mm"], 24.0)
        # 24 mm/day: 72 h = 72 mm (< 150), past 72 h = 72 mm (+1); nothing else scores -> low
        self.assertEqual((day["level"], day["score"]), ("low", 1))
        self.assertIn("factors", day)
        self.assertEqual(town["summary"]["low"], 5)

    def test_heavy_days_become_events(self):
        h = fh.build_history(START, date(2026, 8, 3), fetcher=fake_fetch(9.0), static_loader=lambda: {"towns": {}}, today=date(2026, 10, 26))
        self.assertTrue(h["events"])
        self.assertIn(h["events"][0]["level"], ("high", "very_high"))

    def test_date_checks(self):
        with self.assertRaises(ValueError):
            fh.build_history(date(2026, 8, 5), date(2026, 8, 1), fetcher=fake_fetch(), today=date(2026, 10, 26))
        with self.assertRaises(ValueError):
            fh.build_history(date(2026, 1, 1), date(2026, 10, 1), fetcher=fake_fetch(), today=date(2026, 10, 26))
