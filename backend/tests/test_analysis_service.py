"""
Data analysis pipeline. No network: Open-Meteo payloads are faked and the
numbers are invented for the tests.
"""

import unittest
from datetime import datetime, timedelta

from app.services import analysis_service as an

NOW = datetime(2026, 10, 26, 9, 30, tzinfo=an.PH_TZ)
HOUR = NOW.replace(minute=0)


class CleaningTests(unittest.TestCase):
    def test_duplicates_out_of_range_missing_and_gaps_are_reported(self):
        times = ["2026-10-26T00:00", "2026-10-26T01:00", "2026-10-26T01:00", "2026-10-26T03:00", "2026-10-26T04:00", "bad"]
        values = [1.0, -5.0, 2.0, None, 400.0, 3.0]
        t, v, report = an.clean_series(times, values, "precipitation")
        self.assertEqual(report["duplicates"], 1)
        self.assertEqual(report["out_of_range"], 2)  # -5 and 400 mm/h removed
        self.assertEqual(report["missing"], 1)
        self.assertEqual(report["unparseable_times"], 1)
        self.assertEqual(report["gaps"], 1)  # 01:00 -> 03:00
        self.assertEqual(v, [1.0, None, None, None])  # removed values are not replaced
        self.assertEqual(report["valid"], 1)

    def test_humidity_range(self):
        _, v, report = an.clean_series(["2026-10-26T00:00", "2026-10-26T01:00"], [85, 120], "relative_humidity_2m")
        self.assertEqual(v, [85.0, None])
        self.assertEqual(report["out_of_range"], 1)


class StatisticsTests(unittest.TestCase):
    def test_describe(self):
        d = an.describe([1.0, 2.0, 3.0, None])
        self.assertEqual((d["n"], d["missing"], d["sum"], d["mean"], d["min"], d["max"], d["median"]), (3, 1, 6.0, 2.0, 1.0, 3.0, 2.0))
        self.assertAlmostEqual(d["std"], 0.82, places=2)
        self.assertEqual(an.describe([None])["n"], 0)

    def test_percentile_and_rank(self):
        values = sorted(float(i) for i in range(1, 101))  # 1..100
        self.assertAlmostEqual(an.percentile(values, 90), 90.1, places=1)
        self.assertEqual(an.percentile_rank(values, 25), 25.0)

    def test_rolling_sum_skips_windows_with_missing_hours(self):
        self.assertEqual(an.max_rolling_sum([1, 2, 3, None, 10, 10, 10], 3), 30.0)


class ModelTests(unittest.TestCase):
    def test_agreement_levels(self):
        dry = an.model_agreement({"a": 0.0, "b": 0.4, "c": 0.2}, {"a": 0, "b": 0.2, "c": 0.1})
        self.assertEqual(dry["agreement"], "dry_agree")
        close = an.model_agreement({"a": 100.0, "b": 110.0, "c": 90.0}, {"a": 20, "b": 16, "c": 8})
        self.assertEqual(close["agreement"], "high")
        self.assertEqual(close["models_yellow_or_above"], 3)
        self.assertEqual(close["models_orange_or_above"], 2)
        wide = an.model_agreement({"a": 5.0, "b": 80.0, "c": 10.0}, {"a": 1, "b": 20, "c": 2})
        self.assertEqual(wide["agreement"], "low")
        self.assertGreater(wide["cv"], 0.75)

    def test_missing_models_are_left_out(self):
        result = an.model_agreement({"a": 10.0, "b": None}, {"a": 3, "b": None})
        self.assertEqual(result["n"], 1)


def season_series(values_per_day):
    """10 years of daily values, the same value list repeated every year."""
    times, values = [], []
    day = datetime(2016, 1, 1)
    while day.year <= 2025:
        times.append(day.strftime("%Y-%m-%d"))
        values.append(values_per_day(day))
        day += timedelta(days=1)
    return times, values


