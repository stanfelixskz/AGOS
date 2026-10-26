"""
Flood-risk indicator (draft rules). No network: Open-Meteo payloads are faked.
The input numbers are invented for the tests.
"""

import unittest
from datetime import datetime, timedelta

from app.data.municipalities import MUNICIPALITIES
from app.services import flood_risk_service as fr

NOW = datetime(2026, 10, 26, 9, 30, tzinfo=fr.PH_TZ)


def hourly(rain_past=0.0, rain_next=0.0, peak=None, soil=0.3):
    """7 days of hourly values: 3 past days, 4 ahead, around NOW."""
    start = NOW.replace(minute=0) - timedelta(hours=72)
    times, rain, soil_values = [], [], []
    for i in range(168):
        t = start + timedelta(hours=i)
        times.append(t.strftime("%Y-%m-%dT%H:%M"))
        value = rain_past if t < NOW.replace(minute=0) else rain_next
        if peak is not None and t == NOW.replace(minute=0) + timedelta(hours=3):
            value = peak
        rain.append(value)
        soil_values.append(soil)
    return {"time": times, "precipitation": rain, "soil_moisture_0_to_10cm": soil_values}


def flood(median=10.0, ahead=10.0):
    days = [(NOW.date() + timedelta(days=d)).isoformat() for d in range(-30, 4)]
    values = [median] * 30 + [ahead] * 4
    return {"daily": {"time": days, "river_discharge": values}}


def fake_fetch(h, f):
    names = list(MUNICIPALITIES)
    return lambda: {"names": names, "forecast": [{"hourly": h} for _ in names], "flood": [f for _ in names], "flood_error": None}


class ScoringTests(unittest.TestCase):
    def test_dry_weather_is_low(self):
        result = fr.build_flood_risk(fetch=fake_fetch(hourly(), flood()), now=NOW)
        town = result["municipalities"][0]
        self.assertEqual(town["level"], "low")
        self.assertEqual(town["score"], 0)
        self.assertEqual(result["rules_status"], "draft")

    def test_heavy_rain_wet_ground_and_high_river_is_very_high(self):
        # 5 mm/h ahead = 120 mm in 24 h (+2) and 360 mm in 72 h (+2); 35 mm/h peak = red (+4);
        # 2 mm/h past = 144 mm (+2); soil 0.45 (+1); river 3.5x median (+2)
        h = hourly(rain_past=2.0, rain_next=5.0, peak=35.0, soil=0.45)
        town = fr.build_flood_risk(fetch=fake_fetch(h, flood(10, 35)), now=NOW)["municipalities"][0]
        points = {f["id"]: f["points"] for f in town["factors"]}
        self.assertEqual(points, {"peak_24h": 4, "total_24h": 2, "total_72h": 2, "past_72h": 2, "soil": 1, "discharge": 2})
        self.assertEqual(town["level"], "very_high")

    def test_moderate_band(self):
        # 8 mm/h peak = yellow (+2) only
        town = fr.build_flood_risk(fetch=fake_fetch(hourly(peak=8.0), flood()), now=NOW)["municipalities"][0]
        self.assertEqual(town["score"], 2)
        self.assertEqual(town["level"], "moderate")

    def test_missing_river_data_is_reported_not_zero(self):
        names = list(MUNICIPALITIES)
        fetch = lambda: {"names": names, "forecast": [{"hourly": hourly()} for _ in names], "flood": [None] * len(names), "flood_error": "down"}
        result = fr.build_flood_risk(fetch=fetch, now=NOW)
        town = result["municipalities"][0]
        self.assertIn("discharge", town["missing"])
        self.assertEqual(result["river_data_note"], "down")

    def test_no_forecast_rain_gives_nodata(self):
        h = hourly()
        h["precipitation"] = [None] * len(h["precipitation"])
        town = fr.build_flood_risk(fetch=fake_fetch(h, flood()), now=NOW)["municipalities"][0]
        self.assertEqual(town["level"], "nodata")
        self.assertIsNone(town["score"])


class StormTests(unittest.TestCase):
    def balanga_storm(self, radius, km_east=100):
        p = MUNICIPALITIES["Balanga"]
        return {"latitude": p["latitude"], "longitude": p["longitude"] + km_east / 107.6, "radius_km": radius, "name": "Testa", "strength_level": 3}

    def town(self, result, name="Balanga"):
        return next(t for t in result["municipalities"] if t["municipality"] == name)

    def test_inside_stated_radius_raises_one_level(self):
        result = fr.build_flood_risk(storm=self.balanga_storm(radius=300), fetch=fake_fetch(hourly(peak=8.0), flood()), now=NOW)
        town = self.town(result)
        self.assertTrue(town["storm"]["inside_radius"])
        self.assertEqual(town["storm"]["level_before"], "moderate")
        self.assertEqual(town["level"], "high")

    def test_outside_radius_or_no_radius_changes_nothing(self):
        for radius in (50, None):
            result = fr.build_flood_risk(storm=self.balanga_storm(radius=radius), fetch=fake_fetch(hourly(peak=8.0), flood()), now=NOW)
            town = self.town(result)
            self.assertEqual(town["level"], "moderate", radius)
            self.assertEqual(town["storm"]["steps"], 0)
            self.assertAlmostEqual(town["storm"]["distance_km"], 100, delta=3)

    def test_storm_never_goes_above_very_high(self):
        h = hourly(rain_past=2.0, rain_next=5.0, peak=35.0, soil=0.45)
        result = fr.build_flood_risk(storm=self.balanga_storm(radius=500), fetch=fake_fetch(h, flood(10, 35)), now=NOW)
        self.assertEqual(self.town(result)["level"], "very_high")


try:
    from fastapi.testclient import TestClient
    from app.main import app
    HAVE_API = True
except ImportError:  # pragma: no cover
    HAVE_API = False


@unittest.skipUnless(HAVE_API, "fastapi/httpx not installed")
class RouteTests(unittest.TestCase):
    def test_bad_storm_values_are_422(self):
        client = TestClient(app)
        self.assertEqual(client.get("/api/flood-risk", params={"storm_lat": 95, "storm_lon": 120}).status_code, 422)
        self.assertEqual(client.get("/api/flood-risk", params={"storm_lat": 14, "storm_lon": 125, "storm_strength": 9}).status_code, 422)
