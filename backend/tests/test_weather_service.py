"""Tests for weather_service helpers (no network)."""

import unittest
from datetime import datetime, timedelta
from unittest import mock
from zoneinfo import ZoneInfo

from app.services import weather_service


class LocationTests(unittest.TestCase):
    def test_known_municipality_is_case_insensitive(self):
        name, coordinates = weather_service._get_location("  balanga ")
        self.assertEqual(name, "Balanga")
        self.assertAlmostEqual(coordinates["latitude"], 14.6760)

    def test_all_twelve_municipalities_have_coordinates(self):
        from app.data.municipalities import MUNICIPALITIES

        self.assertEqual(len(MUNICIPALITIES), 12)
        for name, point in MUNICIPALITIES.items():
            with self.subTest(name=name):
                self.assertTrue(14.3 < point["latitude"] < 15.0)
                self.assertTrue(120.1 < point["longitude"] < 120.8)

    def test_unknown_or_empty_municipality_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unknown municipality"):
            weather_service._get_location("Manila")
        with self.assertRaises(ValueError):
            weather_service._get_location("   ")


class ForecastTimeTests(unittest.TestCase):
    NOW = datetime(2026, 10, 24, 14, 30, tzinfo=ZoneInfo("Asia/Manila"))

    def validate(self, *args):
        with mock.patch.object(weather_service, "_now_local", return_value=self.NOW):
            return weather_service._validate_forecast_time(*args)

    def test_today_future_hour_is_accepted(self):
        day, hour = self.validate("2026-10-24", 15)
        self.assertEqual(day.isoformat(), "2026-10-24")
        self.assertEqual(hour, 15)

    def test_past_date_and_past_hour_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "past"):
            self.validate("2026-10-23")
        with self.assertRaisesRegex(ValueError, "past"):
            self.validate("2026-10-24", 9)

    def test_window_is_fifteen_days(self):
        last = (self.NOW.date() + timedelta(days=15)).isoformat()
        self.validate(last)
        too_far = (self.NOW.date() + timedelta(days=16)).isoformat()
        with self.assertRaisesRegex(ValueError, "15-day"):
            self.validate(too_far)

    def test_bad_inputs_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "YYYY-MM-DD"):
            self.validate("24/10/2026")
        with self.assertRaisesRegex(ValueError, "0 to 23"):
            self.validate("2026-10-25", 24)
        with self.assertRaisesRegex(ValueError, "0 to 23"):
            self.validate("2026-10-25", True)


if __name__ == "__main__":
    unittest.main()
