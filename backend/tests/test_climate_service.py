import contextlib
import math
import sqlite3
import unittest
from datetime import date, timedelta

from app.services import climate_service as cs

POINT = {"latitude": 14.5, "longitude": 120.5}


def gumbel_sample(mu, beta, n):
    """Exact Gumbel quantiles at plotting positions: a sample whose fit we can predict."""
    return [mu - beta * math.log(-math.log((i + 0.5) / n)) for i in range(n)]


def make_daily(years, base=2.0, peak_by_year=None):
    daily = {}
    for year in years:
        d = date(year, 1, 1)
        while d.year == year:
            daily[d.isoformat()] = base if d.month in (7, 8, 9) else 0.0
            d += timedelta(days=1)
        if peak_by_year and year in peak_by_year:
            daily[f"{year}-08-15"] = peak_by_year[year]
    return daily


class GumbelTests(unittest.TestCase):
    def test_fit_recovers_scale_and_levels_increase(self):
        sample = gumbel_sample(80.0, 25.0, 40)
        mu, beta = cs.fit_gumbel(sample)
        self.assertAlmostEqual(beta, 25.0, delta=4)
        self.assertAlmostEqual(mu, 80.0, delta=6)
        levels = [cs.return_level(mu, beta, t) for t in (2, 5, 10, 20)]
        self.assertEqual(levels, sorted(levels))
        p = cs.annual_exceedance(mu, beta, cs.return_level(mu, beta, 10))
        self.assertAlmostEqual(p, 0.1, places=6)

    def test_return_levels_need_enough_years(self):
        self.assertEqual(cs.return_levels([50.0] * 9)["status"], "insufficient_data")

    def test_ranges_bracket_estimate_and_are_deterministic(self):
        sample = gumbel_sample(80.0, 25.0, 11)
        a = cs.return_levels(sample)
        b = cs.return_levels(sample)
        self.assertEqual(a, b)
        self.assertEqual(a["status"], "ok")
        for level in a["levels"]:
            self.assertLessEqual(level["low"], level["mm"] + 1e-6)
            self.assertGreaterEqual(level["high"], level["mm"] - 1e-6)
        self.assertEqual([lv["years"] for lv in a["levels"]], [2, 5, 10, 20])  # 20 <= 2*11
        small = cs.return_levels(gumbel_sample(80, 25, 10))
        self.assertEqual([lv["years"] for lv in small["levels"]], [2, 5, 10, 20])
        for e in a["exceedance"]:
            self.assertTrue(0 <= e["low"] <= e["high"] <= 1)

    def test_constant_sample_does_not_crash(self):
        out = cs.return_levels([60.0] * 12)
        self.assertEqual(out["status"], "no_variation")


class YearlyTests(unittest.TestCase):
    def test_complete_and_partial_years_and_stats(self):
        daily = make_daily([2020, 2021], peak_by_year={2020: 120.0})
        partial = {f"2022-01-{d:02d}": 5.0 for d in range(1, 11)}
        years = cs.yearly_stats({**daily, **partial})
        by = {y["year"]: y for y in years}
        self.assertTrue(by[2020]["complete"] and by[2021]["complete"])
        self.assertFalse(by[2022]["complete"])
        self.assertEqual(by[2020]["wettest_day"], {"date": "2020-08-15", "mm": 120.0})
        self.assertEqual(by[2020]["heavy_days"]["100"], 1)
        self.assertEqual(by[2021]["heavy_days"]["10"], 0)
        self.assertEqual(by[2021]["rain_days"], 92)  # Jul+Aug+Sep at 2 mm

    def test_wettest_3day_needs_consecutive_days(self):
        daily = {"2020-05-01": 30.0, "2020-05-02": 10.0, "2020-05-03": 0.0, "2020-05-05": 90.0}
        # the 90 mm day has no complete 3-day window around it, so it must not count
        self.assertEqual(cs.yearly_stats(daily)[0]["wettest_3day"], {"start": "2020-05-01", "mm": 40.0})

    def test_monthly_uses_full_years_only(self):
        daily = make_daily([2020, 2021])
        monthly = cs.monthly_climate(daily, [2020, 2021])
        self.assertEqual(len(monthly), 12)
        self.assertEqual(monthly[7]["mean_total_mm"], 62.0)  # August: 31 x 2 mm
        self.assertTrue(monthly[7]["above_average"])
        self.assertFalse(monthly[0]["above_average"])
        self.assertEqual(cs.monthly_climate(daily, []), [])


