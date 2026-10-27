import unittest
from unittest import mock

from app.services import flood_factors_service as ff

RECORD3 = sorted(float(i) for i in range(1000))   # 3-day totals 0..999 mm
RECORD14 = sorted(float(i) for i in range(1000))  # 14-day totals 0..999 mm


def five_days(values, start="2026-10-24"):
    from datetime import date, timedelta

    first = date.fromisoformat(start)
    return [((first + timedelta(days=i)).isoformat(), v) for i, v in enumerate(values)]


def long_daily(end="2026-10-26", length=20, mm=10.0, hole=None):
    from datetime import date, timedelta

    last = date.fromisoformat(end)
    out = {(last - timedelta(days=k)).isoformat(): mm for k in range(length)}
    if hole:
        out[hole] = None
    return out


EVENTS = [
    {"id": "e1", "start_date": "2021-07-25", "end_date": "2021-07-25", "confidence": "high",
     "towns": [{"municipality": "Hermosa", "evidence": "flooded", "barangays": ["Almacen"]},
               {"municipality": "Samal", "evidence": "road", "barangays": []}],
     "sources": [{"publisher": "P", "url": "https://example.org/1", "published": "2021-07-26"}]},
    {"id": "e2", "start_date": "2021-07-29", "end_date": "2021-07-30", "confidence": "high",
     "towns": [{"municipality": "Hermosa", "evidence": "flooded", "barangays": ["Almacen", "Pulo"]}],
     "sources": []},
    {"id": "e3", "start_date": None, "end_date": None, "confidence": "low",
     "towns": [{"municipality": "Hermosa", "evidence": "flooded", "barangays": []}], "sources": []},
]


class SmallPartsTests(unittest.TestCase):
    def test_window_total_needs_every_day(self):
        self.assertEqual(ff.window_total(long_daily(), "2026-10-26", 14), 140.0)
        self.assertIsNone(ff.window_total(long_daily(hole="2026-10-20"), "2026-10-26", 14))
        self.assertIsNone(ff.window_total(long_daily(length=5), "2026-10-26", 14))

    def test_wet_ground_is_ranked_against_the_record(self):
        out = ff.wet_ground(long_daily(), "2026-10-26", RECORD14)
        self.assertEqual((out["mm"], out["days"]), (140.0, 14))
        self.assertEqual(out["percentile"], 14.0)
        self.assertIsNone(ff.wet_ground(long_daily(), "2026-10-26", []))

    def test_state_comes_from_the_sign_only(self):
        self.assertEqual([ff.town_state(x) for x in ("watch", "warning", "high_warning", "normal", "no_data")],
                         ["raised", "raised", "raised", "ordinary", "no_data"])

    def test_flood_history_counts_months_and_named_barangays(self):
        h = ff.flood_history(EVENTS, "Hermosa")
        self.assertEqual((h["listed_floods"], h["dated_floods"], h["latest"]), (3, 2, "2021-07-29"))
        self.assertEqual(h["months"][6], 2)
        self.assertEqual(h["barangays"][0], {"name": "Almacen", "count": 2})
        self.assertEqual(ff.flood_history(EVENTS, "Samal")["listed_floods"], 0)  # a road closure is not a flood

    def test_events_near_a_replay_day(self):
        near = ff.events_near(EVENTS, "2021-07-27")
        self.assertEqual([e["id"] for e in near], ["e1", "e2"])
        self.assertEqual(near[0]["towns"], ["Hermosa"])
        self.assertEqual(ff.events_near(EVENTS, "2020-01-01"), [])

    def test_susceptibility_for_a_town(self):
        report = {"available": True, "towns": [{"name": "Hermosa", "shares": {"high": 0.18, "very_high": 0.0, "moderate": 0.1, "low": 0.2, "not_rated": 0.52},
                                                  "top_barangays": [{"name": "Almacen", "shares": {"high": 1.0, "very_high": 0.0}}],
                                                  "barangays_unsampled": ["X"], "samples": 900}]}
        out = ff.susceptibility_for(report, "Hermosa")
        self.assertEqual(out["high_share"], 0.18)
        self.assertEqual(out["top_barangays"][0]["high_share"], 1.0)
        self.assertIsNone(ff.susceptibility_for(report, "Orani"))
        self.assertIsNone(ff.susceptibility_for({"available": False}, "Hermosa"))
        self.assertIsNone(ff.susceptibility_for(None, "Hermosa"))

    def test_replay_range_needs_14_days_behind_and_2_ahead(self):
        records = {"towns": {"A": {"first": "1990-01-01", "last": "2026-10-20"}, "B": {"first": "1990-01-05", "last": "2026-10-18"}}}
        self.assertEqual(ff.replay_range(records), {"min": "1990-01-18", "max": "2026-10-16"})
        self.assertIsNone(ff.replay_range({"towns": {"A": {"first": None, "last": None}}}))
        self.assertIsNone(ff.replay_range({"towns": {"A": {"first": "2026-10-01", "last": "2026-10-10"}}}))

    def test_day_source_picks_the_record_then_the_forecast_api(self):
        span = {"min": "1990-01-18", "max": "2026-10-16"}
        today = "2026-10-26"
        self.assertEqual(ff.day_source("2022-09-25", today, span), "replay")
        self.assertEqual(ff.day_source("2026-10-20", today, span), "forecast")  # after the record, recent past
        self.assertEqual(ff.day_source("2026-10-26", today, span), "forecast")
        self.assertEqual(ff.day_source("2026-10-28", today, span), "forecast")  # today + 2
        self.assertEqual(ff.day_source("2026-10-29", today, span), "too_far_ahead")
        self.assertEqual(ff.day_source("1980-01-01", today, span), "no_record")
        # Without a stored record, only the forecast API's recent days are left (92 days, 14 for wet ground).
        self.assertEqual(ff.day_source("2026-08-15", today, None), "forecast")
        self.assertEqual(ff.day_source("2026-07-01", today, None), "no_record")

    def test_replay_choices_stay_inside_the_range_and_skip_undated(self):
        choices = ff.replay_choices(EVENTS, {"min": "2021-07-26", "max": "2030-01-01"})
        self.assertEqual([c["id"] for c in choices], ["e2"])


