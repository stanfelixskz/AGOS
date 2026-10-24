"""Tests for the overview / municipality detail service (no network)."""

import json
import tempfile
import unittest
from pathlib import Path

from app.services import overview_service as ov

MUNIS = {
    "Balanga": {"latitude": 14.6760, "longitude": 120.5363},
    "Hermosa": {"latitude": 14.8319, "longitude": 120.5087},
}


def outlook(series_by_name):
    return {
        "generated_at": "2026-09-07T10:00:00+08:00",
        "timezone": "Asia/Manila",
        "hours_requested": 48,
        "source": "Open-Meteo Forecast API",
        "time_steps": [],
        "limitations": ["Point forecast."],
        "municipalities": [
            {
                "municipality": name,
                "requested_coordinates": MUNIS[name],
                "model_coordinates": MUNIS[name],
                "points": [
                    {"time": f"2026-09-07T{10 + i:02d}:00", "precipitation_mm": v,
                     "precipitation_probability_percent": 50}
                    for i, v in enumerate(values)
                ],
            }
            for name, values in series_by_name.items()
        ],
    }


class LevelTests(unittest.TestCase):
    def test_thresholds_match_pagasa_intensity_criteria(self):
        cases = [
            (None, "nodata"), ("3", "nodata"), (True, "nodata"), (float("nan"), "nodata"),
            (0, "little"), (0.99, "little"), (1, "rain"), (7.49, "rain"),
            (7.5, "yellow"), (14.9, "yellow"), (15, "orange"), (30, "orange"),
            (30.01, "red"), (120, "red"),
        ]
        for value, expected in cases:
            with self.subTest(value=value):
                self.assertEqual(ov.rain_level(value), expected)


class OverviewTests(unittest.TestCase):
    def test_windows_totals_and_peaks(self):
        data = ov.build_overview(outlook({"Balanga": [0, 2, 16, 1, 0, 0, 40], "Hermosa": [0] * 7}))
        balanga = data["municipalities"][0]
        six = balanga["windows"]["next_6h"]
        self.assertEqual(six["total_mm"], 19.0)
        self.assertEqual(six["peak_mm_h"], 16.0)
        self.assertEqual(six["peak_time"], "2026-09-07T12:00")
        self.assertEqual(six["level"], "orange")
        self.assertEqual(balanga["level_24h"], "red")  # the 7th hour is 40 mm/h
        self.assertEqual(data["highest_level_24h"], "red")
        self.assertEqual(data["ranking_24h"], ["Balanga", "Hermosa"])
        self.assertEqual(balanga["series"][2]["level"], "orange")

    def test_missing_values_stay_missing(self):
        data = ov.build_overview(outlook({"Balanga": [None, None], "Hermosa": [None, 3]}))
        balanga, hermosa = data["municipalities"]
        self.assertIsNone(balanga["windows"]["next_24h"]["total_mm"])
        self.assertEqual(balanga["level_24h"], "nodata")
        self.assertIsNone(balanga["series"][0]["precipitation_mm"])
        self.assertEqual(hermosa["windows"]["next_24h"]["hours_with_data"], 1)
        self.assertEqual(hermosa["windows"]["next_24h"]["total_mm"], 3.0)

    def test_notes_say_not_official(self):
        data = ov.build_overview(outlook({"Balanga": [0]}))
        self.assertIn("not official PAGASA warnings", data["notes"][0])


class EvacuationTests(unittest.TestCase):
    def test_repo_file_loads_and_every_center_is_unverified(self):
        data = ov.load_evacuation_centers()
        self.assertGreaterEqual(data["count"], 1)
        for center in data["centers"]:
            self.assertEqual(center["verification"], "unverified")
            self.assertIn("has_coordinates", center)

    def test_bad_coordinates_are_not_mapped(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "c.json"
            path.write_text(json.dumps({"centers": [
                {"id": "A", "name": "A", "municipality": "Balanga", "latitude": 999, "longitude": 120},
                {"id": "B", "name": "B", "municipality": "Balanga", "latitude": None, "longitude": None},
            ]}))
            data = ov.load_evacuation_centers(path)
        self.assertFalse(any(c["has_coordinates"] for c in data["centers"]))
        self.assertIsNone(data["centers"][0]["latitude"])

    def test_same_municipality_first_then_nearest(self):
        centers = [
            {"id": "far", "municipality": "Mariveles", "has_coordinates": True, "latitude": 14.43, "longitude": 120.48},
            {"id": "near", "municipality": "Pilar", "has_coordinates": True, "latitude": 14.66, "longitude": 120.56},
            {"id": "home", "municipality": "Balanga", "has_coordinates": True, "latitude": 14.70, "longitude": 120.50},
        ]
        rows = ov.centers_for_municipality(centers, "balanga", MUNIS["Balanga"])
        self.assertEqual([r["id"] for r in rows], ["home", "near", "far"])
        self.assertIsNotNone(rows[1]["distance_km_from_town_point"])


class DetailTests(unittest.TestCase):
    def detail(self, **overrides):
        kwargs = dict(
            municipalities=MUNIS,
            get_current=lambda name: {"municipality": name, "temperature_c": 28},
            get_outlook=lambda hours: outlook({"Balanga": [1, 2], "Hermosa": [0, 0]}),
            get_discharge=lambda days: {"municipalities": [{"municipality": "Balanga", "status": "available", "daily": [{"date": "2026-09-07", "river_discharge": 4.2}]}]},
            get_centers=lambda: {"note": "n", "centers": []},
        )
        kwargs.update(overrides)
        return ov.municipality_detail("balanga", **kwargs)

    def test_case_insensitive_name_and_all_sections(self):
        data = self.detail()
        self.assertEqual(data["name"], "Balanga")
        for key in ("current_weather", "rain", "river_discharge", "evacuation_centers"):
            self.assertEqual(data[key]["status"], "ok", key)
        self.assertEqual(data["rain"]["data"]["windows"]["next_6h"]["total_mm"], 3.0)
        self.assertEqual(data["river_discharge"]["data"]["daily"][0]["river_discharge"], 4.2)
        self.assertEqual(data["susceptibility"]["status"], "not_available")

    def test_one_failing_source_does_not_hide_the_others(self):
        def boom(_):
            raise RuntimeError("Open-Meteo timed out")
        data = self.detail(get_current=boom)
        self.assertEqual(data["current_weather"]["status"], "unavailable")
        self.assertIn("timed out", data["current_weather"]["detail"])
        self.assertEqual(data["rain"]["status"], "ok")

    def test_unknown_municipality(self):
        with self.assertRaises(ValueError):
            ov.municipality_detail("Atlantis", municipalities=MUNIS, get_current=None,
                                   get_outlook=None, get_discharge=None, get_centers=None)


if __name__ == "__main__":
    unittest.main()
