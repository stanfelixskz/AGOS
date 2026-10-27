import unittest

from app.services import storm_risk_service as sr

TOWNS = {
    "Balanga": {"latitude": 14.676, "longitude": 120.536},
    "Mariveles": {"latitude": 14.433, "longitude": 120.486},
    "Dinalupihan": {"latitude": 14.878, "longitude": 120.462},
}


def factors(raised=(), near=()):
    return {"mode": "replay", "date": "2024-07-24", "raised": list(raised), "events_near": list(near), "towns": []}


class DistanceTests(unittest.TestCase):
    def test_one_degree_of_latitude_is_about_111_km(self):
        self.assertAlmostEqual(sr.distance_km(14.0, 120.0, 15.0, 120.0), 111.2, delta=0.2)

    def test_same_point_is_zero(self):
        self.assertEqual(sr.distance_km(14.5, 120.5, 14.5, 120.5), 0.0)


class StormContextTests(unittest.TestCase):
    def test_no_position_gives_no_context(self):
        self.assertIsNone(sr.storm_context(None, None, 300, TOWNS))

    def test_towns_are_sorted_nearest_first_and_checked_against_the_stated_radius(self):
        out = sr.storm_context(14.40, 120.49, 30, TOWNS)
        self.assertEqual(out["nearest"]["name"], "Mariveles")
        self.assertEqual(out["farthest"]["name"], "Dinalupihan")
        self.assertEqual(out["inside_radius"], ["Mariveles"])
        self.assertEqual([t["name"] for t in out["towns"]], ["Mariveles", "Balanga", "Dinalupihan"])

    def test_without_a_stated_radius_nobody_is_called_inside(self):
        self.assertIsNone(sr.storm_context(14.40, 120.49, None, TOWNS)["inside_radius"])


class ComparisonTests(unittest.TestCase):
    def test_no_listed_floods_gives_no_comparison(self):
        self.assertIsNone(sr.comparison(factors(raised=["Balanga"])))

    def test_flooded_and_raised_towns_are_matched(self):
        near = [{"towns": ["Hermosa", "Dinalupihan"]}, {"towns": ["Balanga"]}]
        out = sr.comparison(factors(raised=["Dinalupihan", "Orani"], near=near))
        self.assertEqual(out["listed_flooded"], ["Balanga", "Dinalupihan", "Hermosa"])
        self.assertEqual(out["both"], ["Dinalupihan"])
        self.assertEqual(out["flooded_not_raised"], ["Balanga", "Hermosa"])
        self.assertEqual(out["raised_not_listed"], ["Orani"])


class StormFloodRiskTests(unittest.TestCase):
    def test_answer_carries_the_day_mode_storm_and_notes(self):
        asked = []

        def report(day):
            asked.append(day)
            return factors(raised=["Balanga"], near=[{"towns": ["Balanga"]}])

        out = sr.storm_flood_risk("2024-07-24", latitude=14.40, longitude=120.49, radius_km=30, municipalities=TOWNS, report=report)
        self.assertEqual(asked, ["2024-07-24"])
        self.assertEqual((out["date"], out["mode"]), ("2024-07-24", "replay"))
        self.assertEqual(out["storm"]["inside_radius"], ["Mariveles"])
        self.assertEqual(out["comparison"]["both"], ["Balanga"])
        self.assertTrue(any("not part of it" in n for n in out["notes"]))

    def test_errors_from_the_day_report_pass_through(self):
        def report(day):
            raise ValueError("No rain data for 1980-01-01.")

        with self.assertRaises(ValueError):
            sr.storm_flood_risk("1980-01-01", municipalities=TOWNS, report=report)


if __name__ == "__main__":
    unittest.main()
