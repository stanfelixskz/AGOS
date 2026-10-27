import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app.services import rivers_service as rs

try:
    from fastapi.testclient import TestClient
    from app.main import app

    HAVE_API = True
except ImportError:  # pragma: no cover - depends on the environment
    HAVE_API = False


def square(lon0, lat0, lon1, lat1):
    return [[(lon0, lat0), (lon1, lat0), (lon1, lat1), (lon0, lat1), (lon0, lat0)]]


# Two touching synthetic "towns" (not real places): Alpha is west of lon 120.10, Beta is east of it.
BOUNDARIES = {
    "Alpha": [square(120.00, 14.00, 120.10, 14.10)],
    "Beta": [square(120.10, 14.00, 120.20, 14.10)],
    "Empty": [square(120.30, 14.00, 120.40, 14.10)],
}

FEATURES = [
    {"name": "Cross River", "waterway": "river", "line": [(120.03, 14.05), (120.17, 14.05)]},
    {"name": None, "waterway": "stream", "line": [(120.02, 14.02), (120.02, 14.04)]},
    {"name": "Beta Canal", "waterway": "canal", "line": [(120.12, 14.02), (120.12, 14.03)]},
    {"name": "Far Away River", "waterway": "river", "line": [(121.00, 14.05), (121.05, 14.05)]},
]


def write_file(directory, features, metadata=None):
    path = Path(directory) / "waterways_tagged.geojson"
    path.write_text(json.dumps(rs.features_to_geojson(features, metadata or {"fetched_at": "2026-10-27T00:00:00+00:00"})), encoding="utf-8")
    return path


class SimplifyTests(unittest.TestCase):
    def test_a_nearly_straight_line_collapses_to_its_two_ends(self):
        line = [(120.0 + i * 0.001, 14.0 + (0.00001 if i % 2 else 0.0)) for i in range(50)]  # wobble about 1 m
        out = rs.simplify_line(line, 30)
        self.assertEqual(out, [line[0], line[-1]])

    def test_a_real_bend_is_kept(self):
        line = [(120.000, 14.000), (120.005, 14.000), (120.010, 14.005), (120.010, 14.010)]
        out = rs.simplify_line(line, 30)
        self.assertEqual(out[0], line[0])
        self.assertEqual(out[-1], line[-1])
        self.assertGreater(len(out), 2)

    def test_two_points_and_short_input_are_unchanged(self):
        self.assertEqual(rs.simplify_line([(120.0, 14.0), (120.1, 14.1)]), [(120.0, 14.0), (120.1, 14.1)])
        self.assertEqual(rs.simplify_line([(120.0, 14.0)]), [(120.0, 14.0)])

    def test_length_is_in_metres(self):
        self.assertAlmostEqual(rs.line_length_m([(120.0, 14.0), (120.0, 14.01)]), 1106, delta=5)  # one degree of latitude is about 110.6 km at 14 N
        self.assertEqual(rs.line_length_m([(120.0, 14.0)]), 0.0)


class ParseTests(unittest.TestCase):
    def test_only_rivers_streams_and_canals_with_a_line_are_kept(self):
        payload = {"elements": [
            {"type": "way", "tags": {"waterway": "river", "name": " Test River "}, "geometry": [{"lat": 14.0, "lon": 120.0}, {"lat": 14.1, "lon": 120.0}]},
            {"type": "way", "tags": {"waterway": "drain"}, "geometry": [{"lat": 14.0, "lon": 120.0}, {"lat": 14.1, "lon": 120.0}]},
            {"type": "way", "tags": {"waterway": "stream"}, "geometry": [{"lat": 14.0, "lon": 120.0}]},
            {"type": "node", "tags": {"waterway": "river"}},
            {"type": "way", "tags": {"waterway": "canal", "tunnel": "culvert"}, "geometry": [{"lat": 14.0, "lon": 120.0}, {"lat": 14.0, "lon": 120.1}]},
        ]}
        out = rs.parse_overpass(payload)
        self.assertEqual([(f["name"], f["waterway"]) for f in out], [("Test River", "river"), (None, "canal")])
        self.assertEqual(out[1]["tunnel"], "culvert")

    def test_file_round_trip_keeps_names_and_types(self):
        with tempfile.TemporaryDirectory() as folder:
            path = write_file(folder, FEATURES)
            back = rs.read_features(json.loads(path.read_text(encoding="utf-8")))
        self.assertEqual([(f["name"], f["waterway"]) for f in back], [(f["name"], f["waterway"]) for f in FEATURES])


