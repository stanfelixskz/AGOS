"""
AGOS — flood evidence: how unusual were rain and river flow before known floods?

For every dated past flood event (flood_events_service) and every town the
sources name as flooded, this compares the rain (and modeled river flow) just
before the flood with that town's own record in the AGOS database.

Definitions (also returned to the interface)
- Window: from 2 days before the event's first date to its last date. Reports
  often come a day after the heaviest rain, and floods follow rain.
- Rain: largest 1-day rain and largest 3-day total ending inside the window,
  plus the 7-day total ending on the last event day. Only complete windows count;
  a missing day makes the value empty, never zero.
- Percentile: share of the town's whole record (every complete 1-day or 3-day
  value) that is lower. 99 means "wetter than 99% of all 3-day spells".
- Chance baseline: windows are several days long and floods happen in the wet
  season, so even a random wet-season window often contains a wet spell. For each
  case we measure, on the same town's record, how often a window of the same
  length ending within 30 days of the same date of the year (any year) reaches the
  town's top 5% of 3-day totals. Comparing the flood cases with that
  season-matched baseline is the honest test.

Limits
- Rain is ERA5 reanalysis at one point per town (modeled, smoothed over ~25 km);
  river flow is modeled GloFAS (8 of 12 towns). Floods also come from upstream
  rain, high tide and broken dikes, which this does not see.
- The events list misses small floods, so this measures "how wet was it before
  reported floods", not how often wet spells cause floods.
"""

from __future__ import annotations

import sqlite3
import time
from datetime import date, timedelta
from statistics import median
from typing import Any, Callable, Iterable, Mapping

from app.services.climate_service import TOLERANCE_DEG, load_daily_rain, rain_record

DAYS_BEFORE = 2
TOP_PERCENT = 5.0
SEASON_DAYS = 30


def load_daily_flow(connection: sqlite3.Connection, point: Mapping[str, float]) -> dict[str, float]:
    rows = connection.execute(
        "SELECT observed_at, value FROM observations "
        "WHERE variable = 'river_discharge' AND source = 'open_meteo_glofas' AND quality_flag = 'valid' "
        "AND ABS(latitude - ?) < ? AND ABS(longitude - ?) < ?",
        (point["latitude"], TOLERANCE_DEG, point["longitude"], TOLERANCE_DEG),
    ).fetchall()
    return {str(r[0])[:10]: float(r[1]) for r in rows}


def _days(start: date, end: date) -> list[str]:
    return [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]


def rolling_sums(daily: Mapping[str, float], length: int) -> dict[str, float]:
    """End date -> sum of `length` consecutive days, only where every day is present."""
    out: dict[str, float] = {}
    for day in daily:
        end = date.fromisoformat(day)
        window = _days(end - timedelta(days=length - 1), end)
        if all(d in daily for d in window):
            out[day] = sum(daily[d] for d in window)
    return out


def percentile_of(value: float, values: list[float]) -> float:
    """Share (0-100) of `values` strictly lower than `value`; `values` must be sorted."""
    lo, hi = 0, len(values)
    while lo < hi:
        mid = (lo + hi) // 2
        if values[mid] < value:
            lo = mid + 1
        else:
            hi = mid
    return round(100.0 * lo / len(values), 1)


def in_top(value: float, sorted_values: list[float], top_percent: float = TOP_PERCENT) -> bool:
    """True when at least (100 - top_percent)% of the record is strictly lower (ties never count as top)."""
    return percentile_of(value, sorted_values) >= 100 - top_percent


