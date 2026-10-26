import unittest

from app.services import susceptibility_service as ss

SQUARE = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]
HOLE = [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.4, 0.4]]


def poly(rings, **props):
    return {"type": "Feature", "properties": props, "geometry": {"type": "Polygon", "coordinates": rings}}


class GeometryTests(unittest.TestCase):
    def test_point_in_ring_and_holes(self):
        polys = ss.polygons({"type": "Polygon", "coordinates": [SQUARE, HOLE]})
        self.assertTrue(ss.contains(0.2, 0.2, polys))
        self.assertFalse(ss.contains(0.5, 0.5, polys))  # inside the hole
        self.assertFalse(ss.contains(1.5, 0.5, polys))

    def test_clip_drops_far_parts(self):
        far = [[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]
        polys = ss.polygons({"type": "MultiPolygon", "coordinates": [[SQUARE], [far]]}, clip=(-1, -1, 2, 2))
        self.assertEqual(len(polys), 1)


class BuildTests(unittest.TestCase):
    def test_class_shares_follow_the_map(self):
        # barangay: a small square near the equator (~1.1 km side); left half High, right quarter Low
        b = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]
        high = [[0, 0], [0.005, 0], [0.005, 0.01], [0, 0.01], [0, 0]]
        low = [[0.0075, 0], [0.01, 0], [0.01, 0.01], [0.0075, 0.01], [0.0075, 0]]
        mgb = {"features": [poly([high], FloodSusc="HF"), poly([low], FloodSusc="LF")]}
        bgys = {"features": [poly([b], name="A", psgc=1, municipality="T")]}
        row = ss.build(mgb, bgys, step_m=100, clip=(-1, -1, 1, 1))[0]
        self.assertGreater(row["samples"], 80)
        sh = ss.shares(row)
        self.assertAlmostEqual(sh["high"], 0.5, delta=0.1)
        self.assertAlmostEqual(sh["low"], 0.25, delta=0.1)
        self.assertAlmostEqual(sh["not_rated"], 0.25, delta=0.1)
        self.assertEqual(sh["very_high"], 0)

    def test_too_small_barangay_is_unsampled_not_guessed(self):
        tiny = [[0, 0], [0.0001, 0], [0.0001, 0.0001], [0, 0.0001], [0, 0]]
        row = ss.build({"features": []}, {"features": [poly([tiny], name="B", psgc=2, municipality="T")]}, step_m=200, clip=(-1, -1, 1, 1))[0]
        self.assertEqual(row["samples"], 0)
        self.assertIsNone(ss.shares(row))


class SummaryTests(unittest.TestCase):
    def data(self):
        def r(name, town, n, high, low):
            return {"psgc": name, "barangay": name, "municipality": town, "samples": n, "very_high": 0, "high": high,
                    "moderate": 0, "low": low, "not_rated": n - high - low}
        return {"step_m": 200, "barangays": [r("a", "X", 10, 8, 1), r("b", "X", 10, 1, 1), r("c", "X", 0, 0, 0),
                                             r("d", "Y", 20, 2, 2), r("e", "Z", 10, 5, 0)]}

    def test_towns_ranked_by_high_share_with_top_barangays(self):
        out = ss.summarize(self.data(), {"X": 9, "Y": 1, "Z": 5})
        self.assertEqual([t["name"] for t in out["towns"]], ["Z", "X", "Y"])
        x = next(t for t in out["towns"] if t["name"] == "X")
        self.assertEqual([b["name"] for b in x["top_barangays"]], ["a", "b"])
        self.assertEqual(x["barangays_unsampled"], ["c"])
        self.assertEqual(out["classes_present"], ["high", "low"])
        self.assertEqual(out["check"]["towns"], 3)

    def test_spearman(self):
        self.assertEqual(ss.spearman({"a": 1, "b": 2, "c": 3}, {"a": 10, "b": 20, "c": 30}), 1.0)
        self.assertEqual(ss.spearman({"a": 1, "b": 2, "c": 3}, {"a": 3, "b": 2, "c": 1}), -1.0)
        self.assertIsNone(ss.spearman({"a": 1}, {"a": 1}))

    def test_real_file_report(self):
        report = ss.susceptibility_report()
        self.assertTrue(report["available"])
        self.assertEqual(len(report["towns"]), 12)
        self.assertEqual(sum(t["barangays_total"] for t in report["towns"]), 237)
        self.assertNotIn("very_high", report["classes_present"])  # none touches Bataan in this MGB layer


if __name__ == "__main__":
    unittest.main()
