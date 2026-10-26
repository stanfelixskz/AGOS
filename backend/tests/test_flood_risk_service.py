"""
Flood-risk indicator (draft rules). No network and no database: Open-Meteo
payloads and the static layers are faked. The input numbers are invented.
"""

import unittest
from datetime import datetime, timedelta

from app.data.municipalities import MUNICIPALITIES
from app.services import flood_risk_service as fr

NOW = datetime(2026, 10, 26, 9, 30, tzinfo=fr.PH_TZ)
HOUR = NOW.replace(minute=0)


def hourly(rain_past=0.0, rain_next=0.0, peak=None, soil=0.3):
    """7 days of hourly values: 3 past days, 4 ahead, around NOW."""
    start = HOUR - timedelta(hours=72)
    times, rain, soil_values = [], [], []
    for i in range(168):
        t = start + timedelta(hours=i)
        times.append(t.strftime("%Y-%m-%dT%H:%M"))
        value = rain_past if t < HOUR else rain_next
        if peak is not None and t == HOUR + timedelta(hours=3):
            value = peak
        rain.append(value)
        soil_values.append(soil)
    return {"time": times, "precipitation": rain, "soil_moisture_0_to_10cm": soil_values}


def flood(median=10.0, ahead=10.0):
    days = [(NOW.date() + timedelta(days=d)).isoformat() for d in range(-30, 4)]
    return {"daily": {"time": days, "river_discharge": [median] * 30 + [ahead] * 4}}


def marine(past_max=1.0, ahead_peak=1.0):
    """30 past days of a tide-like cycle between 0 and past_max, then 2 days with a given peak."""
    start = HOUR - timedelta(days=30)
    times, values = [], []
    for i in range(32 * 24):
        t = start + timedelta(hours=i)
        times.append(t.strftime("%Y-%m-%dT%H:%M"))
        if t < HOUR:
            values.append(past_max * ((i % 12) / 11))
        else:
            values.append(ahead_peak if i % 12 == 6 else 0.2)
    return {"hourly": {"time": times, "sea_level_height_msl": values}}


def fake_fetch(h, f, m=None):
    names = list(MUNICIPALITIES)
    return lambda: {
        "names": names, "forecast": [{"hourly": h} for _ in names], "flood": [f for _ in names],
        "flood_error": None, "marine": [m for _ in names], "marine_error": None,
    }


NO_STATIC = lambda: {"towns": {}}  # noqa: E731


def build(h, f=None, m=None, storm=None, static=NO_STATIC):
    return fr.build_flood_risk(storm=storm, fetch=fake_fetch(h, f or flood(), m), static_loader=static, now=NOW)


def town(result, name="Balanga"):
    return next(t for t in result["municipalities"] if t["municipality"] == name)


class ScoringTests(unittest.TestCase):
    def test_dry_weather_is_low(self):
        result = build(hourly())
        self.assertEqual(town(result)["level"], "low")
        self.assertEqual(town(result)["score"], 0)
        self.assertEqual(result["rules_status"], "draft")

    def test_heavy_rain_wet_ground_and_high_river_is_very_high(self):
        # ahead 5 mm/h with a 35 mm/h hour: red (+4), 3 h = 45 mm (+1), 24 h = 150 mm (+2), 72 h = 390 mm (+2);
        # past 2 mm/h = 144 mm (+2); soil 0.45 (+1); river 3.5x median (+2)
        t = town(build(hourly(rain_past=2.0, rain_next=5.0, peak=35.0, soil=0.45), flood(10, 35)))
        points = {f["id"]: f["points"] for f in t["factors"]}
        self.assertEqual(points["peak_24h"], 4)
        self.assertEqual(points["peak_3h"], 1)
        self.assertEqual(points["total_24h"], 2)
        self.assertEqual(points["total_72h"], 2)
        self.assertEqual(points["past_72h"], 2)
        self.assertEqual(points["soil"], 1)
        self.assertEqual(points["discharge"], 2)
        self.assertEqual(t["level"], "very_high")

    def test_level_bands(self):
        self.assertEqual(town(build(hourly(peak=8.0)))["level"], "low")        # yellow: 2 points
        self.assertEqual(town(build(hourly(peak=16.0)))["level"], "moderate")  # orange: 3 points

    def test_three_hour_burst(self):
        h = hourly()
        for k in (2, 3, 4):  # 3 consecutive hours of 22 mm = 66 mm
            h["precipitation"][72 + k] = 22.0
        t = town(build(h))
        burst = next(f for f in t["factors"] if f["id"] == "peak_3h")
        self.assertEqual(burst["value"], 66.0)
        self.assertEqual(burst["points"], 2)

    def test_missing_river_data_is_reported_not_zero(self):
        names = list(MUNICIPALITIES)
        fetch = lambda: {"names": names, "forecast": [{"hourly": hourly()} for _ in names], "flood": [None] * len(names), "flood_error": "down"}
        result = fr.build_flood_risk(fetch=fetch, static_loader=NO_STATIC, now=NOW)
        self.assertIn("discharge", town(result)["missing"])
        self.assertEqual(result["river_data_note"], "down")

    def test_no_forecast_rain_gives_nodata(self):
        h = hourly()
        h["precipitation"] = [None] * len(h["precipitation"])
        t = town(build(h))
        self.assertEqual(t["level"], "nodata")
        self.assertIsNone(t["score"])


