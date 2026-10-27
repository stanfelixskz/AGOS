import csv
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

from tools import check_storms as cs

POINTS = [(14.0, 120.0)]
HEADER = ["SID", "SEASON", "NAME", "ISO_TIME", "LAT", "LON", "WMO_WIND", "USA_WIND"]


def write_csv(folder, rows):
    path = Path(folder) / "tracks.csv"
    with open(path, "w", newline="", encoding="utf-8") as handle:
        w = csv.writer(handle)
        w.writerow(HEADER)
        w.writerow(["", "Year", "", "", "degrees_north", "degrees_east", "kts", "kts"])  # the units row
        w.writerows(rows)
    return path


class DistanceTests(unittest.TestCase):
    def test_one_degree_of_latitude(self):
        self.assertAlmostEqual(cs.haversine_km(14.0, 120.0, 15.0, 120.0), 111.2, delta=0.5)
        self.assertEqual(cs.haversine_km(14.0, 120.0, 14.0, 120.0), 0.0)


class ReadTests(unittest.TestCase):
    def test_units_row_and_bad_rows_are_skipped(self):
        with tempfile.TemporaryDirectory() as folder:
            path = write_csv(folder, [
                ["A1", "2020", "ALPHA", "2020-08-01 00:00:00", "15.0", "121.0", "40", ""],
                ["A1", "2020", "ALPHA", "2020-08-01 03:00:00", "", "121.0", "40", ""],
                ["A1", "2020", "ALPHA", "not a time", "15.0", "121.0", "40", ""],
                ["B2", "2020", "NOT_NAMED", "2020-08-02 00:00:00", "16.0", "122.0", "", "25"],
            ])
            tracks = cs.read_tracks(path)
        self.assertEqual(len(tracks), 2)
        self.assertEqual(tracks[0]["wind_kt"], 40.0)
        self.assertEqual(tracks[1]["wind_kt"], 25.0)  # falls back to the USA wind
        self.assertEqual(tracks[0]["time"], datetime(2020, 8, 1))


class NearestTests(unittest.TestCase):
    TRACKS = [
        {"sid": "A", "name": "ALPHA", "time": datetime(2020, 8, 1, 0), "lat": 15.0, "lon": 120.0, "wind_kt": 50.0},
        {"sid": "A", "name": "ALPHA", "time": datetime(2020, 8, 1, 12), "lat": 14.5, "lon": 120.0, "wind_kt": 50.0},
        {"sid": "B", "name": "BETA", "time": datetime(2020, 8, 20, 0), "lat": 20.0, "lon": 125.0, "wind_kt": 20.0},
    ]

    def test_daily_nearest_keeps_the_closest_position_of_the_day(self):
        near = cs.daily_nearest(self.TRACKS, POINTS)
        self.assertAlmostEqual(near[date(2020, 8, 1)][0], 55.6, delta=0.5)
        self.assertEqual(near[date(2020, 8, 1)][1], "ALPHA")

    def test_weak_systems_are_left_out_when_a_wind_floor_is_set(self):
        near = cs.daily_nearest(self.TRACKS, POINTS, min_wind=34)
        self.assertNotIn(date(2020, 8, 20), near)
        self.assertIn(date(2020, 8, 1), near)

    def test_window_runs_two_days_before_and_one_after(self):
        near = cs.daily_nearest(self.TRACKS, POINTS)
        self.assertIsNotNone(cs.nearest_in_window(near, date(2020, 8, 3)))  # storm was 2 days before
        self.assertIsNone(cs.nearest_in_window(near, date(2020, 8, 4)))     # 3 days before: outside
        self.assertIsNotNone(cs.nearest_in_window(near, date(2020, 7, 31)))  # storm is 1 day after


class AnalyseTests(unittest.TestCase):
    def test_share_and_season_baseline(self):
        nearest = {date(2020, 8, 1): (100.0, "ALPHA")}
        days = [date(2020, 8, 1), date(2020, 8, 20)]
        out = cs.analyse(days, nearest, radii=(300,))
        row = out["rows"][0]
        self.assertEqual((row["events"], row["with_storm"]), (2, 1))
        self.assertEqual(row["share"], 0.5)
        # season days: every day of August 2020 (31); the storm covers Jul 30..Aug 3 windows -> days Aug 1..3 are near
        self.assertEqual(out["season_days"], 31)
        self.assertAlmostEqual(row["expected_share_if_no_link"], 3 / 31, places=2)

    def test_season_days_use_the_flood_months_and_years(self):
        days = [date(2019, 7, 1), date(2021, 8, 1)]
        got = cs.season_days(days)
        self.assertEqual({d.month for d in got}, {7, 8})
        self.assertEqual({d.year for d in got}, {2019, 2020, 2021})

    def test_no_events_is_safe(self):
        out = cs.analyse([], {}, radii=(300,))
        self.assertIsNone(out["rows"][0]["share"])
        self.assertIsNone(out["rows"][0]["p_value_one_sided"])


class FloodListTests(unittest.TestCase):
    def test_real_list_gives_dated_flooded_events(self):
        days = cs.flood_days()
        self.assertGreater(len(days), 20)
        self.assertEqual(days, sorted(set(days)))

    def test_real_municipality_points_are_the_twelve_towns(self):
        self.assertEqual(len(cs.bataan_points()), 12)


class MainTests(unittest.TestCase):
    def test_missing_file_says_so_and_calculates_nothing(self):
        from contextlib import redirect_stdout
        from io import StringIO

        buffer = StringIO()
        with redirect_stdout(buffer):
            code = cs.main(["check_storms.py", "/no/such/file.csv"])
        self.assertEqual(code, 2)
        self.assertIn("does not invent storm positions", buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
