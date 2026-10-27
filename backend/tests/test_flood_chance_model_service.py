import json
import random
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from app.services import flood_chance_model_service as cm


def synthetic_records(seed=5, years=range(2010, 2024)):
    """Two towns of fake daily rain with big storms; the wetter, more flood-prone town floods more often."""
    rng = random.Random(seed)
    daily = {"Low": {}, "High": {}}
    events = []
    for town in daily:
        d = date(years[0], 1, 1)
        while d <= date(years[-1], 12, 31):
            storm = rng.random() < 0.03
            daily[town][d.isoformat()] = rng.uniform(40, 120) if storm else rng.uniform(0, 6)
            d += timedelta(days=1)
    return daily, events


def make_events(daily, ground, seed=9):
    rng = random.Random(seed)
    events = []
    for town, series in daily.items():
        days = sorted(series)
        for k, day in enumerate(days):
            if series[day] > 40 and rng.random() < (0.9 if ground[town] > 0.3 else 0.12):
                events.append({"start_date": day, "towns": [{"municipality": town, "evidence": "flooded"}]})
    return events


class MathTests(unittest.TestCase):
    def test_stretch_and_percentile(self):
        self.assertAlmostEqual(cm.stretch(95), 2.9957, places=3)
        self.assertEqual(cm.percentile(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 40.0)

    def test_wilson_p_is_wider_for_fewer_cases(self):
        low_a, high_a = cm.wilson_p(0.05, 100)
        low_b, high_b = cm.wilson_p(0.05, 1000)
        self.assertGreater(high_a - low_a, high_b - low_b)
        self.assertEqual(cm.wilson_p(0.5, 0), (0.0, 1.0))

    def test_band_for(self):
        self.assertEqual([cm.band_for(p, [0.02, 0.06]) for p in (0.01, 0.03, 0.2)], ["lower", "usual", "higher"])


class TrainTests(unittest.TestCase):
    def setUp(self):
        daily, _ = synthetic_records()
        self.ground = {"Low": 0.05, "High": 0.6}
        self.records = {"towns": {k: {"daily": v} for k, v in daily.items()}, "record": {"label": "synthetic"}}
        self.events = make_events(daily, self.ground)
        self.model = cm.train(self.records, self.events, self.ground)

    def test_model_is_fitted_with_bands_that_rise(self):
        m = self.model
        self.assertIsNotNone(m)
        self.assertEqual([b["band"] for b in m["bands"]], ["lower", "usual", "higher"])
        rates = [b["rate"] for b in m["bands"]]
        self.assertLessEqual(rates[0], rates[1])
        self.assertLessEqual(rates[1], rates[2])
        self.assertGreater(m["weights"][3], 0)  # flood-prone ground raises the score here
        for b in m["bands"]:
            self.assertLessEqual(b["range_95"][0], b["rate"] + 1e-9)
            self.assertGreaterEqual(b["range_95"][1], b["rate"] - 1e-9)
        self.assertEqual(m["rain_record"], "synthetic")
        self.assertEqual(m["horizon_days"], 3)

    def test_score_gives_a_band_or_a_reason(self):
        m = self.model
        out = cm.score(m, 99.0, 90.0, 0.6)
        self.assertIn(out["band"], cm.BANDS)
        self.assertEqual(out["confidence"], "low")
        self.assertEqual(out["rate"], next(b for b in m["bands"] if b["band"] == out["band"])["rate"])
        hi = cm.score(m, 99.5, 99.0, 0.6)
        lo = cm.score(m, 91.0, 10.0, 0.05)
        self.assertGreaterEqual(cm.BANDS.index(hi["band"]), cm.BANDS.index(lo["band"]))
        self.assertEqual(cm.score(m, 80.0, 50.0, 0.1), {"band": None, "reason": "below_range"})
        self.assertEqual(cm.score(m, None, 50.0, 0.1), {"band": None, "reason": "missing_input"})
        self.assertEqual(cm.score(m, 99.0, 50.0, None), {"band": None, "reason": "missing_input"})
        self.assertIsNone(cm.score(None, 99.0, 50.0, 0.1))

    def test_too_few_floods_gives_no_model(self):
        self.assertIsNone(cm.train(self.records, [], self.ground))
        self.assertIsNone(cm.train({"towns": {}}, self.events, self.ground))


class FileTests(unittest.TestCase):
    def test_round_trip_and_missing_or_broken_files(self):
        model = {"weights": [0.0, 1.0, 1.0, 1.0], "scale": {"rain": [3, 1], "wet": [3, 1], "ground": [0.1, 0.1]}, "cuts": [0.02, 0.06],
                 "bands": [{"band": "lower", "rate": 0.01}], "entry_percentile": 90.0, "factors": ["wet", "ground"], "horizon_days": 3}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "chance_model.json"
            self.assertIsNone(cm.load(path))
            cm.save(model, path)
            self.assertEqual(cm.load(path)["cuts"], [0.02, 0.06])
            path.write_text("not json", encoding="utf-8")
            self.assertIsNone(cm.load(path))
            path.write_text(json.dumps({"weights": [1]}), encoding="utf-8")
            self.assertIsNone(cm.load(path))


class AgreementTests(unittest.TestCase):
    def test_rows_agree_with_the_command_line_check(self):
        from tools import check_chance_model as tool

        daily, _ = synthetic_records(years=range(2011, 2016))
        ground = {"Low": 0.05, "High": 0.6}
        events = make_events(daily, ground)
        d_dates = {t: {date.fromisoformat(k): v for k, v in s.items()} for t, s in daily.items()}
        floods = cm.flood_starts_by_town(events)
        mine = cm.build_rows(d_dates, floods, ground)
        theirs = tool.build_rows(d_dates, floods, ground, lambda d: False, lambda d: False)
        self.assertEqual(len(mine), len(theirs))
        self.assertEqual(sum(r["y"] for r in mine), sum(r["y"] for r in theirs))
        for a, b in list(zip(mine, theirs))[:200]:
            self.assertAlmostEqual(a["rain"], b["rain"], places=9)
            self.assertAlmostEqual(a["wet"], b["wet"], places=9)


class BuilderTests(unittest.TestCase):
    def test_unreadable_data_says_so_and_saves_nothing(self):
        from contextlib import redirect_stdout
        from io import StringIO
        from unittest import mock

        from tools import build_chance_model as build

        buffer = StringIO()
        with mock.patch.object(build, "gather", side_effect=OSError("no database")), redirect_stdout(buffer):
            code = build.main()
        self.assertEqual(code, 2)
        self.assertIn("Nothing was saved", buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
