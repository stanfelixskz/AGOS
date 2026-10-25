import contextlib
import sqlite3
import unittest
from datetime import date

from app.services import backfill_service as bf

TOWNS = {"A": {"latitude": 14.1, "longitude": 120.1}, "B": {"latitude": 14.2, "longitude": 120.2}}
TODAY = date(2026, 10, 25)


class PlanTests(unittest.TestCase):
    def test_year_chunks_newest_first_and_current_year_partial(self):
        chunks = bf.year_chunks(2024, date(2026, 10, 18))
        self.assertEqual([c[0].year for c in chunks], [2026, 2025, 2024])
        self.assertEqual(chunks[0], (date(2026, 1, 1), date(2026, 10, 18)))
        self.assertEqual(chunks[1], (date(2025, 1, 1), date(2025, 12, 31)))

    def test_plan_skips_done_and_respects_glofas_start(self):
        done = {("open_meteo_archive", 14.1, 120.1, "2025-01-01", "2025-12-31")}
        todo = bf.plan(TOWNS, bf.SOURCES, 1983, TODAY, done)
        self.assertNotIn(("A", "open_meteo_archive", date(2025, 1, 1), date(2025, 12, 31)), todo)
        self.assertIn(("B", "open_meteo_archive", date(2025, 1, 1), date(2025, 12, 31)), todo)
        self.assertTrue(all(s != "open_meteo_glofas" or st.year >= 1984 for _, s, st, _ in todo))
        self.assertTrue(any(s == "open_meteo_archive" and st.year == 1983 for _, s, st, _ in todo))
        self.assertEqual(todo[0][2].year, 2026)

    def test_completed_runs_ignores_errors_but_keeps_empty_successes(self):
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE ingest_runs (source, latitude, longitude, start_date, end_date, status, records_received)")
        db.executemany("INSERT INTO ingest_runs VALUES (?,?,?,?,?,?,?)", [
            ("s", 1.0, 2.0, "2020-01-01", "2020-12-31", "success", 366),
            ("s", 1.0, 2.0, "2021-01-01", "2021-12-31", "error", 0),
            ("s", 1.0, 2.0, "2022-01-01", "2022-12-31", "success", 0),
        ])
        self.assertEqual(bf.completed_runs(db), {
            ("s", 1.0, 2.0, "2020-01-01", "2020-12-31"),
            ("s", 1.0, 2.0, "2022-01-01", "2022-12-31"),
        })
        self.assertEqual(bf.completed_runs(sqlite3.connect(":memory:")), set())


class ErrorTests(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(bf.classify_error("Open-Meteo returned HTTP 429: Minutely API request limit exceeded"), "minute")
        self.assertEqual(bf.classify_error("Daily API request limit exceeded"), "limit")
        self.assertEqual(bf.classify_error("Hourly API request limit exceeded"), "limit")
        self.assertEqual(bf.classify_error("Could not reach Open-Meteo"), "other")


class RunTests(unittest.TestCase):
    def _todo(self):
        return bf.plan(TOWNS, ["open_meteo_archive"], 2025, TODAY, set())

    def test_runs_all_and_counts(self):
        calls = []

        def ok(**kw):
            calls.append(kw)
            return {"records_upserted": 10}

        out = bf.run_backfill(self._todo(), TOWNS, {"open_meteo_archive": ok}, sleep=lambda s: None)
        self.assertEqual(out["succeeded"], 4)
        self.assertEqual(out["records_upserted"], 40)
        self.assertIsNone(out["stopped"])

    def test_minute_limit_waits_then_retries(self):
        waits, state = [], {"n": 0}

        def flaky(**kw):
            state["n"] += 1
            if state["n"] == 1:
                raise RuntimeError("HTTP 429: Minutely API request limit exceeded")
            return {"records_upserted": 1}

        out = bf.run_backfill(self._todo()[:1], TOWNS, {"open_meteo_archive": flaky}, sleep=waits.append, pause_s=0)
        self.assertEqual(out["succeeded"], 1)
        self.assertIn(65.0, waits)

    def test_daily_limit_stops_cleanly(self):
        def limited(**kw):
            raise RuntimeError("Daily API request limit exceeded")

        out = bf.run_backfill(self._todo(), TOWNS, {"open_meteo_archive": limited}, sleep=lambda s: None)
        self.assertIn("limit", out["stopped"])
        self.assertEqual(out["succeeded"], 0)

    def test_failure_does_not_stop_others_and_max_requests(self):
        def sometimes(**kw):
            if kw["latitude"] == 14.1:
                raise RuntimeError("boom")
            return {"records_upserted": 2}

        out = bf.run_backfill(self._todo(), TOWNS, {"open_meteo_archive": sometimes}, sleep=lambda s: None)
        self.assertEqual((out["succeeded"], out["failed"]), (2, 2))
        out2 = bf.run_backfill(self._todo(), TOWNS, {"open_meteo_archive": lambda **k: {}}, sleep=lambda s: None, max_requests=1)
        self.assertEqual(out2["succeeded"], 1)
        self.assertIn("max-requests", out2["stopped"])

    def test_estimate_and_coverage(self):
        info = bf.estimate(self._todo(), 8.0)
        self.assertEqual(info["requests"], 4)
        with contextlib.closing(sqlite3.connect(":memory:")) as db:
            self.assertEqual(bf.coverage(db), [])


if __name__ == "__main__":
    unittest.main()


class Era5PlanTests(unittest.TestCase):
    def test_era5_source_is_planned_like_the_others(self):
        from datetime import date
        from app.services import backfill_service as bf
        todo = bf.plan({"A": {"latitude": 14.5, "longitude": 120.5}}, ["open_meteo_era5"], 2024, date(2026, 10, 25), set())
        self.assertEqual({c[1] for c in todo}, {"open_meteo_era5"})
        self.assertEqual(todo[0][2].year, 2026)  # newest first
        self.assertIn("open_meteo_era5", bf.EST_CALLS)