class BuildTests(unittest.TestCase):
    def inputs(self):
        return {
            "Calm": {"daily": five_days([1, 1, 1, 1, 1]), "wet": {"mm": 20, "days": 14, "end": "2026-10-26", "percentile": 5.0}, "sorted3": RECORD3},
            "Wet": {"daily": five_days([0, 0, 0, 985, 0]), "wet": None, "sorted3": RECORD3},
            "Hermosa": {"daily": five_days([1, 1, None, 1, 1]), "wet": None, "sorted3": RECORD3},
        }

    def build(self, **over):
        args = dict(mode="forecast", day="2026-10-26", events=EVENTS, model_report=None, rain_record={"label": "x", "consistent": True},
                    susceptibility=None, issued_at="2026-10-26T10:00+08:00")
        args.update(over)
        return ff.build_factors(self.inputs(), **args)

    def test_raised_towns_come_first_and_are_listed(self):
        out = self.build()
        self.assertEqual(out["raised"], ["Wet"])
        self.assertEqual([t["name"] for t in out["towns"]][0], "Wet")
        self.assertEqual({t["name"]: t["state"] for t in out["towns"]}, {"Wet": "raised", "Calm": "ordinary", "Hermosa": "no_data"})
        self.assertEqual(out["towns"][-1]["name"], "Hermosa")  # a town without rain data goes last

    def test_every_answer_says_what_is_left_out(self):
        out = self.build()
        self.assertEqual(out["not_included"], ["tide", "storm", "dikes_drainage"])
        self.assertIn("Not an official warning", out["notes"][0])
        self.assertIn("not part of the sign", out["notes"][2])
        self.assertIn("shown for context only", out["notes"][3])
        self.assertNotIn("rivers", out["not_included"])
        self.assertIsNone(out["replay"])
        self.assertEqual(out["events_near"], [])

    def test_tide_is_context_only_and_overlap_needs_a_raised_town(self):
        out = self.build()
        self.assertFalse(out["tide"]["part_of_sign"])
        self.assertEqual(len(out["tide"]["days"]), 5)
        self.assertIn("tested", out["tide"])
        by_name = {t["name"]: t for t in out["towns"]}
        self.assertEqual(by_name["Calm"]["tide_overlap"], False)  # ordinary rain never gets the line
        self.assertEqual(by_name["Wet"]["tide_overlap"], out["tide"]["spring_in_window"])
        self.assertIs(by_name["Hermosa"]["tide_overlap"], False)

    def test_rivers_are_context_only_and_do_not_change_the_sign(self):
        plain = self.build()
        with_rivers = self.build(rivers={"Calm": {"names": ["Test River"], "length_km": 12.3}})
        self.assertEqual({t["name"]: t["rivers"] for t in plain["towns"]}, {"Wet": None, "Calm": None, "Hermosa": None})
        by_name = {t["name"]: t for t in with_rivers["towns"]}
        self.assertEqual(by_name["Calm"]["rivers"], {"names": ["Test River"], "length_km": 12.3})
        self.assertIsNone(by_name["Wet"]["rivers"])
        self.assertIsNone(plain["sources"]["rivers"])
        self.assertIn("OpenStreetMap", with_rivers["sources"]["rivers"])
        for a, b in zip(plain["towns"], with_rivers["towns"]):  # the sign and everything else are identical
            self.assertEqual({k: v for k, v in a.items() if k != "rivers"}, {k: v for k, v in b.items() if k != "rivers"})
        self.assertEqual(plain["raised"], with_rivers["raised"])
        self.assertEqual(plain["not_included"], with_rivers["not_included"])

    def test_replay_returns_reported_floods_beside_the_rain(self):
        out = self.build(mode="replay", day="2021-07-27", replay={"min": "2000-01-01", "max": "2026-10-01"})
        self.assertEqual([e["id"] for e in out["events_near"]], ["e1", "e2"])
        self.assertEqual(out["replay"]["min"], "2000-01-01")
        self.assertEqual([c["id"] for c in out["replay"]["choices"]], ["e2", "e1"])
        self.assertIn("recorded rain", out["sources"]["rain"])

    def test_floods_and_sign_are_attached_per_town(self):
        town = next(t for t in self.build()["towns"] if t["name"] == "Hermosa")
        self.assertEqual(town["floods"]["listed_floods"], 3)
        # one missing day sits inside all three windows, so there is no sign (never counted as zero)
        self.assertEqual(town["rain"]["level"], "no_data")
        self.assertEqual(town["state"], "no_data")