class TownRecord:
    """One town's rain and flow record, with the sorted values percentiles need."""

    def __init__(self, rain: Mapping[str, float], flow: Mapping[str, float]):
        self.rain = dict(rain)
        self.flow = dict(flow)
        self.rain3 = rolling_sums(self.rain, 3)
        self.sorted1 = sorted(self.rain.values())
        self.sorted3 = sorted(self.rain3.values())
        self.sorted_flow = sorted(self.flow.values())
        self._flags: dict[int, dict[str, bool]] = {}
        self._top: dict[int, bool] | None = None
        # day of the year for every 3-day end date, parsed once (the season filter needs it often)
        self._doy = {d: date.fromisoformat(d).timetuple().tm_yday for d in self.rain3}
        self.first = min(self.rain) if self.rain else None
        self.last = max(self.rain) if self.rain else None

    def _window_flags(self, window_days: int) -> dict[str, bool]:
        """End date -> does the window of this length ending there contain a top-5% 3-day total?"""
        if window_days not in self._flags:
            if self._top is None:
                # once per town: is each 3-day total in the top 5%? (keyed by day number)
                self._top = {date.fromisoformat(d).toordinal(): in_top(v, self.sorted3) for d, v in self.rain3.items()}
            top = self._top
            flags: dict[str, bool] = {}
            for end in self.rain3:
                last = date.fromisoformat(end).toordinal()
                hit = False
                complete = True
                for day in range(last - window_days + 1, last + 1):
                    value = top.get(day)
                    if value is None:
                        complete = False
                        break
                    hit = hit or value
                if complete:
                    # the largest total is in the top 5% exactly when any total is
                    flags[end] = hit
            self._flags[window_days] = flags
        return self._flags[window_days]

    def baseline(self, window_days: int, around: date | None = None) -> float | None:
        """
        Share of windows of this length that contain a top-5% 3-day total. With `around`,
        only windows ending within SEASON_DAYS of the same day of the year (any year) count,
        so a wet-season flood is compared with wet-season windows, not the whole year.
        """
        flags = self._window_flags(window_days)
        if around is not None:
            target = around.timetuple().tm_yday
            doy = self._doy
            hits = total = 0
            for end, hit in flags.items():
                gap = abs(doy[end] - target)
                if min(gap, 365 - gap) <= SEASON_DAYS:
                    total += 1
                    hits += hit
            return round(hits / total, 4) if total else None
        if not flags:
            return None
        return round(sum(flags.values()) / len(flags), 4)


def case_metrics(record: TownRecord, start: date, end: date) -> dict[str, Any]:
    window = _days(start - timedelta(days=DAYS_BEFORE), end)
    out: dict[str, Any] = {"window": [window[0], window[-1]]}
    if not record.rain or window[-1] < record.first or window[0] > record.last:
        out["status"] = "outside_record"
        return out
    if not all(d in record.rain for d in window) or not all(d in record.rain3 for d in window):
        out["status"] = "incomplete"
        return out
    max1_day = max(window, key=lambda d: record.rain[d])
    max3_end = max(window, key=lambda d: record.rain3[d])
    seven = _days(end - timedelta(days=6), end)
    out.update({
        "status": "ok",
        "max_1day_mm": round(record.rain[max1_day], 1),
        "max_1day_date": max1_day,
        "max_1day_percentile": percentile_of(record.rain[max1_day], record.sorted1),
        "max_3day_mm": round(record.rain3[max3_end], 1),
        "max_3day_end": max3_end,
        "max_3day_percentile": percentile_of(record.rain3[max3_end], record.sorted3),
        "total_7day_mm": round(sum(record.rain[d] for d in seven), 1) if all(d in record.rain for d in seven) else None,
        "top5_3day": in_top(record.rain3[max3_end], record.sorted3),
        "chance_top5_same_window": record.baseline(len(window), around=end),
    })
    flow_days = [d for d in window if d in record.flow]
    if record.flow and len(flow_days) == len(window):
        peak = max(flow_days, key=lambda d: record.flow[d])
        out["max_flow_m3s"] = round(record.flow[peak], 2)
        out["max_flow_percentile"] = percentile_of(record.flow[peak], record.sorted_flow)
    return out


