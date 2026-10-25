"""
AGOS — flood alert rule, tested honestly against the known past floods.

This is NOT a probability forecast. It tests the simplest possible rule and
reports what it would have done on the record we have:

    ALERT on a day when the town's 3-day rain total is in the top (100 - t)% of
    that town's own record (t = 90, 92.5, 95, 97, 98 or 99).
    Variant for towns with modeled river flow: alert when rain OR flow reaches t.

Definitions
- Alert episode: consecutive alert days (a gap of one day is merged).
- Flood window of a known event in a flooded town: first date minus 3 days to last
  date plus 1 day (2 days before as in the evidence check, plus one day of slack
  each side because reports are dated loosely).
- Caught: an event-town case with at least one alert day in its window.
- Hit episode: an alert episode that overlaps the window of a known flood in that town.
- Recall = caught / cases. "Precision" = hit episodes / episodes.

Honest limits
- The events list misses small floods, so an episode with no listed flood may have
  been a real unreported flood. Precision is therefore a LOWER BOUND, and the
  false-alarm count an UPPER BOUND on real false alarms.
- Few events (see `cases`) means wide ranges; the Wilson 95% range is returned.
- Leave-one-year-out: for each year, the threshold is chosen on the OTHER years
  (best F1) and judged on the held-out year, so the score is not fitted to itself.
- Rain is ERA5 (modeled), flow is GloFAS (modeled, 8 of 12 towns). Tide, dikes and
  upstream rain are not seen.
"""

from __future__ import annotations

import math
import time
from datetime import date, timedelta
from typing import Any, Callable, Iterable, Mapping

from app.services.evidence_service import (
    DAYS_BEFORE,
    TownRecord,
    load_daily_flow,
    percentile_of,
)
from app.services.climate_service import load_daily_rain, rain_record

THRESHOLDS = (90.0, 92.5, 95.0, 97.0, 98.0, 99.0)
SLACK_AFTER = 1
MIN_CASES = 8


def wilson(k: int, n: int, z: float = 1.96) -> list[float] | None:
    """Wilson 95% interval for k of n, as fractions."""
    if n <= 0:
        return None
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0.0, centre - half), 3), round(min(1.0, centre + half), 3)]


class Series:
    """One town: daily percentiles of 3-day rain and flow, and its known flood windows."""

    def __init__(self, record: TownRecord):
        self.rain_pct = {d: percentile_of(v, record.sorted3) for d, v in record.rain3.items()}
        self.flow_pct = {d: percentile_of(v, record.sorted_flow) for d, v in record.flow.items()} if record.flow else {}
        self.has_flow = bool(record.flow)
        self.first = record.first
        self.last = record.last
        self.windows: list[tuple[int, int]] = []  # inclusive ordinals of the case windows with complete data
        self.record = record

    def add_case(self, start: date, end: date) -> bool:
        """Register a flood window; False if the rain record does not fully cover it."""
        lo = start - timedelta(days=DAYS_BEFORE + 1)
        hi = end + timedelta(days=SLACK_AFTER)
        days = [(lo + timedelta(days=i)).isoformat() for i in range((hi - lo).days + 1)]
        if not all(d in self.rain_pct for d in days):
            return False
        self.windows.append((lo.toordinal(), hi.toordinal()))
        return True

    def alert_days(self, t: float, rule: str) -> list[int]:
        days = {d for d, p in self.rain_pct.items() if p >= t}
        if rule == "rain_or_flow":
            days |= {d for d, p in self.flow_pct.items() if p >= t and d in self.rain_pct}
        return sorted(date.fromisoformat(d).toordinal() for d in days)


