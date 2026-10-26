"""
Weather condition (icon) rules, day/night and the daily summary. No network.
"""

import unittest
from datetime import datetime, timedelta

from app.services import consensus_service as cs

PH = cs.PH_TZ


def cell(value, chance=None):
    return {"value": value, "chance": chance}


class ConditionTests(unittest.TestCase):
    def test_rules_in_order(self):
        no_votes = {"thunder": 0, "fog": 0}
        self.assertEqual(cs.condition(cell(3.0, 100), cell(90), {"thunder": 0.5, "fog": 0}), "thunder")
        self.assertEqual(cs.condition(cell(8.0, 100), cell(90), no_votes), "heavy_rain")
        self.assertEqual(cs.condition(cell(3.0, 100), cell(90), no_votes), "rain")
        self.assertEqual(cs.condition(cell(0.4, 67), cell(70), no_votes), "light_rain")
        self.assertEqual(cs.condition(cell(0.4, 33), cell(70), no_votes), "mostly_cloudy")  # most models dry
        self.assertEqual(cs.condition(cell(0.0, 0), cell(30), {"thunder": 0, "fog": 0.67}), "fog")
        self.assertEqual(cs.condition(cell(0.0, 0), cell(85), no_votes), "overcast")
        self.assertEqual(cs.condition(cell(0.0, 0), cell(30), no_votes), "partly_cloudy")
        self.assertEqual(cs.condition(cell(0.0, 0), cell(5), no_votes), "clear")
        self.assertEqual(cs.condition(cell(None), cell(None), no_votes), "unknown")

    def test_thunder_votes_need_rain(self):
        self.assertEqual(cs.condition(cell(0.0, 0), cell(10), {"thunder": 1.0, "fog": 0}), "clear")


class SunTests(unittest.TestCase):
    def test_day_and_night_in_balanga(self):
        lat, lon = 14.676, 120.536
        self.assertTrue(cs.is_day(lat, lon, datetime(2026, 10, 26, 12, 0, tzinfo=PH)))
        self.assertFalse(cs.is_day(lat, lon, datetime(2026, 10, 26, 0, 0, tzinfo=PH)))
        self.assertFalse(cs.is_day(lat, lon, datetime(2026, 10, 26, 19, 0, tzinfo=PH)))
        noon = cs.sun_elevation(lat, lon, datetime(2026, 6, 21, 12, 0, tzinfo=PH))
        self.assertGreater(noon, 75)  # near-overhead sun at the June solstice in the tropics


def series_for(day_rain, day_cloud=30.0, temps=(25.0, 32.0)):
    start = datetime(2026, 10, 26, 0, 0, tzinfo=PH)
    times = [start + timedelta(hours=i) for i in range(72)]
    rain = [{"value": day_rain[i // 24], "chance": 100 if day_rain[i // 24] > 0 else 0} for i in range(72)]
    cloud = [{"value": day_cloud} for _ in range(72)]
    temp = [{"value": temps[0] + (temps[1] - temps[0]) * (i % 24 >= 12)} for i in range(72)]
    codes = [{"thunder": 0, "fog": 0, "models": 6} for _ in range(72)]
    return {"times": times, "precipitation": rain, "cloud_cover": cloud, "temperature_2m": temp, "codes": codes}


class DailyTests(unittest.TestCase):
    def test_daily_summary(self):
        days = cs.daily_summary(series_for([0.0, 0.5, 9.0]), datetime(2026, 10, 26, 9, tzinfo=PH))
        self.assertEqual([d["condition"] for d in days], ["partly_cloudy", "light_rain", "heavy_rain"])
        self.assertEqual(days[1]["rain_total_mm"], 12.0)
        self.assertEqual((days[0]["temp_min"], days[0]["temp_max"]), (25.0, 32.0))
        self.assertEqual(days[2]["rain_chance_max"], 100)
