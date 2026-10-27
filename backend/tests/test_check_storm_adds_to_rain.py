import unittest
from datetime import date, timedelta

from tools import check_storm_adds_to_rain as t


def spell(start, end, peak=96.0):
    return {"start": start, "end": end, "peak": peak}


class RainDayTests(unittest.TestCase):
    def test_percentile_matches_the_sign_definition(self):
        self.assertEqual(t.percentile_in(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 40.0)  # 4 of 10 strictly lower
        self.assertIsNone(t.percentile_in(5, []))

    def test_raised_days_take_the_highest_town(self):
        sorted_a = [float(i) for i in range(100)]
        towns = {"A": ({"2020-08-01": 99.0, "2020-08-02": 10.0}, sorted_a), "B": ({"2020-08-01": 96.0}, sorted_a)}
        out = t.raised_days(towns)
        self.assertEqual(list(out), [date(2020, 8, 1)])
        self.assertEqual(out[date(2020, 8, 1)], 99.0)

    def test_spells_merge_days_up_to_two_days_apart(self):
        days = {date(2020, 8, 1): 96.0, date(2020, 8, 3): 99.5, date(2020, 8, 6): 95.0, date(2020, 8, 20): 97.0}
        out = t.spells(days)
        self.assertEqual([(s["start"], s["end"]) for s in out],
                         [(date(2020, 8, 1), date(2020, 8, 6)), (date(2020, 8, 20), date(2020, 8, 20))])
        self.assertEqual(out[0]["peak"], 99.5)


class OutcomeTests(unittest.TestCase):
    def test_flood_window_runs_from_one_day_before_to_two_days_after(self):
        s = spell(date(2020, 8, 10), date(2020, 8, 12))
        self.assertTrue(t.ends_in_flood(s, [date(2020, 8, 9)]))
        self.assertTrue(t.ends_in_flood(s, [date(2020, 8, 14)]))
        self.assertFalse(t.ends_in_flood(s, [date(2020, 8, 8)]))
        self.assertFalse(t.ends_in_flood(s, [date(2020, 8, 15)]))
        self.assertFalse(t.ends_in_flood(s, []))

    def test_storm_window_runs_from_two_days_before_to_one_day_after(self):
        s = spell(date(2020, 8, 10), date(2020, 8, 12))
        near = {date(2020, 8, 8): (400.0, "A"), date(2020, 8, 13): (200.0, "B")}
        self.assertEqual(t.storm_distance(s, near), (200.0, "B"))
        self.assertIsNone(t.storm_distance(s, {date(2020, 8, 7): (1.0, "C"), date(2020, 8, 14): (1.0, "D")}))


class StatsTests(unittest.TestCase):
    def test_fisher_known_values(self):
        self.assertAlmostEqual(t.fisher_upper(3, 0, 0, 3), 1 / 20, places=6)  # all three flood spells have the storm
        self.assertAlmostEqual(t.fisher_upper(1, 1, 1, 1), 5 / 6, places=6)
        self.assertEqual(t.fisher_upper(0, 3, 3, 0), 1.0)

    def test_mantel_haenszel_single_table_matches_the_odds_ratio(self):
        out = t.mantel_haenszel([(10, 10, 5, 20)])
        self.assertAlmostEqual(out["odds_ratio"], (10 * 20) / (10 * 5), places=2)
        self.assertTrue(out["more_floods_with_storm"])
        self.assertLess(out["p_two_sided"], 0.05)

    def test_mantel_haenszel_no_difference(self):
        out = t.mantel_haenszel([(5, 15, 5, 15), (2, 8, 2, 8)])
        self.assertEqual(out["odds_ratio"], 1.0)
        self.assertEqual(out["p_two_sided"], 1.0)

    def test_empty_tables_are_safe(self):
        out = t.mantel_haenszel([(0, 0, 0, 0)])
        self.assertIsNone(out["odds_ratio"])
        self.assertIsNone(out["p_two_sided"])

    def test_analyse_counts_cells_and_strata(self):
        base = date(2020, 8, 1)
        spells_ = [spell(base + timedelta(days=30 * i), base + timedelta(days=30 * i), peak=99.5 if i % 2 else 96.0) for i in range(8)]
        # floods in spells 0, 1 and 4; storms near spells 0, 1, 2, 3
        floods = [spells_[i]["start"] for i in (0, 1, 4)]
        nearest = {spells_[i]["start"]: (250.0, "S") for i in (0, 1, 2, 3)}
        row = t.analyse(spells_, floods, nearest, radii=(300,))[0]
        self.assertEqual((row["storm_spells"], row["storm_floods"]), (4, 2))
        self.assertEqual((row["no_storm_spells"], row["no_storm_floods"]), (4, 1))
        self.assertEqual(row["storm_rate"], 0.5)
        self.assertEqual(row["no_storm_rate"], 0.25)
        self.assertEqual(row["spells"], 8)
        self.assertIn("odds_ratio", row["adjusted_for_rain_strength"])

    def test_a_storm_beyond_the_radius_does_not_count(self):
        s = [spell(date(2020, 8, 1), date(2020, 8, 1))]
        row = t.analyse(s, [date(2020, 8, 1)], {date(2020, 8, 1): (900.0, "S")}, radii=(500, 1000))
        self.assertEqual(row[0]["storm_spells"], 0)
        self.assertEqual(row[1]["storm_spells"], 1)


class MainTests(unittest.TestCase):
    def test_missing_track_file_says_so_and_calculates_nothing(self):
        from contextlib import redirect_stdout
        from io import StringIO

        buffer = StringIO()
        with redirect_stdout(buffer):
            code = t.main(["x", "/no/such/file.csv"])
        self.assertEqual(code, 2)
        self.assertIn("Nothing was calculated", buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