class TownTests(unittest.TestCase):
    def test_locator_finds_the_town_or_none(self):
        locator = rs.TownLocator(BOUNDARIES)
        self.assertEqual(locator.at(120.05, 14.05), "Alpha")
        self.assertEqual(locator.at(120.15, 14.05), "Beta")
        self.assertIsNone(locator.at(121.0, 14.05))

    def test_names_length_and_dropped_lines(self):
        out = rs.summarize(FEATURES, BOUNDARIES)
        towns = {t["name"]: t for t in out["towns"]}
        self.assertEqual(towns["Alpha"]["rivers"], ["Cross River"])  # the unnamed stream is not listed
        self.assertEqual(towns["Beta"]["rivers"], ["Beta Canal", "Cross River"])
        self.assertEqual(towns["Empty"], {"name": "Empty", "rivers": [], "length_km": 0.0})
        # Cross River runs 0.07 degrees of longitude (about 7.56 km) in each town; the stream adds 2.2 km to Alpha
        self.assertAlmostEqual(towns["Beta"]["length_km"], 7.56 + 1.1, delta=0.2)
        self.assertAlmostEqual(towns["Alpha"]["length_km"], 7.56 + 2.2, delta=0.2)
        self.assertEqual(out["stats"]["features"], 3)
        self.assertEqual(out["stats"]["outside_bataan_dropped"], 1)
        self.assertEqual(out["stats"]["by_type"], {"river": 1, "stream": 1, "canal": 1})
        self.assertEqual(out["stats"]["named"], 2)
        self.assertNotIn("Far Away River", [f["name"] for f in out["lines"]])

    def test_culverts_are_left_out_and_counted(self):
        pipe = {"name": "Pipe", "waterway": "stream", "tunnel": "culvert", "line": [(120.02, 14.02), (120.02, 14.04)]}
        out = rs.summarize(FEATURES + [pipe], BOUNDARIES)
        self.assertEqual(out["stats"]["underground_dropped"], 1)
        self.assertEqual(out["stats"]["outside_bataan_dropped"], 1)
        self.assertEqual(out["stats"]["features"], 3)
        self.assertNotIn("Pipe", [f["name"] for f in out["lines"]])
        self.assertNotIn("Pipe", {t["name"]: t for t in out["towns"]}["Alpha"]["rivers"])
        self.assertFalse(rs.is_underground({"tunnel": "no"}))
        self.assertFalse(rs.is_underground({}))

    def test_tunnel_tag_survives_the_file_round_trip(self):
        pipe = {"name": None, "waterway": "canal", "tunnel": "culvert", "line": [(120.02, 14.02), (120.02, 14.04)]}
        with tempfile.TemporaryDirectory() as folder:
            path = write_file(folder, [pipe])
            back = rs.read_features(json.loads(path.read_text(encoding="utf-8")))
        self.assertEqual(back[0]["tunnel"], "culvert")

    def test_a_straight_line_across_a_border_is_split_between_towns(self):
        out = rs.summarize([FEATURES[0]], BOUNDARIES)
        km = {t["name"]: t["length_km"] for t in out["towns"]}
        self.assertAlmostEqual(km["Alpha"], km["Beta"], delta=0.25)
        self.assertGreater(km["Alpha"], 7.0)


