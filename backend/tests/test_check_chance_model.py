import math
import random
import unittest
from datetime import date, timedelta

from tools import check_chance_model as t


class MathTests(unittest.TestCase):
    def test_stretch_grows_with_rarity(self):
        self.assertAlmostEqual(t.stretch(95), -math.log(0.05), places=6)
        self.assertGreater(t.stretch(99), t.stretch(95))
        self.assertAlmostEqual(t.stretch(100), -math.log(0.001), places=6)

    def test_rolling_needs_every_day(self):
        daily = {date(2020, 1, d): float(d) for d in (1, 2, 3, 5)}
        self.assertEqual(t.rolling(daily, 3), {date(2020, 1, 3): 6.0})

    def test_auc_known_values(self):
        self.assertEqual(t.auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1.0)
        self.assertEqual(t.auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1]), 0.0)
        self.assertEqual(t.auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5)
        self.assertIsNone(t.auc([0.1, 0.2], [0, 0]))

    def test_solve_a_small_system(self):
        out = t.solve([[2.0, 1.0], [1.0, 3.0]], [5.0, 10.0])
        self.assertAlmostEqual(out[0], 1.0)
        self.assertAlmostEqual(out[1], 3.0)

    def test_fit_recovers_the_direction_of_a_real_effect(self):
        rng = random.Random(1)
        x, y = [], []
        for _ in range(3000):
            a, b = rng.gauss(0, 1), rng.gauss(0, 1)
            p = t.sigmoid(-2.0 + 1.5 * a + 0.0 * b)
            x.append([1.0, a, b])
            y.append(1 if rng.random() < p else 0)
        w = t.fit(x, y)
        self.assertGreater(w[1], 1.0)
        self.assertLess(abs(w[2]), 0.25)
        self.assertLess(abs(w[0] + 2.0), 0.4)


def synthetic_rows(real_effect: bool, seed=3, years=range(2011, 2026), per_year=160):
    rng = random.Random(seed)
    rows = []
    for year in years:
        for _ in range(per_year):
            rain, wet, noise = rng.gauss(3.5, 1), rng.gauss(0, 1), rng.gauss(0, 1)
            z = -3.0 + 0.8 * (rain - 3.5) + (1.2 * wet if real_effect else 0.0)
            rows.append({"town": "A", "day": date(year, 8, 1), "year": year, "rain": rain, "wet": wet, "ground": 0.0,
                         "tide": noise, "storm": 0.0, "y": 1 if rng.random() < t.sigmoid(z) else 0})
    return rows


class CompareTests(unittest.TestCase):
    MODELS = {"rain only": [], "rain + wet ground": ["wet"], "rain + spring tide": ["tide"]}

    def test_a_real_factor_improves_held_out_scores_and_noise_does_not(self):
        res = {r["model"]: r for r in t.compare(synthetic_rows(True), self.MODELS)}
        self.assertLess(res["rain + wet ground"]["delta_log_loss"], -0.01)
        self.assertGreater(res["rain + wet ground"]["auc"], res["rain only"]["auc"])
        self.assertGreater(res["rain + wet ground"]["flood_years_better"], res["rain + wet ground"]["flood_years_worse"])
        self.assertGreater(res["rain + spring tide"]["delta_log_loss"], -0.005)  # pure noise gains nothing

    def test_no_real_effect_means_no_gain(self):
        res = {r["model"]: r for r in t.compare(synthetic_rows(False), self.MODELS)}
        self.assertGreater(res["rain + wet ground"]["delta_log_loss"], -0.005)

    def test_calibration_bins_cover_all_rows(self):
        base = t.cross_validate(synthetic_rows(True), [])
        bins = t.calibration(base["preds"], base["ys"])
        self.assertEqual(sum(b["rows"] for b in bins), len(base["ys"]))
        for b in bins:
            self.assertLessEqual(abs(b["predicted"] - b["observed"]), 0.1)


class BandTests(unittest.TestCase):
    def test_bands_split_held_out_rows_by_score_and_count_distinct_cases(self):
        rows = synthetic_rows(True)
        for i, r in enumerate(rows):
            r["flood"] = date(r["year"], 8, 1 + (i % 20)) if r["y"] else None
        res = t.cross_validate(rows, ["wet"])
        out = t.bands(res)
        self.assertEqual(sum(b["rows"] for b in out), len(res["ys"]))
        self.assertEqual(len(out), 4)
        self.assertLessEqual(out[0]["observed"], out[-1]["observed"])  # a real factor: higher score, more floods
        self.assertLessEqual(sum(b["flood_cases"] for b in out), res["positives"] if "positives" in res else sum(res["ys"]))
        for b in out:
            self.assertLessEqual(b["flood_cases"], max(1, b["rows"]))
            self.assertLessEqual(b["case_range_95"][0], b["case_range_95"][1])

    def test_cross_validate_keeps_the_held_out_rows_in_order(self):
        res = t.cross_validate(synthetic_rows(True, years=range(2011, 2016), per_year=50), [])
        self.assertEqual(len(res["used"]), len(res["preds"]))
        self.assertEqual([r["y"] for r in res["used"]], res["ys"])


class RowTests(unittest.TestCase):
    def test_rows_keep_only_unusual_incoming_rain_and_mark_floods_in_the_window(self):
        daily = {}
        d = date(2012, 1, 1)
        while d <= date(2014, 12, 31):
            daily[d] = 0.0
            d += timedelta(days=1)
        for k in range(3):
            daily[date(2013, 8, 10) + timedelta(days=k)] = 150.0  # a big 3-day rain
        floods = {"A": [date(2013, 8, 11)]}
        rows = t.build_rows({"A": daily}, floods, {"A": 0.2}, lambda d: False, lambda d: False, first=date(2012, 3, 1))
        self.assertTrue(rows)
        self.assertTrue(all(r["rain"] >= t.stretch(90) for r in rows))
        self.assertTrue(all(r["ground"] == 0.2 for r in rows))
        flooded = [r for r in rows if r["y"]]
        self.assertTrue(flooded)
        self.assertTrue(all(r["flood"] == date(2013, 8, 11) for r in flooded))
        self.assertTrue(all(r["flood"] is None for r in rows if not r["y"]))
        for r in flooded:
            self.assertTrue(r["day"] <= date(2013, 8, 11) <= r["day"] + timedelta(days=3))

    def test_flood_town_days_skip_article_dated_events(self):
        got = t.flood_town_days()
        self.assertTrue(got)
        for days in got.values():
            self.assertEqual(days, sorted(set(days)))


class MainTests(unittest.TestCase):
    def test_unreadable_database_says_so_and_calculates_nothing(self):
        from contextlib import redirect_stdout
        from io import StringIO
        from unittest import mock

        buffer = StringIO()
        with mock.patch.object(t, "load_inputs", side_effect=OSError("no database")), redirect_stdout(buffer):
            code = t.main(["x"])
        self.assertEqual(code, 2)
        self.assertIn("Nothing was calculated", buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
