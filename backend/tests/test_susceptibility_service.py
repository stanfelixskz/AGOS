"""
Static susceptibility layers. No network: MGB answers, coastline and the
database are faked (in-memory SQLite). The shapes and numbers are invented.
"""

import sqlite3
import unittest
from unittest import mock

from app.services import susceptibility_service as ss
from app.services import terrain_service as ts


def memory_db():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    ss.init_tables(connection)
    return connection


class Shared:
    """Hand the same in-memory connection out repeatedly (close() is a no-op)."""

    def __init__(self):
        self.connection = memory_db()

    def __call__(self):
        conn = self.connection

        class Wrapper:
            def __getattr__(self, name):
                return getattr(conn, name)

            def __enter__(self):
                return conn.__enter__()

            def __exit__(self, *args):
                return conn.__exit__(*args)

            def close(self):
                pass

        return Wrapper()


SQUARE = {"Testtown": [[[(120.0, 14.0), (120.1, 14.0), (120.1, 14.1), (120.0, 14.1), (120.0, 14.0)]]],
          "Inland": [[[(121.0, 15.0), (121.1, 15.0), (121.1, 15.1), (121.0, 15.1), (121.0, 15.0)]]]}


class MgbTests(unittest.TestCase):
    def response(self, features):
        class R:
            def raise_for_status(self):
                pass

            def json(self):
                return {"features": [{"attributes": {"FloodSusc": f}} for f in features]}

        class S:
            def get(self, *a, **k):
                return R()

        return S()

    def test_rating_picks_the_most_susceptible_overlap(self):
        self.assertEqual(ss.fetch_mgb_rating(14.6, 120.5, session=self.response(["LF", "HF"])), "HF")
        self.assertEqual(ss.fetch_mgb_rating(14.6, 120.5, session=self.response(["VHF", "MF"])), "VHF")

    def test_no_polygon_is_none(self):
        self.assertIsNone(ss.fetch_mgb_rating(14.6, 120.5, session=self.response([])))

    def test_sample_cells_every_second_row_and_column(self):
        cells = [{"id": f"r{r:03d}c{c:03d}"} for r in range(4) for c in range(4)]
        picked = {c["id"] for c in ss.sample_cells(cells, every=2)}
        self.assertEqual(picked, {"r000c000", "r000c002", "r002c000", "r002c002"})

    def test_build_stores_ratings_and_errors_without_inventing(self):
        db = Shared()
        rows = [(f"r{r:03d}c000", 14.0 + r / 100, 120.0, "Testtown", 1.0, None, None, None, None, None, None, "now")
                for r in range(0, 6)]
        db.connection.executemany(f"INSERT INTO terrain_cells VALUES ({','.join('?' * 12)})", rows)
        answers = iter(["HF", None, RuntimeError("down")])

        def fetch(lat, lon):
            answer = next(answers)
            if isinstance(answer, Exception):
                raise answer
            return answer

        summary = ss.build_mgb_samples(every=2, pause_s=0, fetch=fetch, connect=db, sleep=lambda s: None)
        self.assertEqual((summary["samples"], summary["rated"], summary["not_mapped"], summary["error"]), (3, 1, 1, 1))
        stored = {r["status"]: r["rating"] for r in db.connection.execute("SELECT status, rating FROM mgb_samples")}
        self.assertEqual(stored, {"rated": "HF", "not_mapped": None, "error": None})

    def test_build_needs_terrain_first(self):
        summary = ss.build_mgb_samples(pause_s=0, fetch=lambda a, b: "HF", connect=Shared(), sleep=lambda s: None)
        self.assertEqual(summary["samples"], 0)
        self.assertIn("build_terrain", summary["errors"][0])


class CoastTests(unittest.TestCase):
    def test_town_touching_the_coastline_is_coastal(self):
        coastline = [[(120.1, 13.9), (120.1, 14.2)]]  # runs along Testtown's east edge
        result = ss.coastal_towns(SQUARE, coastline)
        self.assertEqual(result, {"Testtown": True, "Inland": False})


class SummaryTests(unittest.TestCase):
    def test_shares_and_missing_layers(self):
        db = Shared()
        cells = []
        # 4 cells at 2 m; 2 cells at 8 m near a river (low ground); 1 at 8 m far from rivers; 3 at 40 m near a river
        spec = [(2.0, 3000.0)] * 4 + [(8.0, 200.0)] * 2 + [(8.0, 3000.0)] + [(40.0, 100.0)] * 3
        for i, (elev, dist) in enumerate(spec):
            cells.append((f"r{i:03d}c000", 14.0, 120.0, "Testtown", 1.0, elev, 1.0, dist, None, "dem", "osm", "now"))
        db.connection.executemany(f"INSERT INTO terrain_cells VALUES ({','.join('?' * 12)})", cells)
        db.connection.executemany("INSERT INTO mgb_samples VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
            ("a", 14, 120, "Testtown", "VHF", "rated", "mgb", "t"),
            ("b", 14, 120, "Testtown", "LF", "rated", "mgb", "t"),
            ("c", 14, 120, "Testtown", None, "not_mapped", "mgb", "t"),
            ("d", 14, 120, "Testtown", None, "error", "mgb", "t"),
        ])
        with mock.patch.object(ss, "load_coastline", return_value=None):
            summary = ss.town_summaries(connect=db, boundaries=SQUARE)
        town = summary["towns"]["Testtown"]
        self.assertEqual(town["low_ground_share"], 0.6)  # high ground near a river does not count
        self.assertEqual(town["mgb_samples"], 3)  # the failed point is not counted
        self.assertEqual(town["mgb_high_share"], round(1 / 3, 3))
        self.assertIsNone(town["coastal"])  # no coastline file: unknown, not "inland"
        self.assertFalse(summary["coastline_available"])

    def test_too_few_cells_gives_none(self):
        db = Shared()
        db.connection.execute(f"INSERT INTO terrain_cells VALUES ({','.join('?' * 12)})",
                              ("r000c000", 14, 120, "Tiny", 1.0, 2.0, 1.0, 100.0, None, "dem", "osm", "now"))
        with mock.patch.object(ss, "load_coastline", return_value=None):
            town = ss.town_summaries(connect=db, boundaries=SQUARE)["towns"]["Tiny"]
        self.assertIsNone(town["low_ground_share"])
        self.assertIsNone(town["mgb_high_share"])