def episodes(days: list[int]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for d in days:
        if out and d - out[-1][1] <= 2:  # gap of one empty day is merged
            out[-1] = (out[-1][0], d)
        else:
            out.append((d, d))
    return out


def _year(ordinal: int) -> int:
    return date.fromordinal(ordinal).year


def score(series: Mapping[str, Series], t: float, rule: str, years: set[int] | None = None) -> dict[str, int]:
    """Counts over the given calendar years (by episode start / window start); None means all."""
    eps = hit_eps = cases = caught = 0
    for s in series.values():
        days = s.alert_days(t, rule)
        alert_set = set(days)
        for first, last in episodes(days):
            if years is not None and _year(first) not in years:
                continue
            eps += 1
            if any(first <= hi and last >= lo for lo, hi in s.windows):
                hit_eps += 1
        for lo, hi in s.windows:
            if years is not None and _year(lo) not in years:
                continue
            cases += 1
            if any(d in alert_set for d in range(lo, hi + 1)):
                caught += 1
    return {"episodes": eps, "hit_episodes": hit_eps, "cases": cases, "caught": caught}


def _rates(c: Mapping[str, int]) -> dict[str, Any]:
    recall = c["caught"] / c["cases"] if c["cases"] else None
    precision = c["hit_episodes"] / c["episodes"] if c["episodes"] else None
    f1 = (2 * precision * recall / (precision + recall)) if precision and recall else 0.0
    return {
        **c,
        "recall": round(recall, 3) if recall is not None else None,
        "recall_range": wilson(c["caught"], c["cases"]),
        "precision_lower_bound": round(precision, 3) if precision is not None else None,
        "precision_range": wilson(c["hit_episodes"], c["episodes"]),
        "f1": round(f1, 3),
    }


def _years(series: Mapping[str, Series]) -> list[int]:
    ys: set[int] = set()
    for s in series.values():
        if s.first and s.last:
            ys.update(range(int(s.first[:4]), int(s.last[:4]) + 1))
    return sorted(ys)


def leave_one_year_out(series: Mapping[str, Series], rule: str, grid: Iterable[float] = THRESHOLDS) -> dict[str, Any]:
    grid = tuple(grid)
    years = _years(series)
    total = {"episodes": 0, "hit_episodes": 0, "cases": 0, "caught": 0}
    chosen: dict[int, float] = {}
    for y in years:
        train = set(years) - {y}
        best_t, best_f = grid[-1], -1.0
        for t in grid:
            f = _rates(score(series, t, rule, train))["f1"]
            if f >= best_f:  # ties go to the stricter (later) threshold
                best_t, best_f = t, f
        chosen[y] = best_t
        c = score(series, best_t, rule, {y})
        for k in total:
            total[k] += c[k]
    return {"rule": rule, "result": _rates(total), "chosen_by_year": {str(y): t for y, t in chosen.items()}}


def build_series(events: Iterable[Mapping[str, Any]], records: Mapping[str, TownRecord]) -> tuple[dict[str, Series], int, int]:
    series = {name: Series(r) for name, r in records.items() if r.rain}
    known = untestable = 0
    for e in events:
        if not e.get("start_date") or not e.get("end_date"):
            continue
        start, end = date.fromisoformat(e["start_date"]), date.fromisoformat(e["end_date"])
        for tw in e.get("towns", []):
            if tw.get("evidence") != "flooded" or tw["municipality"] not in series:
                continue
            known += 1
            if not series[tw["municipality"]].add_case(start, end):
                untestable += 1
    return series, known, untestable


def model_report_from(events: Iterable[Mapping[str, Any]], records: Mapping[str, TownRecord]) -> dict[str, Any]:
    series, known, untestable = build_series(events, records)
    cases = sum(len(s.windows) for s in series.values())
    flow_series = {n: s for n, s in series.items() if s.has_flow}
    seasons_years = len(_years(series))
    town_years = sum(
        int(s.last[:4]) - int(s.first[:4]) + 1 for s in series.values() if s.first and s.last
    )

    def table(subset: Mapping[str, Series], rule: str) -> list[dict[str, Any]]:
        return [{"threshold": t, **_rates(score(subset, t, rule))} for t in THRESHOLDS]

    enough = cases >= MIN_CASES
    return {
        "summary": {
            "cases": cases,
            "cases_untestable": untestable,
            "cases_known": known,
            "towns": len(series),
            "years": seasons_years,
            "town_years": town_years,
            "enough_cases": enough,
            "min_cases": MIN_CASES,
        },
        "rain": {"table": table(series, "rain"), "leave_one_year_out": leave_one_year_out(series, "rain") if enough else None},
        "flow_towns": {
            "towns": sorted(flow_series),
            "cases": sum(len(s.windows) for s in flow_series.values()),
            "rain_only": table(flow_series, "rain"),
            "rain_or_flow": table(flow_series, "rain_or_flow"),
            "leave_one_year_out_rain": leave_one_year_out(flow_series, "rain") if flow_series and sum(len(s.windows) for s in flow_series.values()) >= MIN_CASES else None,
            "leave_one_year_out_rain_or_flow": leave_one_year_out(flow_series, "rain_or_flow") if flow_series and sum(len(s.windows) for s in flow_series.values()) >= MIN_CASES else None,
        },
        "definitions": {
            "thresholds": list(THRESHOLDS),
            "window": f"first flood date minus {DAYS_BEFORE + 1} days to last flood date plus {SLACK_AFTER} day",
            "episode": "consecutive alert days; a single empty day is merged",
            "precision": "alert episodes that overlap a listed flood, divided by all alert episodes (lower bound: unlisted small floods count as false alarms)",
            "recall": "listed town-floods with at least one alert day inside their window",
            "validation": "leave-one-year-out: threshold chosen on the other years by best F1, judged on the held-out year",
        },
        "sources": {
            "rain": "Open-Meteo Historical Weather API (ERA5 reanalysis, modeled; not a rain gauge)",
            "flow": "Open-Meteo Flood API / GloFAS (modeled discharge; 8 of 12 towns)",
            "events": "AGOS flood events list (news and official reports; /api/flood-events)",
        },
        "notes": [
            "This tests an alert rule on past data. It is not a forecast and gives no flood probability.",
            "Unlisted small floods count as false alarms here, so precision is a lower bound.",
            "Tide, broken dikes and upstream rain are not seen by this rule.",
        ],
    }


_cache: dict[str, Any] = {"at": 0.0, "value": None}
CACHE_SECONDS = 600


def model_report(
    connect: Callable[[], Any] | None = None,
    municipalities: Mapping[str, Mapping[str, float]] | None = None,
    events: list[Mapping[str, Any]] | None = None,
    use_cache: bool = True,
) -> dict[str, Any]:
    if use_cache and connect is None and _cache["value"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
        return _cache["value"]
    from app.services import evidence_service

    if municipalities is None:
        from app.data.municipalities import MUNICIPALITIES

        municipalities = MUNICIPALITIES
    caller_connect = connect
    connect = connect or evidence_service._default_connect
    if events is None:
        from app.services import flood_events_service

        events = flood_events_service.events_report(connect=connect, municipalities=municipalities)["events"]
    connection = connect()
    try:
        record = rain_record(connection)
        records = {
            name: TownRecord(load_daily_rain(connection, p, record["source"]), load_daily_flow(connection, p))
            for name, p in municipalities.items()
        }
    finally:
        connection.close()
    value = model_report_from(events, records)
    value["rain_record"] = record
    value["sources"]["rain"] = record["label"]
    if caller_connect is None:
        _cache.update(at=time.time(), value=value)
    return value