class ReportTests(unittest.TestCase):
    def test_missing_file_answers_not_available_without_lines(self):
        with tempfile.TemporaryDirectory() as folder:
            out = rs.build_report(Path(folder) / "nope.geojson", BOUNDARIES)
        self.assertFalse(out["available"])
        self.assertIn("fetch_rivers.py", out["reason"])
        self.assertNotIn("geojson", out)

    def test_unreadable_and_empty_files_answer_not_available(self):
        with tempfile.TemporaryDirectory() as folder:
            bad = Path(folder) / "bad.geojson"
            bad.write_text("not json", encoding="utf-8")
            self.assertFalse(rs.build_report(bad, BOUNDARIES)["available"])
            empty = write_file(folder, [])
            self.assertIn("no river", rs.build_report(empty, BOUNDARIES)["reason"])

    def test_old_geometry_only_file_is_not_treated_as_rivers(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "old.geojson"
            path.write_text(json.dumps({"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": [[120.0, 14.0], [120.1, 14.0]]}}]}), encoding="utf-8")
            self.assertFalse(rs.build_report(path, BOUNDARIES)["available"])

    def test_report_shape(self):
        with tempfile.TemporaryDirectory() as folder:
            out = rs.build_report(write_file(folder, FEATURES, {"fetched_at": "2026-10-27T00:00:00+00:00", "osm_data_timestamp": "2026-10-27T02:01:20Z"}), BOUNDARIES)
        self.assertTrue(out["available"])
        for key in ("source", "license", "built_at", "fetched_at", "osm_data_timestamp", "geojson", "towns", "stats", "notes"):
            self.assertIn(key, out)
        self.assertIn("OpenStreetMap", out["source"])
        self.assertIn("ODbL", out["source"])
        self.assertEqual(out["osm_data_timestamp"], "2026-10-27T02:01:20Z")
        self.assertEqual(out["geojson"]["type"], "FeatureCollection")
        self.assertEqual(len(out["geojson"]["features"]), 3)
        first = out["geojson"]["features"][0]
        self.assertEqual(set(first["properties"]), {"waterway", "name"})
        self.assertEqual(first["geometry"]["type"], "LineString")
        self.assertTrue(any("Context only" in n for n in out["notes"]))

    def test_towns_for_factors(self):
        with tempfile.TemporaryDirectory() as folder:
            report = rs.build_report(write_file(folder, FEATURES), BOUNDARIES)
        out = rs.towns_for_factors(report)
        self.assertEqual(out["Beta"]["names"], ["Beta Canal", "Cross River"])
        self.assertIsInstance(out["Beta"]["length_km"], float)
        self.assertEqual(rs.towns_for_factors({"available": False, "reason": "x"}), {})


@unittest.skipUnless(HAVE_API, "fastapi/httpx not installed")
class RouteTests(unittest.TestCase):
    def setUp(self):
        rs._cache.update(key=None, value=None)
        self.addCleanup(rs._cache.update, key=None, value=None)

    def test_route_says_not_available_when_the_file_is_missing(self):
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(rs, "DATA_FILE", Path(folder) / "nope.geojson"):
            response = TestClient(app).get("/api/rivers")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["available"])
        self.assertTrue(body["reason"])

    def test_route_shape_with_a_file(self):
        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(rs, "DATA_FILE", write_file(folder, FEATURES)), \
                mock.patch.object(rs.ts, "load_boundaries", return_value=BOUNDARIES):
            response = TestClient(app).get("/api/rivers")
        body = response.json()
        self.assertTrue(body["available"])
        self.assertEqual([t["name"] for t in body["towns"]], ["Alpha", "Beta", "Empty"])
        self.assertEqual(body["geojson"]["type"], "FeatureCollection")
        self.assertIn("OpenStreetMap", body["source"])


if __name__ == "__main__":
    unittest.main()
