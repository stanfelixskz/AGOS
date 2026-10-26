"""
Rain metrics across models. No network; numbers are invented.
"""

import unittest
from datetime import datetime, timedelta

from app.services import rain_metrics as rm
from app.services.analysis_service import PH_TZ

START = datetime(2026, 8, 28, 0, 0, tzinfo=PH_TZ)
AXIS = [START - timedelta(hours=72) + timedelta(hours=h) for h in range(72 + 96)]


def shower_at(hour, mm=10.0):
    """One model: a single 10 mm shower at a given hour of 28 Aug, dry otherwise."""
    return [mm if t == START + timedelta(hours=hour) else 0.0 for t in AXIS]


class BugTests(unittest.TestCase):
    def test_hourly_medians_wash_out_rain_that_models_put_in_different_hours(self):
        models = [shower_at(h) for h in (2, 5, 8, 11, 14, 17)]  # every model: 10 mm, in a different hour
        hourly_median_total = sum(sorted(m[i] for m in models)[2:4][0] for i in range(len(AXIS))
                                  if START <= AXIS[i] < START + timedelta(days=1))
        self.assertEqual(hourly_median_total, 0.0)                       # the old way: no rain at all
        ens = rm.ensemble_metrics(AXIS, models, START, "day")
        self.assertEqual(ens["total_24h_mm"], 10.0)                      # per model first: 10 mm
        self.assertEqual(ens["peak_24h_mm_h"], 10.0)


class CombineTests(unittest.TestCase):
    def test_median_and_upper(self):
        values = [8.0, 22.0, 23.0, 30.0, 48.0, 66.0]
        self.assertEqual(rm.combine(values, "median"), 26.5)
        self.assertEqual(rm.combine(values, "upper"), 48.0)   # second-wettest of six
        self.assertIsNone(rm.combine([5.0, None, None], "median"))

    def test_windows_by_mode(self):
        series = [1.0] * len(AXIS)
        day = rm.series_metrics(AXIS, series, START, "day")
        self.assertEqual((day["total_24h_mm"], day["total_72h_mm"], day["past_72h_mm"]), (24.0, 72.0, 72.0))
        fc = rm.series_metrics(AXIS, series, START, "forecast")
        self.assertEqual((fc["total_24h_mm"], fc["total_72h_mm"]), (24.0, 72.0))
