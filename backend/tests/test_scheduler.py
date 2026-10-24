"""Tests for the background ingestion scheduler (no network, no FastAPI)."""

import threading
import unittest
from datetime import date

from app.services.scheduler import (
    IngestionScheduler,
    ingestion_period,
    load_settings,
    run_ingestion_cycle,
)

TWO_PLACES = {
    "Balanga": {"latitude": 14.6760, "longitude": 120.5363},
    "Mariveles": {"latitude": 14.4338, "longitude": 120.4858},
}


class SettingsTests(unittest.TestCase):
    def test_disabled_by_default(self):
        settings = load_settings({})
        self.assertFalse(settings["enabled"])
        self.assertEqual(settings["interval_hours"], 6.0)
        self.assertEqual(settings["lookback_days"], 7)

    def test_enabled_values(self):
        for value in ("1", "true", "TRUE", "yes", "on"):
            with self.subTest(value=value):
                self.assertTrue(
                    load_settings({"AGOS_SCHEDULER_ENABLED": value})["enabled"]
                )

    def test_values_are_clamped(self):
        settings = load_settings(
            {
                "AGOS_INGEST_INTERVAL_HOURS": "0.01",
                "AGOS_INGEST_LOOKBACK_DAYS": "9999",
            }
        )
        self.assertEqual(settings["interval_hours"], 1.0)
        self.assertEqual(settings["lookback_days"], 30)

    def test_invalid_numbers_fall_back_to_defaults(self):
        settings = load_settings(
            {
                "AGOS_INGEST_INTERVAL_HOURS": "soon",
                "AGOS_INGEST_LOOKBACK_DAYS": "",
            }
        )
        self.assertEqual(settings["interval_hours"], 6.0)
        self.assertEqual(settings["lookback_days"], 7)


class PeriodTests(unittest.TestCase):
    def test_period_ends_yesterday(self):
        start, end = ingestion_period(7, today=date(2026, 10, 24))
        self.assertEqual(end, date(2026, 10, 23))
        self.assertEqual(start, date(2026, 10, 17))

    def test_single_day_lookback(self):
        start, end = ingestion_period(1, today=date(2026, 10, 24))
        self.assertEqual(start, end)


class CycleTests(unittest.TestCase):
    def run_cycle(self, weather, discharge, **kwargs):
        return run_ingestion_cycle(
            lookback_days=3,
            municipalities=TWO_PLACES,
            ingest_weather=weather,
            ingest_discharge=discharge,
            today=date(2026, 10, 24),
            pause_seconds=0,
            sleep=lambda _seconds: None,
            **kwargs,
        )

    def test_all_sources_for_all_municipalities(self):
        calls = []

        def make(source):
            def ingest(**kwargs):
                calls.append((source, kwargs["latitude"], kwargs["start_date"]))
                return {"records_upserted": 10}
            return ingest

        summary = self.run_cycle(make("weather"), make("discharge"))

        self.assertEqual(summary["attempted"], 4)
        self.assertEqual(summary["succeeded"], 4)
        self.assertEqual(summary["failed"], 0)
        self.assertEqual(summary["records_upserted"], 40)
        self.assertEqual(summary["period"], {"start": "2026-10-21", "end": "2026-10-23"})
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(call[2] == date(2026, 10, 21) for call in calls))

    def test_one_failure_does_not_stop_the_rest(self):
        class FakeHTTPError(Exception):
            detail = "Open-Meteo returned HTTP 429"

        def weather(**kwargs):
            if kwargs["latitude"] == 14.6760:
                raise FakeHTTPError()
            return {"records_upserted": 5}

        def discharge(**kwargs):
            return {"records_upserted": 2}

        summary = self.run_cycle(weather, discharge)

        self.assertEqual(summary["attempted"], 4)
        self.assertEqual(summary["failed"], 1)
        self.assertEqual(summary["succeeded"], 3)
        self.assertEqual(summary["records_upserted"], 9)
        error = summary["errors"][0]
        self.assertEqual(error["municipality"], "Balanga")
        self.assertEqual(error["source"], "open_meteo_archive")
        self.assertEqual(error["error"], "Open-Meteo returned HTTP 429")

    def test_stops_early_when_asked(self):
        def ingest(**kwargs):
            return {"records_upserted": 1}

        summary = self.run_cycle(ingest, ingest, should_stop=lambda: True)
        self.assertEqual(summary["attempted"], 0)
        self.assertTrue(summary["stopped_early"])


class SchedulerThreadTests(unittest.TestCase):
    def test_disabled_scheduler_does_not_start(self):
        scheduler = IngestionScheduler(enabled=False)
        self.assertFalse(scheduler.start())
        self.assertFalse(scheduler.status()["running"])
        self.assertIsNone(scheduler.status()["last_started_at"])

    def test_enabled_scheduler_runs_a_cycle_and_stops(self):
        finished = threading.Event()

        def fake_cycle(lookback_days, should_stop):
            finished.set()
            return {"attempted": 24, "succeeded": 24, "failed": 0}

        scheduler = IngestionScheduler(
            enabled=True, interval_hours=1, lookback_days=5, cycle=fake_cycle
        )
        self.assertTrue(scheduler.start())
        self.assertTrue(finished.wait(timeout=5))
        scheduler.stop()

        status = scheduler.status()
        self.assertFalse(status["running"])
        self.assertEqual(status["last_summary"]["succeeded"], 24)
        self.assertIsNotNone(status["last_finished_at"])

    def test_crashing_cycle_is_recorded_and_thread_survives(self):
        done = threading.Event()

        def crashing_cycle(lookback_days, should_stop):
            done.set()
            raise RuntimeError("boom")

        scheduler = IngestionScheduler(enabled=True, cycle=crashing_cycle)
        scheduler.start()
        self.assertTrue(done.wait(timeout=5))
        scheduler.stop()

        summary = scheduler.status()["last_summary"]
        self.assertTrue(summary["crashed"])
        self.assertEqual(summary["error"], "boom")


if __name__ == "__main__":
    unittest.main()