class InputTests(unittest.TestCase):
    def records(self):
        daily = long_daily(end="2026-10-28", length=40)
        return {"record": {"label": "x"}, "towns": {"A": {
            "daily": daily, "first": "2026-09-19", "last": "2026-10-28",
            "sorted3": RECORD3, "sorted14": RECORD14}}}

    def test_replay_uses_two_days_before_and_two_after(self):
        out = ff._replay_inputs(self.records(), "2026-10-26")["A"]
        self.assertEqual([d for d, _ in out["daily"]], ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"])
        self.assertEqual(out["wet"]["mm"], 140.0)

    def test_forecast_keeps_five_days_and_ranks_the_long_past_for_wet_ground(self):
        series = [(d, 10.0) for d in sorted(long_daily(end="2026-10-28", length=17))]
        out = ff._forecast_inputs({"A": series}, self.records(), "2026-10-26")["A"]
        self.assertEqual(len(out["daily"]), 5)
        self.assertEqual(out["daily"][0][0], "2026-10-24")
        self.assertEqual(out["wet"]["mm"], 140.0)


class ReportTests(unittest.TestCase):
    def setUp(self):
        ff._result_cache.clear()
        ff._records_cache.update(at=0.0, value=None)

    def patched(self):
        records = {"record": {"label": "ERA5", "consistent": True}, "towns": {
            "Hermosa": {"daily": long_daily(end="2026-10-20", length=60), "first": "2026-08-22", "last": "2026-10-20",
                        "sorted3": RECORD3, "sorted14": RECORD14}}}
        return [
            mock.patch.object(ff, "load_records", return_value=records),
            mock.patch("app.services.flood_events_service.events_report", return_value={"events": EVENTS}),
            mock.patch("app.services.flood_model_service.model_report", return_value={"summary": {"town_years": 1}, "rain": {"table": []}}),
            mock.patch("app.services.susceptibility_service.susceptibility_report", return_value={"available": False}),
            mock.patch("app.services.rivers_service.towns_for_factors", return_value={"Hermosa": {"names": ["Test River"], "length_km": 5.0}}),
            mock.patch("app.data.municipalities.MUNICIPALITIES", {"Hermosa": {"latitude": 14.8, "longitude": 120.5}}),
        ]

    def run_with(self, fn):
        patches = self.patched()
        for p in patches:
            p.start()
        try:
            return fn()
        finally:
            for p in reversed(patches):
                p.stop()

    def test_replay_of_a_day_outside_the_record_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            self.run_with(lambda: ff.factors_report(on="2010-01-01"))
        self.assertIn("between 2026-09-04 and 2026-10-18", str(caught.exception))

    def test_bad_date_is_refused(self):
        with self.assertRaises(ValueError):
            ff.factors_report(on="26-10-2026")

    def test_replay_report_reads_the_stored_record(self):
        out = self.run_with(lambda: ff.factors_report(on="2026-10-10"))
        self.assertEqual((out["mode"], out["date"]), ("replay", "2026-10-10"))
        self.assertEqual(out["towns"][0]["rain"]["level"], "normal")
        self.assertEqual(out["towns"][0]["wet_ground"]["mm"], 140.0)
        self.assertEqual(out["replay"]["max"], "2026-10-18")
        self.assertEqual(out["towns"][0]["rivers"], {"names": ["Test River"], "length_km": 5.0})

    def test_today_report_uses_the_forecast_and_the_record(self):
        series = [(d, 10.0) for d in sorted(long_daily(end="2026-10-28", length=17))]
        fixed = mock.MagicMock()
        fixed.date.return_value.isoformat.return_value = "2026-10-26"
        fixed.isoformat.return_value = "2026-10-26T10:00+08:00"
        with mock.patch("app.services.flood_watch_service.fetch_forecasts", return_value={"Hermosa": series}) as fetch, \
                mock.patch("app.services.flood_factors_service.datetime") as clock:
            clock.now.return_value = fixed
            out = self.run_with(lambda: ff.factors_report())
        self.assertEqual(fetch.call_args.kwargs["past_days"], 14)
        self.assertEqual((out["mode"], out["date"]), ("forecast", "2026-10-26"))
        self.assertEqual(out["towns"][0]["wet_ground"]["mm"], 140.0)

    def clock(self, today="2026-10-26"):
        fixed = mock.MagicMock()
        fixed.date.return_value.isoformat.return_value = today
        fixed.isoformat.return_value = f"{today}T10:00+08:00"
        patcher = mock.patch("app.services.flood_factors_service.datetime")
        clock = patcher.start()
        self.addCleanup(patcher.stop)
        clock.now.return_value = fixed

    def test_day_report_replays_a_day_inside_the_record(self):
        self.clock()
        out = self.run_with(lambda: ff.day_report("2026-10-10"))
        self.assertEqual((out["mode"], out["date"]), ("replay", "2026-10-10"))

    def test_day_report_uses_the_forecast_api_for_a_recent_day_and_lists_floods_near_it(self):
        self.clock()
        series = [(d, 10.0) for d in sorted(long_daily(end="2026-10-28", length=40))]
        events = EVENTS + [{"id": "e4", "start_date": "2026-10-22", "end_date": "2026-10-23", "confidence": "high",
                            "towns": [{"municipality": "Hermosa", "evidence": "flooded", "barangays": []}], "sources": []}]
        with mock.patch("app.services.flood_watch_service.fetch_forecasts", return_value={"Hermosa": series}) as fetch:
            patches = self.patched()
            patches[1] = mock.patch("app.services.flood_events_service.events_report", return_value={"events": events})
            for p in patches:
                p.start()
            try:
                out = ff.day_report("2026-10-22")
            finally:
                for p in reversed(patches):
                    p.stop()
        self.assertEqual(fetch.call_args.kwargs["past_days"], 4 + ff.WET_DAYS)
        self.assertEqual((out["mode"], out["date"]), ("forecast", "2026-10-22"))
        self.assertEqual([e["id"] for e in out["events_near"]], ["e4"])
        self.assertEqual(out["towns"][0]["rain"]["peak"]["mm"], 30.0)

    def test_day_report_refuses_days_no_source_covers(self):
        self.clock()
        with self.assertRaises(ValueError) as ahead:
            self.run_with(lambda: ff.day_report("2026-11-05"))
        self.assertIn("after the forecast AGOS uses (today to 2026-10-28)", str(ahead.exception))
        with self.assertRaises(ValueError) as old:
            self.run_with(lambda: ff.day_report("2010-01-01"))
        self.assertIn("covers 2026-09-04 to 2026-10-18", str(old.exception))


if __name__ == "__main__":
    unittest.main()
