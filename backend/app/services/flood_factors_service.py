"""
AGOS — flood factors per town, today or replayed for a past day.

For every town this puts the things AGOS can measure side by side:

- Rain: the tested warning sign (flood_watch_service) for the 3-day rain ending
  today, tomorrow and the day after.
- Wet ground: rain over the last 14 days, ranked against the town's own record.
  Shown as context only; it is NOT part of the sign until it is tested on past
  floods.
- Flood-prone ground: share of the town's land in each official DENR-MGB class,
  and its most susceptible barangays (susceptibility_service).
- Past floods: how many listed floods the town has, the months they came in and
  the barangays named most often (the AGOS flood list).

- Rivers: the named OpenStreetMap waterways that touch the town and their mapped length
  (rivers_service). Context only: not part of the sign.

- Tide: spring tide computed from the moon (tide_service). Context only, untested, and a
  precaution line when the rain is raised and a spring tide falls in the same days.

What is NOT included in the sign, and says so in the answer: tide height and high-tide hours
(no gauge or official table yet), storms (AGOS has no live storm feed) and
dikes and drainage. Rivers are shown for context only and never change the sign.

The town "state" comes from the warning sign alone, so no weights are invented:
  raised    the sign is Watch or higher: flood-prone ground in the town could flood
  ordinary  rain is ordinary
  no_data   not enough rain to rank

Replay (?date=YYYY-MM-DD): the same screen for a past day, using the stored
ERA5 rain record as if it had been the forecast (perfect hindsight, so it shows
what the rule would have said with the rain that actually fell, not what the
forecast said at the time). Listed floods reported around that day are returned
next to it so the two can be compared by eye.

Any day (day_report, used for a storm read from an article): the stored record
when it covers the day, otherwise the Open-Meteo forecast API, which also keeps
recent past days (model analysis) and forecasts today and the next 2 days. Days
before the record and days past the forecast are refused with the reason.

Not an official warning and not a flood probability.
"""

from __future__ import annotations

import time
from collections import Counter
from datetime import date, datetime, timedelta
from typing import Any, Mapping

from app.services import flood_watch_service as fw
from app.services import flood_chance_service
from app.services import rivers_service
from app.services import tide_service

WET_DAYS = 14
RAISED_LEVELS = ("watch", "warning", "high_warning")
NEAR_BEFORE_DAYS = 2  # the rain window starts two days before the replay day
NEAR_AFTER_DAYS = 4
REPLAY_AHEAD_DAYS = fw.FORECAST_DAYS - 1  # a replay day needs rain up to two days later
TOP_BARANGAYS = 5
CACHE_SECONDS = 600
MAX_REPLAY_CACHE = 30
RECENT_PAST_DAYS = 92  # past days the Open-Meteo forecast API keeps

NOT_INCLUDED = (
    "tide",
    "storm",
    "dikes_drainage",
)


# --------------------------------------------------------------------------
# Small pure helpers
# --------------------------------------------------------------------------

def parse_day(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError) as error:
        raise ValueError("date must be YYYY-MM-DD") from error


def window_total(daily: Mapping[str, float | None], end: str, length: int) -> float | None:
    """Sum of `length` days ending on `end`; None when any day is missing."""
    last = date.fromisoformat(end)
    total = 0.0
    for k in range(length):
        value = daily.get((last - timedelta(days=k)).isoformat())
        if value is None:
            return None
        total += value
    return round(total, 1)


def wet_ground(daily: Mapping[str, float | None], end: str, sorted14: list[float]) -> dict[str, Any] | None:
    """Rain over the last 14 days and how unusual that is for this town (all seasons together)."""
    mm = window_total(daily, end, WET_DAYS)
    if mm is None or not sorted14:
        return None
    return {"mm": mm, "days": WET_DAYS, "end": end, "percentile": fw.percentile_in(mm, sorted14)}


def town_state(level: str) -> str:
    if level in RAISED_LEVELS:
        return "raised"
    return "ordinary" if level == "normal" else "no_data"


