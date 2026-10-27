import importlib.util
import unittest
from datetime import date
from pathlib import Path

from app.services import tide_service as ts

TOOL = Path(__file__).resolve().parents[1] / "tools" / "check_spring_tide.py"


def event(start, evidence="flooded", basis=None):
    return {"start_date": start, "date_basis": basis, "towns": [{"municipality": "A", "evidence": evidence}]}


class MoonTests(unittest.TestCase):
    def test_reference_new_moon_is_a_spring_tide_day(self):
        info = ts.day_info(date(2000, 1, 6))
        self.assertTrue(info["spring"])
        self.assertEqual(info["moon"], "new")
        self.assertLess(info["days_from_moon"], 1.0)

    def test_half_a_month_later_is_full_moon(self):
        info = ts.day_info(date(2000, 1, 21))  # about 14.8 days after the reference new moon
        self.assertTrue(info["spring"])
        self.assertEqual(info["moon"], "full")

    def test_quarter_moon_is_not_a_spring_tide_day(self):
        info = ts.day_info(date(2000, 1, 14))  # first quarter, about 7.4 days from new and full
        self.assertFalse(info["spring"])
        self.assertGreater(info["days_from_moon"], 5)

    def test_share_expected_by_chance(self):
        self.assertAlmostEqual(ts.near_share(2.0), 0.27, places=2)
        self.assertEqual(ts.near_share(30), 1.0)


class CheckTests(unittest.TestCase):
    def test_counts_only_dated_flooded_events(self):
        events = [event("2000-01-06"), event("2000-01-14"), event("2000-01-06"),
                  event("2000-01-21", evidence="evacuation"), event("2000-01-06", basis="article_date"), {"towns": []}]
        out = ts.listed_flood_check(events)
        self.assertEqual((out["events"], out["near_spring"]), (2, 1))  # same day counts once
        self.assertEqual(out["share"], 0.5)
        self.assertEqual(out["expected_share_if_no_link"], 0.27)
        self.assertIsNotNone(out["p_value_one_sided"])

    def test_no_events_gives_no_share(self):
        out = ts.listed_flood_check([])
        self.assertEqual(out["events"], 0)
        self.assertIsNone(out["share"])
        self.assertIsNone(out["p_value_one_sided"])

    def test_build_tide_covers_the_rain_window_and_is_not_part_of_the_sign(self):
        out = ts.build_tide("2000-01-14", [])
        self.assertEqual(len(out["days"]), 5)
        self.assertEqual(out["days"][0]["date"], "2000-01-12")
        self.assertFalse(out["part_of_sign"])
        self.assertIn("not a tide gauge", out["source"])

    def test_spring_tide_in_window_flag(self):
        self.assertTrue(ts.build_tide("2000-01-06", [])["spring_in_window"])
        self.assertFalse(ts.build_tide("2000-01-14", [])["spring_in_window"])

    @unittest.skipUnless(TOOL.exists(), "check_spring_tide.py is on a separate branch")
    def test_agrees_with_the_command_line_tool(self):
        spec = importlib.util.spec_from_file_location("check_spring_tide", TOOL)
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        for d in (date(2011, 6, 9), date(2021, 7, 25), date(2026, 8, 8)):
            self.assertAlmostEqual(ts.days_from_syzygy(d), tool.days_from_syzygy(d), places=9)


if __name__ == "__main__":
    unittest.main()