def evidence(events: Iterable[Mapping[str, Any]], records: Mapping[str, TownRecord]) -> dict[str, Any]:
    rows = []
    skipped = []
    for event in events:
        if not event.get("start_date"):
            skipped.append({"id": event["id"], "reason": "no date"})
            continue
        start, end = date.fromisoformat(event["start_date"]), date.fromisoformat(event["end_date"])
        towns = []
        for town in event["towns"]:
            if town["evidence"] != "flooded" or town["municipality"] not in records:
                continue
            towns.append({"municipality": town["municipality"], **case_metrics(records[town["municipality"]], start, end)})
        ok = [t for t in towns if t["status"] == "ok"]
        rows.append({
            "id": event["id"],
            "start_date": event["start_date"],
            "end_date": event["end_date"],
            "confidence": event.get("confidence"),
            "storm": event.get("storm"),
            "cause": event.get("cause"),
            "sources": event.get("sources", []),
            "towns": towns,
            "towns_with_data": len(ok),
            "max_3day_mm": max((t["max_3day_mm"] for t in ok), default=None),
            "median_3day_percentile": round(median(t["max_3day_percentile"] for t in ok), 1) if ok else None,
            "any_top5": any(t["top5_3day"] for t in ok) if ok else None,
        })

    cases = [t for r in rows for t in r["towns"] if t["status"] == "ok"]
    baselines = [t["chance_top5_same_window"] for t in cases if t["chance_top5_same_window"] is not None]
    summary = {
        "events": len(rows) + len(skipped),
        "events_dated": len(rows),
        "events_with_rain_data": sum(1 for r in rows if r["towns_with_data"]),
        "cases": len(cases),
        "cases_top5": sum(1 for t in cases if t["top5_3day"]),
        "share_top5": round(sum(1 for t in cases if t["top5_3day"]) / len(cases), 3) if cases else None,
        "chance_top5": round(sum(baselines) / len(baselines), 3) if baselines else None,
        "median_3day_percentile": round(median(t["max_3day_percentile"] for t in cases), 1) if cases else None,
        "cases_with_flow": sum(1 for t in cases if "max_flow_percentile" in t),
        "median_flow_percentile": round(median(t["max_flow_percentile"] for t in cases if "max_flow_percentile" in t), 1)
        if any("max_flow_percentile" in t for t in cases) else None,
        "cases_outside_record": sum(1 for r in rows for t in r["towns"] if t["status"] == "outside_record"),
        "cases_incomplete": sum(1 for r in rows for t in r["towns"] if t["status"] == "incomplete"),
    }
    first = [r.first for r in records.values() if r.first]
    last = [r.last for r in records.values() if r.last]
    return {
        "summary": summary,
        "events": sorted(rows, key=lambda r: r["start_date"], reverse=True),
        "skipped": skipped,
        "record": {"first": min(first) if first else None, "last": max(last) if last else None},
        "definitions": {
            "window_days_before": DAYS_BEFORE,
            "top_percent": TOP_PERCENT,
            "percentile": "share of the town's own record (all complete 1-day or 3-day values) that is lower",
            "chance_top5": "average, over the cases, of how often a window of the same length, ending within 30 days of the same date of the year (any year) on the same town's record, contains a top-5% 3-day total",
            "season_days": SEASON_DAYS,
        },
        "sources": {
            "rain": "Open-Meteo Historical Weather API (ERA5 reanalysis, modeled; not a rain gauge)",
            "flow": "Open-Meteo Flood API / GloFAS (modeled discharge; 8 of 12 towns)",
            "events": "AGOS flood events list (news and official reports; /api/flood-events)",
        },
        "notes": [
            "Only towns the sources name as flooded are tested.",
            "Events before the rain record starts cannot be tested; loading older years (backfill --from-year 1990) adds them.",
            "Floods can also come from upstream rain, high tide or broken dikes, which point rain does not show.",
            "Small floods are missing from the events list, so this cannot say how often a wet spell leads to a flood.",
        ],
    }


def _default_connect() -> sqlite3.Connection:
    from agos_data_lifecycle import _connect, _init_db  # lazy: needs FastAPI

    _init_db()
    return _connect()


_cache: dict[str, Any] = {"at": 0.0, "value": None}
CACHE_SECONDS = 600


def evidence_report(
    connect: Callable[[], sqlite3.Connection] | None = None,
    municipalities: Mapping[str, Mapping[str, float]] | None = None,
    events: list[Mapping[str, Any]] | None = None,
    use_cache: bool = True,
) -> dict[str, Any]:
    if use_cache and connect is None and _cache["value"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
        return _cache["value"]
    if municipalities is None:
        from app.data.municipalities import MUNICIPALITIES

        municipalities = MUNICIPALITIES
    caller_connect = connect
    connect = connect or _default_connect
    if events is None:
        from app.services import flood_events_service

        events = flood_events_service.events_report(connect=connect, municipalities=municipalities)["events"]
    connection = connect()
    try:
        record = rain_record(connection)
        records = {
            name: TownRecord(load_daily_rain(connection, point, record["source"]), load_daily_flow(connection, point))
            for name, point in municipalities.items()
        }
    finally:
        connection.close()
    value = evidence(events, records)
    value["rain_record"] = record
    value["sources"]["rain"] = record["label"]
    if caller_connect is None:
        _cache.update(at=time.time(), value=value)
    return value