class StaticAndTideTests(unittest.TestCase):
    def static(self, coastal=True):
        return lambda: {"towns": {"Balanga": {"low_ground_share": 0.3, "mgb_high_share": 0.3, "coastal": coastal}}}

    def test_static_layers_are_held_back_on_a_dry_day(self):
        t = town(build(hourly(), static=self.static()))
        low = next(f for f in t["factors"] if f["id"] == "low_ground")
        self.assertEqual(low["points"], 0)
        self.assertEqual(low["held_back"], 2)
        self.assertFalse(t["rain_signal"])
        self.assertEqual(t["level"], "low")

    def test_static_layers_count_with_a_rain_signal(self):
        # orange hour (3) + low ground 30 % (2) + MGB 30 % (1) = 6 -> high
        t = town(build(hourly(peak=16.0), static=self.static()))
        points = {f["id"]: f["points"] for f in t["factors"]}
        self.assertEqual((points["low_ground"], points["mgb"]), (2, 1))
        self.assertEqual(t["score"], 6)
        self.assertEqual(t["level"], "high")

    def test_unbuilt_static_layers_are_missing(self):
        t = town(build(hourly()))
        self.assertTrue({"low_ground", "mgb"} <= set(t["missing"]))

    def test_high_tide_adds_a_point_for_coastal_towns_only(self):
        result = build(hourly(), m=marine(past_max=1.0, ahead_peak=1.3), static=self.static(coastal=True))
        tide = next(f for f in town(result)["factors"] if f["id"] == "tide")
        self.assertEqual(tide["points"], 1)
        self.assertEqual(tide["value"], 1.3)
        inland = build(hourly(), m=marine(1.0, 1.3), static=self.static(coastal=False))
        self.assertNotIn("tide", [f["id"] for f in town(inland)["factors"]])

    def test_normal_tide_scores_nothing(self):
        result = build(hourly(), m=marine(past_max=1.0, ahead_peak=0.5), static=self.static())
        tide = next(f for f in town(result)["factors"] if f["id"] == "tide")
        self.assertEqual(tide["points"], 0)


class StormTests(unittest.TestCase):
    def balanga_storm(self, radius, km_east=100):
        p = MUNICIPALITIES["Balanga"]
        return {"latitude": p["latitude"], "longitude": p["longitude"] + km_east / 107.6, "radius_km": radius, "name": "Testa", "strength_level": 3}

    def test_inside_stated_radius_raises_one_level(self):
        t = town(build(hourly(peak=16.0), storm=self.balanga_storm(radius=300)))
        self.assertTrue(t["storm"]["inside_radius"])
        self.assertEqual(t["storm"]["level_before"], "moderate")
        self.assertEqual(t["level"], "high")

    def test_outside_radius_or_no_radius_changes_nothing(self):
        for radius in (50, None):
            t = town(build(hourly(peak=16.0), storm=self.balanga_storm(radius=radius)))
            self.assertEqual(t["level"], "moderate", radius)
            self.assertEqual(t["storm"]["steps"], 0)
            self.assertAlmostEqual(t["storm"]["distance_km"], 100, delta=3)

    def test_storm_never_goes_above_very_high(self):
        h = hourly(rain_past=2.0, rain_next=5.0, peak=35.0, soil=0.45)
        t = town(build(h, flood(10, 35), storm=self.balanga_storm(radius=500)))
        self.assertEqual(t["level"], "very_high")


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
