import contextlib
import os
import sqlite3
import tempfile
import unittest

from app.services import terrain_service as ts

SQUARE = [[(0.0, 0.0), (0.0, 0.04), (0.04, 0.04), (0.04, 0.0), (0.0, 0.0)]]
HOLE = [SQUARE[0], [(0.01, 0.01), (0.01, 0.02), (0.02, 0.02), (0.02, 0.01), (0.01, 0.01)]]


class GeometryTests(unittest.TestCase):
    def test_point_in_polygon_and_hole(self):
        self.assertTrue(ts.point_in_polygon(0.03, 0.03, HOLE))
        self.assertFalse(ts.point_in_polygon(0.015, 0.015, HOLE))
        self.assertFalse(ts.point_in_polygon(0.1, 0.1, HOLE))

    def test_grid_only_inside_and_ids_unique(self):
        cells = ts.make_grid({"Box": [SQUARE]}, spacing_km=1.0)
        self.assertGreater(len(cells), 10)
        self.assertEqual(len({c["id"] for c in cells}), len(cells))
        self.assertTrue(all(0 < c["longitude"] < 0.04 and 0 < c["latitude"] < 0.04 for c in cells))
        with self.assertRaises(ValueError):
            ts.make_grid({"Box": [SQUARE]}, 0)

    def test_real_boundaries_load(self):
        boundaries = ts.load_boundaries()
        self.assertEqual(len(boundaries), 12)
        cells = ts.make_grid(boundaries, 3.0)
        self.assertGreater(len(cells), 50)


class ElevationTests(unittest.TestCase):
    def test_batches_and_failed_batch_gives_none(self):
        calls = []

        def fetch(lats, lons):
            calls.append(len(lats))
            if len(calls) == 2:
                raise RuntimeError("boom")
            return [5.0] * len(lats)

        values, errors = ts.fetch_elevations([(0, 0)] * 150, fetch=fetch, pause_s=0, retries=0)
        self.assertEqual(calls, [100, 50])
        self.assertEqual(values[:100], [5.0] * 100)
        self.assertEqual(values[100:], [None] * 50)
        self.assertEqual(len(errors), 1)

    def test_non_numbers_become_none(self):
        values, _ = ts.fetch_elevations([(0, 0)] * 3, fetch=lambda a, b: [1, None, "x"], pause_s=0)
        self.assertEqual(values, [1.0, None, None])


class SlopeAndRiverTests(unittest.TestCase):
    def test_slope_of_a_ramp(self):
        cells = [
            {"row": 0, "col": c, "spacing_km": 1.0, "elevation_m": 100.0 * c} for c in range(3)
        ]
        ts.compute_slopes(cells)
        # 100 m rise per 1000 m -> atan(0.1)
        self.assertAlmostEqual(cells[1]["slope_deg"], 5.711, places=2)
        self.assertIsNotNone(cells[0]["slope_deg"])

    def test_slope_none_without_elevation_or_neighbours(self):
        cells = [{"row": 0, "col": 0, "spacing_km": 1.0, "elevation_m": None},
                 {"row": 5, "col": 5, "spacing_km": 1.0, "elevation_m": 3.0}]
        ts.compute_slopes(cells)
        self.assertIsNone(cells[0]["slope_deg"])
        self.assertIsNone(cells[1]["slope_deg"])

    def test_river_metrics(self):
        river = [[(0.0, 0.0), (0.0, 0.04)]]  # north-south line along lon 0
        cells = [{"latitude": 0.02, "longitude": 0.009, "elevation_m": 12.0}]
        points = [(0.02, 0.0)]
        ts.apply_river_metrics(cells, river, points, [2.0])
        self.assertAlmostEqual(cells[0]["dist_river_m"], 0.009 * 111320, delta=15)
        self.assertEqual(cells[0]["height_above_river_m"], 10.0)

    def test_no_waterways_leaves_none(self):
        cells = [{"latitude": 0.0, "longitude": 0.0, "elevation_m": 1.0}]
        ts.apply_river_metrics(cells, [], [], [])
        self.assertIsNone(cells[0]["dist_river_m"])

    def test_parse_overpass(self):
        data = {"elements": [{"type": "way", "geometry": [{"lat": 1, "lon": 2}, {"lat": 1.1, "lon": 2.1}]},
                             {"type": "node"}]}
        self.assertEqual(len(ts.parse_overpass(data)), 1)

    def test_sample_points_spacing(self):
        pts = ts.sample_river_points([[(0.0, 0.0), (0.0, 0.01)]], step_m=300)
        self.assertGreaterEqual(len(pts), 3)


class BuildTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self._path = os.path.join(self._dir.name, "t.db")

    def tearDown(self):
        self._dir.cleanup()

    def _connect(self):
        return sqlite3.connect(self._path)

    def _query(self, sql):
        with contextlib.closing(sqlite3.connect(self._path)) as db:
            return db.execute(sql).fetchone()

    def _build(self, **kw):
        return ts.build_terrain(
            spacing_km=1.0, boundaries={"Box": [SQUARE]}, connect=self._connect,
            fetch_elevation=lambda pts: ([float(i % 7) for i, _ in enumerate(pts)], []), **kw,
        )

    def test_build_is_idempotent_and_labelled(self):
        first = self._build()
        second = self._build()
        self.assertEqual(first["cells"], second["cells"])
        count = self._query("SELECT COUNT(*) FROM terrain_cells")[0]
        self.assertEqual(count, first["cells"])
        row = self._query("SELECT elevation_source, river_source, dist_river_m FROM terrain_cells LIMIT 1")
        self.assertIn("Copernicus", row[0])
        self.assertIsNone(row[1])
        self.assertIsNone(row[2])
        summary = ts.terrain_summary(connect=self._connect)
        self.assertEqual(summary["status"], "ok")

    def test_elevation_failure_stores_nulls(self):
        ts_summary = ts.build_terrain(
            boundaries={"Box": [SQUARE]}, connect=self._connect,
            fetch_elevation=lambda pts: ([None] * len(pts), ["down"]),
        )
        self.assertEqual(ts_summary["with_elevation"], 0)
        self.assertEqual(ts_summary["errors"], ["down"])
        self.assertEqual(self._query("SELECT COUNT(elevation_m) FROM terrain_cells")[0], 0)

    def test_summary_not_built(self):
        self.assertEqual(ts.terrain_summary(connect=self._connect)["status"], "not_built")


if __name__ == "__main__":
    unittest.main()
