import unittest

from app.services import flood_watch_service as fw

RECORD = sorted(float(i) for i in range(1000))  # 3-day totals 0..999 mm


def daily(values, start_day=23):
    return [(f"2026-10-{start_day + i:02d}", v) for i, v in enumerate(values)]


class LevelTests(unittest.TestCase):
    def test_levels_follow_the_tested_thresholds(self):
        self.assertEqual(fw.level_for(99.5), "high_warning")
        self.assertEqual(fw.level_for(98.0), "warning")
        self.assertEqual(fw.level_for(96.0), "watch")
        self.assertEqual(fw.level_for(50.0), "normal")
        self.assertEqual(fw.level_for(None), "no_data")

    def test_windows_end_today_tomorrow_and_after(self):
        w = fw.three_day_windows(daily([1, 2, 3, 4, 5]), "2026-10-25")
        self.assertEqual([(x["end"], x["mm"]) for x in w], [("2026-10-25", 6), ("2026-10-26", 9), ("2026-10-27", 12)])

    def test_missing_day_never_counts_as_zero(self):
        w = fw.three_day_windows(daily([1, None, 3, 4, 5]), "2026-10-25")
        self.assertEqual([x["end"] for x in w], ["2026-10-27"])

    def test_peak_window_sets_the_level(self):
        res = fw.town_watch(daily([0, 0, 0, 990, 5]), RECORD, "2026-10-25")
        self.assertEqual(res["peak"]["mm"], 995)
        self.assertEqual(res["level"], "high_warning")
        self.assertEqual(fw.town_watch(daily([1, 1, 1, 1, 1]), RECORD, "2026-10-25")["level"], "normal")
        self.assertEqual(fw.town_watch(daily([1, 1, 1]), [], "2026-10-25")["level"], "no_data")


class BuildTests(unittest.TestCase):
    def test_build_sorts_by_level_and_adds_backing_and_floods(self):
        model = {"summary": {"town_years": 100}, "rain": {"table": [
            {"threshold": 98.0, "caught": 64, "cases": 104, "recall": 0.615, "recall_range": [0.52, 0.7], "episodes": 300},
        ]}}
        events = [{"start_date": "2026-09-07", "towns": [{"municipality": "B", "evidence": "flooded"}]},
                  {"start_date": "2020-01-01", "towns": [{"municipality": "B", "evidence": "road"}]}]
        out = fw.build_watch({"A": daily([1, 1, 1, 1, 1]), "B": daily([0, 0, 0, 985, 0])}, {"A": RECORD, "B": RECORD},
                             events, model, {"label": "x", "consistent": True}, "2026-10-25", "2026-10-25T23:00+08:00")
        self.assertEqual([t["name"] for t in out["towns"]], ["B", "A"])
        self.assertEqual(out["towns"][0]["level"], "warning")
        self.assertEqual((out["towns"][0]["listed_floods"], out["towns"][0]["latest"]), (1, "2026-09-07"))
        self.assertEqual(out["backing"]["warning"]["caught"], 64)
        self.assertEqual(out["backing"]["warning"]["alerts_per_town_year"], 3.0)
        self.assertIn("Not an official warning", out["notes"][0])

    def test_fetch_parses_one_request_for_all_towns(self):
        seen = {}

        def request(params):
            seen.update(params)
            return [{"daily": {"time": ["2026-10-25"], "precipitation_sum": [3.2]}}, {"daily": {"time": ["2026-10-25"], "precipitation_sum": [None]}}]

        out = fw.fetch_forecasts({"A": {"latitude": 1, "longitude": 2}, "B": {"latitude": 3, "longitude": 4}}, request)
        self.assertEqual(out["B"], [("2026-10-25", None)])
        self.assertEqual((seen["past_days"], seen["forecast_days"], seen["latitude"]), (2, 3, "1,3"))
        with self.assertRaises(RuntimeError):
            fw.fetch_forecasts({"A": {"latitude": 1, "longitude": 2}}, lambda p: [])


if __name__ == "__main__":
    unittest.main()