def flood_history(events: list[Mapping[str, Any]], town: str) -> dict[str, Any]:
    """Listed floods for one town: count, latest, months they came in, barangays named most often."""
    flooded = [e for e in events if any(t["municipality"] == town and t["evidence"] == "flooded" for t in e.get("towns", []))]
    dated = sorted((e["start_date"] for e in flooded if e.get("start_date")), reverse=True)
    months = [0] * 12
    names: Counter[str] = Counter()
    for e in flooded:
        if e.get("start_date"):
            months[int(e["start_date"][5:7]) - 1] += 1
        for t in e.get("towns", []):
            if t["municipality"] == town and t["evidence"] == "flooded":
                names.update(t.get("barangays") or [])
    return {
        "listed_floods": len(flooded),
        "dated_floods": len(dated),
        "latest": dated[0] if dated else None,
        "months": months,
        "barangays": [{"name": n, "count": c} for n, c in names.most_common(TOP_BARANGAYS)],
    }


def susceptibility_for(report: Mapping[str, Any] | None, town: str) -> dict[str, Any] | None:
    if not report or not report.get("available"):
        return None
    row = next((t for t in report.get("towns", []) if t["name"] == town), None)
    if not row or not row.get("shares"):
        return None
    shares = row["shares"]
    return {
        "shares": shares,
        "high_share": round(shares.get("high", 0) + shares.get("very_high", 0), 4),
        "top_barangays": [
            {"name": b["name"], "shares": b["shares"], "high_share": round(b["shares"].get("high", 0) + b["shares"].get("very_high", 0), 4)}
            for b in row.get("top_barangays", [])[:TOP_BARANGAYS]
        ],
        "barangays_unsampled": row.get("barangays_unsampled", []),
        "samples": row.get("samples"),
    }


def events_near(events: list[Mapping[str, Any]], day: str) -> list[dict[str, Any]]:
    """Listed floods reported from two days before (the start of the rain window) to four days after `day` (for a replay)."""
    d = date.fromisoformat(day)
    low, high = d - timedelta(days=NEAR_BEFORE_DAYS), d + timedelta(days=NEAR_AFTER_DAYS)
    out = []
    for e in events:
        if not e.get("start_date"):
            continue
        start, end = date.fromisoformat(e["start_date"]), date.fromisoformat(e.get("end_date") or e["start_date"])
        if end < low or start > high:
            continue
        out.append({
            "id": e["id"], "start": e["start_date"], "end": e.get("end_date") or e["start_date"],
            "towns": [t["municipality"] for t in e.get("towns", []) if t["evidence"] == "flooded"],
            "confidence": e.get("confidence"),
            "sources": [{"publisher": s["publisher"], "url": s["url"], "published": s.get("published")} for s in e.get("sources", [])[:2]],
        })
    return sorted(out, key=lambda x: x["start"])


def replay_range(records: Mapping[str, Any]) -> dict[str, Any] | None:
    """Days that can be replayed: 14 days of rain behind them and 2 days ahead, for every town."""
    firsts = [r["first"] for r in records["towns"].values() if r.get("first")]
    lasts = [r["last"] for r in records["towns"].values() if r.get("last")]
    if not firsts or not lasts:
        return None
    low = date.fromisoformat(max(firsts)) + timedelta(days=WET_DAYS - 1)
    high = date.fromisoformat(min(lasts)) - timedelta(days=REPLAY_AHEAD_DAYS)
    if high < low:
        return None
    return {"min": low.isoformat(), "max": high.isoformat()}


def day_source(day: str, today: str, span: Mapping[str, str] | None) -> str:
    """
    Which rain AGOS can use for `day`:
      replay         the stored record covers it (rain that actually fell)
      forecast       the Open-Meteo forecast API covers it (recent model analysis, or forecast up to today + 2)
      too_far_ahead  after the forecast AGOS uses
      no_record      before the stored record and too old for the forecast API
    """
    d, t = date.fromisoformat(day), date.fromisoformat(today)
    if span and span["min"] <= day <= span["max"]:
        return "replay"
    if d > t + timedelta(days=fw.FORECAST_DAYS - 1):
        return "too_far_ahead"
    if (t - d).days + WET_DAYS <= RECENT_PAST_DAYS:
        return "forecast"
    return "no_record"


