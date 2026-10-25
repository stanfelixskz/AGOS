import contextlib
import sqlite3
import unittest
from datetime import date, timedelta

from app.services import evidence_service as ev

POINT = {"latitude": 14.5, "longitude": 120.5}


def record_with(days=400, base=1.0, spikes=None, flow=None):
    """`days` days from 2020-01-01 at `base` mm, with {iso_date: mm} spikes."""
    rain = {}
    d = date(2020, 1, 1)
    for _ in range(days):
        rain[d.isoformat()] = base
        d += timedelta(days=1)
    rain.update(spikes or {})
    return ev.TownRecord(rain, flow or {})


def flood(eid, start, end=None, towns=("A",), evidence="flooded"):
    return {"id": eid, "start_date": start, "end_date": end or start, "confidence": "high",
            "towns": [{"municipality": t, "evidence": evidence} for t in towns], "sources": []}


class HelperTests(unittest.TestCase):
    def test_rolling_sums_need_every_day(self):
        sums = ev.rolling_sums({"2020-01-01": 1, "2020-01-02": 2, "2020-01-03": 3, "2020-01-05": 9}, 3)
        self.assertEqual(sums, {"2020-01-03": 6})

    def test_percentile_and_threshold(self):
        values = sorted(range(100))
        self.assertEqual(ev.percentile_of(50, values), 50.0)
        self.assertEqual(ev.percentile_of(1000, values), 100.0)
        self.assertTrue(ev.in_top(99, values))
        self.assertFalse(ev.in_top(94, values))
        self.assertFalse(ev.in_top(3.0, [3.0] * 100))  # ties at the top never count


class CaseTests(unittest.TestCase):
    def test_spike_before_flood_is_found_and_ranked_top(self):
        rec = record_with(spikes={"2020-06-09": 150.0})
        m = ev.case_metrics(rec, date(2020, 6, 10), date(2020, 6, 10))
        self.assertEqual(m["status"], "ok")
        self.assertEqual(m["window"], ["2020-06-08", "2020-06-10"])
        self.assertEqual((m["max_1day_mm"], m["max_1day_date"]), (150.0, "2020-06-09"))
        self.assertEqual(m["max_3day_mm"], 152.0)
        self.assertTrue(m["top5_3day"])
        self.assertGreaterEqual(m["max_3day_percentile"], 99)
        self.assertEqual(m["total_7day_mm"], 156.0)

    def test_outside_record_and_missing_day(self):
        rec = record_with()
        self.assertEqual(ev.case_metrics(rec, date(2010, 1, 1), date(2010, 1, 1))["status"], "outside_record")
        gap = dict(rec.rain)
        del gap["2020-03-02"]
        self.assertEqual(ev.case_metrics(ev.TownRecord(gap, {}), date(2020, 3, 3), date(2020, 3, 3))["status"], "incomplete")

    def test_flow_percentile_when_flow_exists(self):
        flow = {(date(2020, 1, 1) + timedelta(days=i)).isoformat(): float(i) for i in range(400)}
        rec = record_with(flow=flow)
        m = ev.case_metrics(rec, date(2020, 12, 30), date(2020, 12, 30))
        self.assertIn("max_flow_percentile", m)
        self.assertNotIn("max_flow_percentile", ev.case_metrics(record_with(), date(2020, 6, 10), date(2020, 6, 10)))

    def test_baseline_counts_windows_reaching_top5(self):
        # one 3-day spike: windows of length 3 that include it are rare
        rec = record_with(spikes={"2020-06-09": 150.0})
        b = rec.baseline(3)
        self.assertGreater(b, 0)
        self.assertLess(b, 0.1)


class SeasonTests(unittest.TestCase):
    def test_random_rain_with_a_wet_season_matches_chance(self):
        """Fake floods on random wet-season days must NOT look unusual against the season-matched baseline."""
        import random
        rng = random.Random(5)
        rain, d = {}, date(2015, 1, 1)
        while d <= date(2025, 12, 31):
            wet = d.month in (6, 7, 8, 9, 10)
            rain[d.isoformat()] = rng.expovariate(1 / (12 if wet else 1.5)) if rng.random() < (0.6 if wet else 0.15) else 0.0
            d += timedelta(days=1)
        rec = ev.TownRecord(rain, {})
        days = [date(y, m, dd) for y in range(2015, 2026) for m in (7, 8, 9) for dd in (5, 20)]
        out = ev.evidence([flood(f"e{i}", x.isoformat()) for i, x in enumerate(days)], {"A": rec})
        s = out["summary"]
        self.assertLess(abs(s["share_top5"] - s["chance_top5"]), 0.08)
        whole_year = rec.baseline(3)
        self.assertGreater(s["chance_top5"], whole_year)  # the wet season is wetter than the whole year


class EvidenceTests(unittest.TestCase):
    def test_summary_compares_with_chance(self):
        rec = record_with(spikes={"2020-06-09": 150.0, "2020-09-01": 120.0})
        events = [
            flood("wet", "2020-06-10"),
            flood("dry", "2020-03-10"),
            flood("old", "2010-01-01"),
            flood("nodate", None),
            flood("roadonly", "2020-09-02", evidence="road"),
        ]
        events[3]["end_date"] = None
        out = ev.evidence(events, {"A": rec})
        s = out["summary"]
        self.assertEqual(s["events"], 5)
        self.assertEqual(s["events_dated"], 4)
        self.assertEqual(s["cases"], 2)               # wet + dry; road-only not tested; old outside record
        self.assertEqual(s["cases_top5"], 1)
        self.assertEqual(s["share_top5"], 0.5)
        self.assertEqual(s["cases_outside_record"], 1)
        self.assertIsNotNone(s["chance_top5"])
        self.assertEqual(out["skipped"], [{"id": "nodate", "reason": "no date"}])
        self.assertEqual(out["events"][0]["id"], "roadonly")  # newest first

    def test_report_reads_database(self):
        with contextlib.closing(sqlite3.connect(":memory:")) as db:
            db.execute("CREATE TABLE observations (source, variable, observed_at, latitude, longitude, value, unit, quality_flag, fetched_at)")
            d = date(2020, 1, 1)
            rows = []
            for i in range(60):
                day = (d + timedelta(days=i)).isoformat()
                rows.append(("open_meteo_archive", "precipitation_sum", day, 14.5, 120.5, 80.0 if i == 30 else 1.0, "mm", "valid", "x"))
                rows.append(("open_meteo_glofas", "river_discharge", day, 14.5, 120.5, float(i), "m3/s", "valid", "x"))
            db.executemany("INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?)", rows)
            out = ev.evidence_report(connect=lambda: _NoClose(db), municipalities={"A": POINT},
                                     events=[flood("e", "2020-02-01")])
            case = out["events"][0]["towns"][0]
            self.assertEqual(case["max_1day_mm"], 80.0)
            self.assertIn("max_flow_percentile", case)


class _NoClose:
    """Wraps a connection so the report's close() does not close the shared in-memory db."""

    def __init__(self, db):
        self.db = db

    def execute(self, *a):
        return self.db.execute(*a)

    def close(self):
        pass


if __name__ == "__main__":
    unittest.main()
