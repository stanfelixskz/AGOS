import random
import unittest
from datetime import date, timedelta

from app.services import evidence_service as ev
from app.services import flood_model_service as fm


def make_record(years=8, seed=1, spikes=()):
    rnd = random.Random(seed)
    rain = {}
    d = date(2016, 1, 1)
    while d < date(2016 + years, 1, 1):
        rain[d.isoformat()] = rnd.random() * 6
        d += timedelta(days=1)
    for iso, mm in spikes:
        rain[iso] = mm
    return ev.TownRecord(rain, {})


def event(eid, start, town="A"):
    return {"id": eid, "start_date": start, "end_date": start,
            "towns": [{"municipality": town, "evidence": "flooded"}]}


class HelperTests(unittest.TestCase):
    def test_wilson_bounds(self):
        lo, hi = fm.wilson(8, 10)
        self.assertLess(lo, 0.8)
        self.assertGreater(hi, 0.8)
        self.assertIsNone(fm.wilson(0, 0))
        self.assertEqual(fm.wilson(0, 5)[0], 0.0)

    def test_episodes_merge_one_day_gap(self):
        base = date(2020, 1, 1).toordinal()
        self.assertEqual(fm.episodes([base, base + 1, base + 3, base + 10]), [(base, base + 3), (base + 10, base + 10)])


class ScoreTests(unittest.TestCase):
    def setUp(self):
        spikes = [("2018-09-09", 200.0), ("2020-08-05", 180.0), ("2022-07-20", 220.0), ("2017-05-05", 150.0)]
        self.rec = make_record(spikes=spikes)
        self.events = [event("e1", "2018-09-10"), event("e2", "2020-08-06"), event("e3", "2022-07-21")]

    def test_every_spike_caught_and_one_false_alarm(self):
        series, known, untestable = fm.build_series(self.events, {"A": self.rec})
        self.assertEqual((known, untestable), (3, 0))
        c = fm.score(series, 99.0, "rain")
        self.assertEqual(c["cases"], 3)
        self.assertEqual(c["caught"], 3)
        self.assertGreaterEqual(c["episodes"], 4)  # the unlisted 2017 spike is an extra episode
        self.assertEqual(c["hit_episodes"], 3)

    def test_event_outside_record_is_untestable(self):
        series, known, untestable = fm.build_series([event("old", "2005-01-01")], {"A": self.rec})
        self.assertEqual((known, untestable), (1, 1))

    def test_leave_one_year_out_runs_and_is_bounded(self):
        report = fm.model_report_from(self.events * 3, {"A": self.rec})  # repeated so enough cases
        loyo = report["rain"]["leave_one_year_out"]["result"]
        self.assertLessEqual(loyo["caught"], loyo["cases"])
        self.assertLessEqual(loyo["hit_episodes"], loyo["episodes"])

    def test_random_rain_gives_no_skill(self):
        # floods placed on random days of random rain must not be caught much more than chance
        rec = make_record(years=10, seed=7)
        rnd = random.Random(3)
        events = [event(f"r{i}", (date(2017, 6, 1) + timedelta(days=rnd.randrange(3000))).isoformat()) for i in range(40)]
        series, _, _ = fm.build_series(events, {"A": rec})
        c = fm.score(series, 95.0, "rain")
        self.assertLess(c["caught"] / c["cases"], 0.6)

    def test_too_few_cases_skips_validation(self):
        report = fm.model_report_from([event("e1", "2018-09-10")], {"A": self.rec})
        self.assertFalse(report["summary"]["enough_cases"])
        self.assertIsNone(report["rain"]["leave_one_year_out"])


if __name__ == "__main__":
    unittest.main()
