"""
AGOS consensus forecast. No network: model payloads are faked; numbers invented.
"""

import unittest
from datetime import datetime, timedelta
from unittest import mock

from app.data.municipalities import MUNICIPALITIES
from app.services import consensus_service as cs
from app.services import overview_service as ov
from app.services.analysis_service import MODELS

NOW = datetime(2026, 10, 26, 9, 30, tzinfo=cs.PH_TZ)
HOUR = NOW.replace(minute=0)


class CombineTests(unittest.TestCase):
    def test_median_range_and_chances(self):
        c = cs.combine([0.0, 0.0, 2.0, 8.0, 10.0, None], fallback=99.0, rain=True)
        self.assertEqual(c["value"], 2.0)            # median of the 5 valid models
        self.assertEqual((c["low"], c["high"]), (0.0, 10.0))
        self.assertEqual(c["models"], 5)
        self.assertEqual(c["chance"], 60)             # 3 of 5 models >= 0.1 mm
        self.assertEqual(c["heavy_chance"], 40)       # 2 of 5 models >= 7.5 mm/h
        self.assertEqual(c["basis"], "consensus")

    def test_too_few_models_falls_back_to_default(self):
        c = cs.combine([1.0, None, None, None, None, None], fallback=3.0, rain=True)
        self.assertEqual((c["value"], c["basis"], c["chance"]), (3.0, "fallback", None))

    def test_even_count_median(self):
        self.assertEqual(cs.combine([1.0, 2.0, 3.0, 4.0], fallback=None)["value"], 2.5)


def location(rain_by_model, temp=28.0, hours=168):
    start = HOUR - timedelta(days=3)
    times = [(start + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(hours)]
    hourly = {"time": times}
    for var in cs.VARIABLES:
        hourly[f"{var}_best_match"] = [temp if var == "temperature_2m" else 1.0] * hours
    for model, rain in zip(MODELS, rain_by_model):
        hourly[f"precipitation_{model}"] = [rain] * hours
        hourly[f"temperature_2m_{model}"] = [temp] * hours
        hourly[f"relative_humidity_2m_{model}"] = [80.0] * hours
        hourly[f"wind_speed_10m_{model}"] = [10.0] * hours
        hourly[f"cloud_cover_{model}"] = [50.0] * hours
    return {"hourly": hourly, "latitude": 14.8, "longitude": 120.5}


def towns(rain_by_model, **kw):
    return {name: cs.town_series(location(rain_by_model, **kw)) for name in MUNICIPALITIES}


class SeriesTests(unittest.TestCase):
    def test_invalid_model_values_are_cleaned_before_combining(self):
        loc = location([1.0, 1.0, 1.0, 1.0, 1.0, 1.0])
        loc["hourly"]["precipitation_gfs_seamless"] = [-50.0] * 168  # impossible: removed
        series = cs.town_series(loc)
        cell = series["precipitation"][80]
        self.assertEqual(cell["models"], 5)
        self.assertEqual(cell["value"], 1.0)
        self.assertEqual(series["quality"]["precipitation"]["gfs_seamless"], 0.0)

    def test_outlook_has_the_shape_build_overview_expects(self):
        t = towns([0.0, 0.5, 1.0, 2.0, 8.0, 10.0])
        outlook = cs.rainfall_outlook(hours=48, towns=t, now=NOW)
        self.assertEqual(outlook["method"], "consensus")
        point = outlook["municipalities"][0]["points"][0]
        self.assertEqual(point["precipitation_mm"], 1.5)  # median of the six
        self.assertEqual((point["low_mm"], point["high_mm"]), (0.0, 10.0))
        self.assertEqual(point["precipitation_probability_percent"], 83)  # 5 of 6 models wet
        self.assertEqual(len(outlook["municipalities"][0]["points"]), 48)
        ens = outlook["municipalities"][0]["ensemble"]["next_24h"]
        self.assertEqual((ens["low"], ens["high"], ens["models"]), (0.0, 240.0, 6))

        overview = ov.build_overview(outlook)
        town = overview["municipalities"][0]
        self.assertEqual(overview["method"], "consensus")
        self.assertEqual(town["windows"]["next_24h"]["total_mm"], 36.0)  # 24 h x 1.5 mm
        self.assertEqual(town["level_24h"], "rain")
        self.assertEqual(town["series"][0]["high_mm"], 10.0)

    def test_current_conditions(self):
        c = cs.current_conditions("Balanga", towns=towns([0, 0, 0, 0, 0.2, 0.3], temp=30.0), now=NOW)
        self.assertEqual((c["temperature_c"], c["humidity_percent"], c["wind_speed_kmh"]), (30.0, 80.0, 10.0))
        self.assertEqual(c["precipitation_mm"], 0.0)
        self.assertEqual(c["rain_chance_percent"], 33)
        self.assertEqual(c["method"], "consensus")

    def test_precipitation_by_time_for_flood_risk(self):
        by_time = cs.precipitation_by_time(towns([1, 2, 3, 4, 5, 6]))
        stamp = HOUR.strftime("%Y-%m-%dT%H:%M")
        self.assertEqual(by_time["Orani"][stamp], 3.5)


try:
    from app.routes import api
    HAVE_API = True
except ImportError:  # pragma: no cover
    HAVE_API = False


@unittest.skipUnless(HAVE_API, "fastapi not installed")
class FallbackTests(unittest.TestCase):
    def test_overview_falls_back_to_default_model_and_says_so(self):
        single = {"municipalities": [], "generated_at": "x", "limitations": []}
        with mock.patch.object(api.consensus_service, "rainfall_outlook", side_effect=RuntimeError("down")), \
             mock.patch.object(api, "get_bataan_rainfall_outlook", return_value=single):
            outlook = api._outlook(48)
        self.assertEqual(outlook["method"], "single_model_fallback")
        self.assertIn("consensus unavailable", outlook["source"])
        self.assertIn("down", outlook["limitations"][0])