class TrendTests(unittest.TestCase):
    def test_clear_trend_and_flat_noise(self):
        rising = {2010 + i: 1000 + 50 * i for i in range(10)}
        out = cs.trend(rising)
        self.assertEqual(out["slope_mm_per_year"], 50.0)
        self.assertTrue(out["distinguishable_from_zero"])
        noisy = {2010 + i: v for i, v in enumerate([1000, 1400, 800, 1300, 900, 1200, 1100, 700, 1350, 1000])}
        self.assertFalse(cs.trend(noisy)["distinguishable_from_zero"])
        self.assertEqual(cs.trend({2020: 1, 2021: 2})["status"], "insufficient_data")


class DatabaseTests(unittest.TestCase):
    def _db(self):
        db = sqlite3.connect(":memory:")
        db.execute("CREATE TABLE observations (source, variable, observed_at, latitude, longitude, value, unit, quality_flag, fetched_at)")
        return db

    def test_load_filters_variable_source_flag_and_point(self):
        with contextlib.closing(self._db()) as db:
            rows = [
                ("open_meteo_archive", "precipitation_sum", "2020-01-01", 14.5, 120.5, 5.0, "mm", "valid", "x"),
                ("open_meteo_archive", "precipitation_sum", "2020-01-02", 14.5, 120.5, 9.0, "mm", "suspect", "x"),
                ("open_meteo_archive", "rain_sum", "2020-01-03", 14.5, 120.5, 9.0, "mm", "valid", "x"),
                ("open_meteo_archive", "precipitation_sum", "2020-01-04", 15.9, 120.5, 9.0, "mm", "valid", "x"),
            ]
            db.executemany("INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?)", rows)
            self.assertEqual(cs.load_daily_rain(db, POINT), {"2020-01-01": 5.0})

    def test_climate_report_with_and_without_data(self):
        with contextlib.closing(self._db()) as db:
            self.assertFalse(cs.climate(db, {"A": POINT})["any_data"])
            peaks = {2010 + i: 60.0 + 10 * i for i in range(11)}
            daily = make_daily(range(2010, 2021), peak_by_year=peaks)
            db.executemany(
                "INSERT INTO observations VALUES ('open_meteo_archive','precipitation_sum',?,14.5,120.5,?,'mm','valid','x')",
                list(daily.items()),
            )
            out = cs.climate(db, {"A": POINT})
            town = out["towns"][0]
            self.assertTrue(out["any_data"])
            self.assertEqual(town["full_years"], 11)
            self.assertEqual(town["return_levels"]["status"], "ok")
            self.assertEqual(out["first_year"], 2010)


if __name__ == "__main__":
    unittest.main()


class RainRecordTests(unittest.TestCase):
    """Which stored rain record the statistics use (ERA5-only once it is complete)."""

    def db(self, archive_days, era5_days):
        import sqlite3
        con = sqlite3.connect(":memory:")
        con.execute("CREATE TABLE observations (source TEXT, variable TEXT, observed_at TEXT, latitude REAL, longitude REAL, value REAL, unit TEXT, quality_flag TEXT, fetched_at TEXT)")
        for source, n, mm in (("open_meteo_archive", archive_days, 5.0), ("open_meteo_era5", era5_days, 3.0)):
            for i in range(n):
                con.execute("INSERT INTO observations VALUES (?, 'precipitation_sum', ?, 14.5, 120.5, ?, 'mm', 'valid', '')",
                            (source, f"2020-01-{i + 1:02d}", mm))
        return con

    def test_mixed_until_era5_is_nearly_complete(self):
        from app.services import climate_service as cs
        rec = cs.rain_record(self.db(20, 0))
        self.assertEqual(rec["source"], "open_meteo_archive")
        self.assertFalse(rec["consistent"])
        self.assertIn("2017", rec["note"])
        self.assertEqual(cs.rain_record(self.db(20, 10))["source"], "open_meteo_archive")  # half-finished backfill
        rec = cs.rain_record(self.db(20, 19))
        self.assertEqual(rec["source"], "open_meteo_era5")
        self.assertTrue(rec["consistent"])
        self.assertIsNone(rec["note"])

    def test_load_daily_rain_reads_the_chosen_source(self):
        from app.services import climate_service as cs
        con = self.db(3, 3)
        point = {"latitude": 14.5, "longitude": 120.5}
        self.assertEqual(set(cs.load_daily_rain(con, point).values()), {5.0})
        self.assertEqual(set(cs.load_daily_rain(con, point, "open_meteo_era5").values()), {3.0})
