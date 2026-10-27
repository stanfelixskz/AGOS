import importlib.util
import unittest
from datetime import date
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("check_spring_tide", Path(__file__).resolve().parents[1] / "tools" / "check_spring_tide.py")
cst = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cst)


class MoonTests(unittest.TestCase):
    def test_known_new_and_full_moons_are_near_zero(self):
        for day in (date(2000, 1, 6), date(2000, 1, 21), date(2024, 4, 8), date(2024, 4, 24)):  # new, full, eclipse new, full
            self.assertLess(cst.days_from_syzygy(day), 1.5, day)

    def test_quarter_moon_is_far_from_spring_tide(self):
        self.assertGreater(cst.days_from_syzygy(date(2000, 1, 14)), 6.0)  # first quarter

    def test_window_share_and_ranges(self):
        self.assertAlmostEqual(cst.near_share(2), 0.271, places=2)
        low, high = cst.wilson(7, 24)
        self.assertLess(low, 7 / 24)
        self.assertGreater(high, 7 / 24)
        self.assertEqual(cst.wilson(0, 0), (0.0, 1.0))
        self.assertAlmostEqual(cst.binom_upper_tail(0, 5, 0.3), 1.0)

    def test_flood_list_gives_one_count_per_dated_event(self):
        days = cst.flood_days()
        self.assertGreater(len(days), 10)
        self.assertEqual(days, sorted(set(days)))
        result = cst.analyse(days)
        self.assertEqual(result["events"], len(days))


if __name__ == "__main__":
    unittest.main()