class ClimateTests(unittest.TestCase):
    def test_rank_z_score_and_frequency(self):
        # In the season window every year: days cycle through 0..9 mm.
        times, values = season_series(lambda d: float(d.day % 10))
        c = an.climate_context(times, values, NOW, forecast_24h=9.0, forecast_72h=30.0)
        self.assertEqual(c["status"], "ok")
        self.assertEqual(c["years"], 10)
        self.assertGreater(c["n_days"], 300)
        self.assertGreaterEqual(c["forecast_24h"]["percentile_rank"], 99.0)
        self.assertGreater(c["forecast_24h"]["z_score"], 1.0)
        self.assertEqual(c["forecast_72h"]["percentile_rank"], 100.0)

    def test_too_little_history(self):
        c = an.climate_context(["2025-10-26"], [5.0], NOW, 1.0, 2.0)
        self.assertEqual(c["status"], "insufficient_data")


class ConditionTests(unittest.TestCase):
    def test_rules(self):
        self.assertEqual(an.condition_24h({"sum": 0.2, "wet_hours": 1}, 10, "little")["rain"], "dry")
        self.assertEqual(an.condition_24h({"sum": 3, "wet_hours": 2}, 60, "little")["rain"], "light_rain")
        self.assertEqual(an.condition_24h({"sum": 12, "wet_hours": 6}, 85, "rain")["rain"], "rain")
        hot = an.condition_24h({"sum": 80, "wet_hours": 12}, 95, "orange")
        self.assertEqual((hot["rain"], hot["sky"]), ("orange", "overcast"))
        self.assertEqual(an.condition_24h({"sum": 0, "wet_hours": 0}, 30, "little")["sky"], "partly_cloudy")


def fake_forecast(rain=1.0):
    start = HOUR - timedelta(days=7)
    times = [(start + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(240)]
    hourly = {"time": times}
    for var, value in (("precipitation", rain), ("temperature_2m", 28.0), ("relative_humidity_2m", 80.0),
                       ("cloud_cover", 90.0), ("wind_speed_10m", 12.0), ("weather_code", 61)):
        hourly[f"{var}_best_match"] = [value] * 240
    for model in an.MODELS:
        hourly[f"precipitation_{model}"] = [rain] * 240
    return lambda name: ({"hourly": hourly, "latitude": 14.8, "longitude": 120.5, "elevation": 4.0}, {"models": "x"})


def fake_climate(name, now):
    times, values = season_series(lambda d: float(d.day % 10))
    return {"daily": {"time": times, "precipitation_sum": values}}, {"daily": "precipitation_sum"}


class PipelineTests(unittest.TestCase):
    def test_full_pipeline_reads_suffixed_columns_and_classifies(self):
        r = an.analyze_municipality("orani", fetch_fc=fake_forecast(1.0), fetch_clim=fake_climate, now=NOW)
        s = r["steps"]
        self.assertEqual(r["municipality"], "Orani")
        self.assertEqual(s["clean"]["reports"][0]["valid_percent"], 100.0)
        rain = s["describe"]["next_24h"]["precipitation"]
        self.assertEqual((rain["sum"], rain["wet_hours"], rain["max_3h"]), (24.0, 24, 3.0))
        self.assertEqual(s["models"]["summary"]["agreement"], "high")
        self.assertEqual(s["climate"]["status"], "ok")
        self.assertEqual(s["classify"]["rain_level"]["level"], "rain")
        self.assertEqual(s["classify"]["condition_24h"]["rain"], "rain")
        self.assertEqual(s["classify"]["model_weather_code"]["meaning"], "Slight rain")

    def test_unknown_town(self):
        with self.assertRaises(ValueError):
            an.analyze_municipality("Atlantis", fetch_fc=fake_forecast(), fetch_clim=fake_climate, now=NOW)

    def test_skill_adjustment_only_when_skill_is_ok(self):
        ok = lambda name: {"status": "ok", "adjustment_factor": 0.5}  # noqa: E731
        r = an.analyze_municipality("Orani", fetch_fc=fake_forecast(1.0), fetch_clim=fake_climate, skill=ok, now=NOW)
        self.assertEqual(r["steps"]["skill"]["adjusted_24h_mm"], 12.0)
        low = lambda name: {"status": "insufficient_data", "adjustment_factor": None}  # noqa: E731
        r2 = an.analyze_municipality("Orani", fetch_fc=fake_forecast(1.0), fetch_clim=fake_climate, skill=low, now=NOW)
        self.assertIsNone(r2["steps"]["skill"]["adjusted_24h_mm"])
