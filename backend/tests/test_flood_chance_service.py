import unittest
from datetime import date, timedelta

from app.services import flood_chance_service as fc


def spell(start, peak, days=0):
    return {"start": start, "end": start + timedelta(days=days), "peak": peak}


class RainTests(unittest.TestCase):
    def test_rolling3_needs_all_three_days(self):
        out = fc.rolling3({"2020-08-01": 1.0, "2020-08-02": 2.0, "2020-08-03": 3.0, "2020-08-05": 4.0, "2020-08-04": None})
        self.assertEqual(out, {"2020-08-03": 6.0})

    def test_raised_days_use_the_highest_town_and_threshold(self):
        record = [float(i) for i in range(100)]
        towns = {"A": ({"2020-08-01": 99.0, "2020-08-02": 10.0}, record), "B": ({"2020-08-01": 96.0}, record), "C": ({"2020-08-01": 50.0}, [])}
        out = fc.raised_days(towns)
        self.assertEqual(out, {date(2020, 8, 1): 99.0})

    def test_spells_merge_days_two_apart(self):
        out = fc.spells({date(2020, 8, 1): 96.0, date(2020, 8, 3): 99.5, date(2020, 8, 6): 95.0, date(2020, 8, 20): 97.0})
        self.assertEqual([(s["start"], s["end"], s["peak"]) for s in out],
                         [(date(2020, 8, 1), date(2020, 8, 6), 99.5), (date(2020, 8, 20), date(2020, 8, 20), 97.0)])


class FloodTests(unittest.TestCase):
    def test_flood_days_skip_undated_article_dated_and_unflooded(self):
        events = [
            {"start_date": "2020-08-01", "towns": [{"evidence": "flooded"}]},
            {"start_date": "2020-08-01", "towns": [{"evidence": "flooded"}]},
            {"start_date": "2020-08-09", "towns": [{"evidence": "evacuation"}]},
            {"start_date": "2020-08-10", "date_basis": "article_date", "towns": [{"evidence": "flooded"}]},
            {"start_date": None, "towns": [{"evidence": "flooded"}]},
        ]
        self.assertEqual(fc.flood_start_days(events), [date(2020, 8, 1)])

    def test_window_is_one_day_before_to_two_days_after(self):
        s = spell(date(2020, 8, 10), 96, days=2)
        self.assertTrue(fc.ended_in_flood(s, [date(2020, 8, 9)]))
        self.assertTrue(fc.ended_in_flood(s, [date(2020, 8, 14)]))
        self.assertFalse(fc.ended_in_flood(s, [date(2020, 8, 8)]))
        self.assertFalse(fc.ended_in_flood(s, [date(2020, 8, 15)]))


class ConfidenceTests(unittest.TestCase):
    def test_too_few_spells_gives_no_rate(self):
        label, reasons = fc.confidence(9, 3)
        self.assertEqual(label, "none")
        self.assertIn("few_spells", reasons)

    def test_never_high_and_always_says_the_list_is_incomplete(self):
        label, reasons = fc.confidence(5000, 1000)
        self.assertEqual(label, "medium")
        self.assertIn("list_incomplete", reasons)
        self.assertIn("modeled_rain", reasons)

    def test_small_or_wide_samples_are_low(self):
        self.assertEqual(fc.confidence(20, 5)[0], "low")
        label, reasons = fc.confidence(35, 10)  # 35 spells, range about 0.17 to 0.44: wider than 0.30? no, 0.27 -> medium
        self.assertIn(label, ("low", "medium"))
        label, reasons = fc.confidence(30, 15)  # p=0.5 at n=30: range about 0.33 to 0.67 -> width 0.34
        self.assertEqual(label, "low")
        self.assertIn("wide_range", reasons)


class TableTests(unittest.TestCase):
    def test_levels_are_cumulative_and_rates_have_ranges(self):
        base = date(2015, 1, 1)
        # 20 spells: 10 at watch (96), 6 at warning (98.5), 4 at high_warning (99.5); floods follow 1 watch, 3 warning, 3 high
        peaks = [96.0] * 10 + [98.5] * 6 + [99.5] * 4
        spell_list = [spell(base + timedelta(days=20 * i), peak) for i, peak in enumerate(peaks)]
        flood_idx = [0] + [10, 11, 12] + [16, 17, 18]
        floods = [spell_list[i]["start"] for i in flood_idx]
        rows = {r["level"]: r for r in fc.level_rows(spell_list, floods)}
        self.assertEqual((rows["watch"]["spells"], rows["watch"]["floods"]), (20, 7))
        self.assertEqual((rows["warning"]["spells"], rows["warning"]["floods"]), (10, 6))
        self.assertEqual(rows["high_warning"]["spells"], 4)
        self.assertIsNone(rows["high_warning"]["rate"])  # fewer than 10 spells: no rate
        self.assertIsNone(rows["high_warning"]["range_95"])
        self.assertEqual(rows["watch"]["rate"], 0.35)
        low, high = rows["watch"]["range_95"]
        self.assertTrue(low < 0.35 < high)

    def test_report_from_records_stops_before_the_last_days_and_before_2011(self):
        daily = {}
        day = date(2010, 12, 1)
        while day <= date(2020, 12, 31):
            daily[day.isoformat()] = 0.0
            day += timedelta(days=1)
        for d in ("2010-12-10", "2015-08-10", "2020-12-30"):  # a 2010 spell (too early) and one in the last two days (too late)
            daily[d] = 400.0
        records = {"towns": {"A": {"daily": daily}}, "record": {"label": "test record"}}
        events = [{"start_date": "2015-08-11", "towns": [{"evidence": "flooded"}]}]
        out = fc.chance_from_records(records, events)
        self.assertEqual(out["from"], "2011-01-01")
        self.assertEqual(out["to"], "2020-12-29")
        self.assertEqual(out["spells_total"], 1)
        self.assertEqual(out["floods_used"], 1)
        self.assertEqual(out["rain_record"], "test record")
        self.assertTrue(out["not_a_forecast"])

    def test_no_record_gives_none(self):
        self.assertIsNone(fc.chance_from_records({"towns": {}}, []))
        self.assertIsNone(fc.chance_from_records({"towns": {"A": {"daily": {}}}}, []))

    def test_for_level(self):
        table = {"levels": [{"level": "watch", "spells": 20}, {"level": "warning", "spells": 10}]}
        self.assertEqual(fc.for_level(table, "warning")["spells"], 10)
        self.assertIsNone(fc.for_level(table, "normal"))
        self.assertIsNone(fc.for_level(None, "watch"))

    def test_agrees_with_the_command_line_tool(self):
        from tools import check_storm_adds_to_rain as tool

        record = [float(i) for i in range(100)]
        towns = {"A": ({"2020-08-01": 99.0, "2020-08-02": 96.0, "2020-08-09": 97.0}, record)}
        self.assertEqual({d: round(p, 6) for d, p in fc.raised_days(towns).items()}, {d: round(p, 6) for d, p in tool.raised_days(towns).items()})
        days = fc.raised_days(towns)
        self.assertEqual([(s["start"], s["end"], s["peak"]) for s in fc.spells(days)], [(s["start"], s["end"], s["peak"]) for s in tool.spells(days)])


if __name__ == "__main__":
    unittest.main()