def replay_choices(events: list[Mapping[str, Any]], span: Mapping[str, str] | None) -> list[dict[str, Any]]:
    """Listed floods that fall inside the replayable days, newest first, to jump to."""
    if not span:
        return []
    out = []
    for e in events:
        start = e.get("start_date")
        if start and span["min"] <= start <= span["max"]:
            out.append({
                "id": e["id"], "date": start,
                "towns": [t["municipality"] for t in e.get("towns", []) if t["evidence"] == "flooded"],
            })
    return sorted(out, key=lambda x: x["date"], reverse=True)


# --------------------------------------------------------------------------
# One answer for all towns
# --------------------------------------------------------------------------

def build_factors(
    inputs: Mapping[str, Mapping[str, Any]],
    *,
    mode: str,
    day: str,
    events: list[Mapping[str, Any]],
    model_report: Mapping[str, Any] | None,
    rain_record: Mapping[str, Any] | None,
    susceptibility: Mapping[str, Any] | None,
    issued_at: str,
    replay: Mapping[str, Any] | None = None,
    rivers: Mapping[str, Mapping[str, Any]] | None = None,
    with_events_near: bool = False,
    chance: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """
    inputs[town] = {"daily": [(date, mm|None) x 5 days: day-2 .. day+2],
                    "wet": wet_ground dict or None, "sorted3": [...]}.
    """
    towns = []
    for name, item in inputs.items():
        watch = fw.town_watch(item["daily"], item["sorted3"], day)
        towns.append({
            "name": name,
            "state": town_state(watch["level"]),
            "rain": watch,
            "wet_ground": item.get("wet"),
            "susceptibility": susceptibility_for(susceptibility, name),
            "floods": flood_history(events, name),
            "rivers": (rivers or {}).get(name),
            # Past frequency for the sign level this town is at now (province-wide, context for the sign; not a forecast).
            "chance": flood_chance_service.for_level(chance, watch["level"]) if town_state(watch["level"]) == "raised" else None,
        })
    tide = tide_service.build_tide(day, events)
    for t in towns:
        # Rain is unusual AND a spring tide falls in the same days: a precaution line only, never part of the sign.
        t["tide_overlap"] = t["state"] == "raised" and tide["spring_in_window"]
    order = {"high_warning": 0, "warning": 1, "watch": 2, "normal": 3, "no_data": 4}
    towns.sort(key=lambda t: (order[t["rain"]["level"]], -(t["rain"].get("peak") or {}).get("mm", 0)))
    return {
        "mode": mode,
        "date": day,
        "issued_at": issued_at,
        "raised": [t["name"] for t in towns if t["state"] == "raised"],
        "towns": towns,
        "levels": [{"name": n, "min_percentile": m} for n, m in fw.LEVELS],
        "backing": fw.backing(model_report),
        "events_near": events_near(events, day) if mode == "replay" or with_events_near else [],
        "replay": {
            **(replay or {}),
            "choices": replay_choices(events, replay) if replay else [],
        } if replay else None,
        "rain_record": rain_record,
        "tide": tide,
        "chance": ({**chance, "includes_replayed_day": mode == "replay"} if chance else None),
        "not_included": list(NOT_INCLUDED),
        "sources": {
            "rain": ("ERA5 reanalysis stored by AGOS (recorded rain, used here as if it had been the forecast)"
                     if mode == "replay" else
                     "Open-Meteo Forecast API, daily precipitation (model forecast and recent model analysis; not a rain gauge)"),
            "record": (rain_record or {}).get("label"),
            "susceptibility": (susceptibility or {}).get("sources", {}).get("susceptibility"),
            "floods": "AGOS flood events list (news and official reports)",
            "rivers": rivers_service.SOURCE if rivers else None,
        },
        "notes": [
            "AGOS calculation from public data. Not an official warning and not a flood probability; follow PAGASA and your MDRRMO.",
            "'Raised' only means the rain is unusual for the town. Flood-prone ground (MGB) shows where flooding is possible; it does not show depth or extent.",
            "Wet ground is shown for context and is not part of the sign: it has not been tested on past floods yet.",
            "Tide, storms, dikes and drainage are not part of the sign. Rivers and spring tide (from the moon, not a tide gauge) are shown for context only.",
        ],
    }


# --------------------------------------------------------------------------
# Data loading (database, Open-Meteo)
# --------------------------------------------------------------------------

_records_cache: dict[str, Any] = {"at": 0.0, "value": None}
_result_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def load_records(connect=None) -> dict[str, Any]:
    """Stored rain per town (date -> mm) with sorted 3-day and 14-day totals. Cached for ten minutes."""
    if _records_cache["value"] is not None and time.time() - _records_cache["at"] < CACHE_SECONDS:
        return _records_cache["value"]
    from app.data.municipalities import MUNICIPALITIES
    from app.services import evidence_service
    from app.services.climate_service import load_daily_rain, rain_record

    connection = (connect or evidence_service._default_connect)()
    try:
        record = rain_record(connection)
        towns = {}
        for name, point in MUNICIPALITIES.items():
            daily = load_daily_rain(connection, point, record["source"])
            days = sorted(daily)
            towns[name] = {
                "daily": daily,
                "first": days[0] if days else None,
                "last": days[-1] if days else None,
                "sorted3": sorted(evidence_service.rolling_sums(daily, 3).values()),
                "sorted14": sorted(evidence_service.rolling_sums(daily, WET_DAYS).values()),
            }
    finally:
        connection.close()
    value = {"record": record, "towns": towns}
    _records_cache.update(at=time.time(), value=value)
    return value


def _forecast_inputs(forecasts: Mapping[str, list[tuple[str, float | None]]], records: Mapping[str, Any], today: str) -> dict[str, dict[str, Any]]:
    start = date.fromisoformat(today)
    keep = {(start + timedelta(days=k)).isoformat() for k in range(-(fw.PAST_DAYS), fw.FORECAST_DAYS)}
    out = {}
    for name, series in forecasts.items():
        by_day = dict(series)
        rec = records["towns"].get(name, {})
        out[name] = {
            "daily": [(d, v) for d, v in series if d in keep],
            "wet": wet_ground(by_day, today, rec.get("sorted14", [])),
            "sorted3": rec.get("sorted3", []),
        }
    return out


def _replay_inputs(records: Mapping[str, Any], day: str) -> dict[str, dict[str, Any]]:
    start = date.fromisoformat(day)
    days = [(start + timedelta(days=k)).isoformat() for k in range(-(fw.PAST_DAYS), fw.FORECAST_DAYS)]
    out = {}
    for name, rec in records["towns"].items():
        daily = rec["daily"]
        out[name] = {
            "daily": [(d, daily.get(d)) for d in days],
            "wet": wet_ground(daily, day, rec["sorted14"]),
            "sorted3": rec["sorted3"],
        }
    return out


def _context() -> tuple[list[Mapping[str, Any]], Any, Any, Mapping[str, Any]]:
    """Flood list, model backing, MGB shares and rivers (the last three optional)."""
    from app.data.municipalities import MUNICIPALITIES
    from app.services import evidence_service, flood_events_service, flood_model_service, susceptibility_service

    events = flood_events_service.events_report(connect=evidence_service._default_connect, municipalities=MUNICIPALITIES)["events"]
    try:
        model = flood_model_service.model_report()
    except Exception:  # noqa: BLE001 - the backing line is optional
        model = None
    try:
        susc = susceptibility_service.susceptibility_report()
    except Exception:  # noqa: BLE001 - the map data stands alone
        susc = None
    try:
        rivers = rivers_service.towns_for_factors()
    except Exception:  # noqa: BLE001 - rivers are context only
        rivers = {}
    return events, model, susc, rivers


_chance_cache: dict[str, Any] = {"key": None, "value": None}


def _chance(records: Mapping[str, Any], events: list[Mapping[str, Any]]) -> dict[str, Any] | None:
    """The past-frequency table; cached while the stored record and the flood list are the same objects."""
    key = (id(records), len(events))
    if _chance_cache["key"] != key:
        try:
            value = flood_chance_service.chance_from_records(records, events)
        except Exception:  # noqa: BLE001 - optional; the sign stands alone
            value = None
        _chance_cache.update(key=key, value=value)
    return _chance_cache["value"]


def _remember(key: str, value: dict[str, Any]) -> None:
    if len(_result_cache) >= MAX_REPLAY_CACHE:
        _result_cache.pop(next(iter(_result_cache)))
    _result_cache[key] = (time.time(), value)


def factors_report(on: str | None = None, use_cache: bool = True) -> dict[str, Any]:
    """Today (from the forecast) or, with `on`, a past day replayed from the stored rain record."""
    from zoneinfo import ZoneInfo

    from app.data.municipalities import MUNICIPALITIES

    now = datetime.now(ZoneInfo("Asia/Manila"))
    key = on or "now"
    if on:
        parse_day(on)
    if use_cache and key in _result_cache and time.time() - _result_cache[key][0] < CACHE_SECONDS:
        return _result_cache[key][1]

    records = load_records()
    span = replay_range(records)
    if on and (not span or not (span["min"] <= on <= span["max"])):
        raise ValueError(
            f"No rain record for {on}. Replay needs stored rain" + (f" between {span['min']} and {span['max']}." if span else ".")
        )
    events, model, susc, rivers = _context()

    if on:
        inputs = _replay_inputs(records, on)
        value = build_factors(inputs, mode="replay", day=on, events=events, model_report=model, rain_record=records["record"],
                              susceptibility=susc, issued_at=now.isoformat(timespec="minutes"), replay=span, rivers=rivers,
                              chance=_chance(records, events))
    else:
        forecasts = fw.fetch_forecasts(MUNICIPALITIES, past_days=WET_DAYS)
        today = now.date().isoformat()
        inputs = _forecast_inputs(forecasts, records, today)
        value = build_factors(inputs, mode="forecast", day=today, events=events, model_report=model, rain_record=records["record"],
                              susceptibility=susc, issued_at=now.isoformat(timespec="minutes"), replay=span, rivers=rivers,
                              chance=_chance(records, events))
    _remember(key, value)
    return value


def day_report(day: str, use_cache: bool = True) -> dict[str, Any]:
    """
    The same answer for any day the data reach: the stored record (replay) when it covers the day,
    otherwise the forecast API (recent past days or up to today + 2). Listed floods around the day are
    always returned. Raises ValueError with the reason for days no source covers.
    """
    from zoneinfo import ZoneInfo

    from app.data.municipalities import MUNICIPALITIES

    parse_day(day)
    now = datetime.now(ZoneInfo("Asia/Manila"))
    today = now.date().isoformat()
    records = load_records()
    span = replay_range(records)
    source = day_source(day, today, span)
    if source == "replay":
        return factors_report(on=day, use_cache=use_cache)
    if source == "too_far_ahead":
        last = (date.fromisoformat(today) + timedelta(days=fw.FORECAST_DAYS - 1)).isoformat()
        raise ValueError(f"{day} is after the forecast AGOS uses (today to {last}). Check again closer to that day.")
    if source == "no_record":
        held = f" The stored rain record covers {span['min']} to {span['max']}." if span else " No rain record is stored yet."
        raise ValueError(f"No rain data for {day}.{held} Load more years with tools/backfill_history.py.")

    key = f"day:{day}"
    if use_cache and key in _result_cache and time.time() - _result_cache[key][0] < CACHE_SECONDS:
        return _result_cache[key][1]
    events, model, susc, rivers = _context()
    past_days = max(fw.PAST_DAYS, (date.fromisoformat(today) - date.fromisoformat(day)).days + WET_DAYS)
    forecasts = fw.fetch_forecasts(MUNICIPALITIES, past_days=past_days)
    inputs = _forecast_inputs(forecasts, records, day)
    value = build_factors(inputs, mode="forecast", day=day, events=events, model_report=model, rain_record=records["record"],
                          susceptibility=susc, issued_at=now.isoformat(timespec="minutes"), replay=span, rivers=rivers,
                          chance=_chance(records, events), with_events_near=True)
    _remember(key, value)
    return value
