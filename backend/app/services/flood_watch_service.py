"""
AGOS — flood warning sign for today and the next 2 days, per town.

This applies the alert rule tested in flood_model_service ("3-day rain in the
town's top X% of its own record") to the newest rain:

- Rain: Open-Meteo forecast API, daily precipitation for the 2 past days, today
  and the next 2 days (one model run, so past and future come from one source).
- The largest 3-day total among the windows ending today, tomorrow and the day
  after is ranked against the town's own record (the same stored rain record the
  Analytics statistics use: ERA5-only once loaded, otherwise the mixed default).
- Levels (fixed, same as the tested levels):
    high_warning  3-day rain in the town's top 1%
    warning       top 2%   (the level the year-by-year test chose)
    watch         top 5%
    normal        below that
- Backing: for each level, how many listed past floods had rain at least that
  unusual (from the all-years table of flood_model_service), so the screen can say
  how often rain like this came before past floods.

Honest limits (returned with the data)
- Not an official warning and not a flood probability. Forecast rain is model
  output and can be wrong, especially for thunderstorms and typhoon tracks.
- The forecast model is not the record model, so the rank is approximate.
- Tide, dikes, upstream rain and drainage are not included.
"""

from __future__ import annotations

import time
from bisect import bisect_left
from datetime import date, timedelta
from typing import Any, Callable, Iterable, Mapping

LEVELS = (  # (name, minimum percentile)
    ("high_warning", 99.0),
    ("warning", 98.0),
    ("watch", 95.0),
)
PAST_DAYS = 2
FORECAST_DAYS = 3  # today + 2


def level_for(percentile: float | None) -> str:
    if percentile is None:
        return "no_data"
    for name, minimum in LEVELS:
        if percentile >= minimum:
            return name
    return "normal"


def percentile_in(value: float, sorted_values: list[float]) -> float | None:
    """Share (0-100) of the record strictly lower than `value` (same definition as the evidence check)."""
    if not sorted_values:
        return None
    return round(100.0 * bisect_left(sorted_values, value) / len(sorted_values), 1)


def three_day_windows(daily: list[tuple[str, float | None]], today: str) -> list[dict[str, Any]]:
    """3-day totals ending today, tomorrow and the day after; a window with a missing day is left out."""
    values = dict(daily)
    out = []
    start = date.fromisoformat(today)
    for offset in range(FORECAST_DAYS):
        end = start + timedelta(days=offset)
        days = [(end - timedelta(days=k)).isoformat() for k in (2, 1, 0)]
        if all(values.get(d) is not None for d in days):
            out.append({"start": days[0], "end": days[-1], "mm": round(sum(values[d] for d in days), 1)})
    return out


def town_watch(
    daily: list[tuple[str, float | None]],
    sorted3: list[float],
    today: str,
) -> dict[str, Any]:
    windows = three_day_windows(daily, today)
    if not windows or not sorted3:
        return {"level": "no_data", "windows": windows, "daily": [{"date": d, "mm": v} for d, v in daily]}
    for w in windows:
        w["percentile"] = percentile_in(w["mm"], sorted3)
    peak = max(windows, key=lambda w: w["mm"])
    thresholds = {name: round(sorted3[min(len(sorted3) - 1, int(len(sorted3) * minimum / 100))], 1) for name, minimum in LEVELS}
    return {
        "level": level_for(peak["percentile"]),
        "peak": peak,
        "windows": windows,
        "daily": [{"date": d, "mm": v} for d, v in daily],
        "thresholds_mm": thresholds,
    }


def backing(model_report: Mapping[str, Any] | None) -> dict[str, Any]:
    """Per level: listed floods whose 3-day rain reached that level (all years together)."""
    table = (model_report or {}).get("rain", {}).get("table") or []
    by_threshold = {row["threshold"]: row for row in table}
    out = {}
    for name, minimum in LEVELS:
        row = by_threshold.get(minimum)
        if row:
            out[name] = {
                "caught": row["caught"], "cases": row["cases"],
                "share": row["recall"], "range": row["recall_range"],
                "alerts_per_town_year": round(row["episodes"] / model_report["summary"]["town_years"], 1)
                if model_report.get("summary", {}).get("town_years") else None,
            }
    return out


def town_floods(events: Iterable[Mapping[str, Any]], town: str) -> dict[str, Any]:
    flooded = [e for e in events if any(t["municipality"] == town and t["evidence"] == "flooded" for t in e.get("towns", []))]
    dated = sorted((e["start_date"] for e in flooded if e.get("start_date")), reverse=True)
    return {"listed_floods": len(flooded), "latest": dated[0] if dated else None}


def build_watch(
    forecasts: Mapping[str, list[tuple[str, float | None]]],
    records: Mapping[str, list[float]],
    events: list[Mapping[str, Any]],
    model_report: Mapping[str, Any] | None,
    rain_record: Mapping[str, Any] | None,
    today: str,
    issued_at: str,
) -> dict[str, Any]:
    order = {"high_warning": 0, "warning": 1, "watch": 2, "normal": 3, "no_data": 4}
    towns = []
    for name, daily in forecasts.items():
        towns.append({"name": name, **town_watch(daily, records.get(name, []), today), **town_floods(events, name)})
    towns.sort(key=lambda t: (order[t["level"]], -(t.get("peak") or {}).get("mm", 0)))
    return {
        "issued_at": issued_at,
        "today": today,
        "towns": towns,
        "levels": [{"name": n, "min_percentile": m} for n, m in LEVELS],
        "backing": backing(model_report),
        "rain_record": rain_record,
        "sources": {
            "forecast": "Open-Meteo Forecast API, daily precipitation (model forecast and recent model analysis; not a rain gauge)",
            "record": (rain_record or {}).get("label"),
            "events": "AGOS flood events list (news and official reports)",
        },
        "notes": [
            "AGOS calculation from public model data. Not an official warning and not a flood probability; follow PAGASA and your MDRRMO.",
            "The forecast model is not the model of the rain record, so the rank is approximate.",
            "Tide, dikes, upstream rain and drainage are not included.",
        ],
    }


def fetch_forecasts(
    municipalities: Mapping[str, Mapping[str, float]],
    request: Callable[..., Any] | None = None,
    past_days: int = PAST_DAYS,
) -> dict[str, list[tuple[str, float | None]]]:
    """Daily precipitation, `past_days` past days (default 2) + today + 2, for every town in one request."""
    if request is None:
        from app.config.settings import OPEN_METEO_URL
        from app.services.weather_service import CACHE_TTL_SECONDS, FORECAST_TIMEZONE, _cached_request

        def request(params):
            return _cached_request(OPEN_METEO_URL, {**params, "timezone": FORECAST_TIMEZONE}, ttl_seconds=CACHE_TTL_SECONDS)
    names = list(municipalities)
    payload = request({
        "latitude": ",".join(str(municipalities[n]["latitude"]) for n in names),
        "longitude": ",".join(str(municipalities[n]["longitude"]) for n in names),
        "daily": "precipitation_sum",
        "past_days": past_days,
        "forecast_days": FORECAST_DAYS,
        "precipitation_unit": "mm",
    })
    if isinstance(payload, dict):
        payload = [payload]
    if not isinstance(payload, list) or len(payload) != len(names):
        raise RuntimeError("Open-Meteo returned an unexpected number of town forecasts")
    out = {}
    for name, item in zip(names, payload):
        daily = (item or {}).get("daily") or {}
        out[name] = list(zip(daily.get("time") or [], daily.get("precipitation_sum") or []))
    return out


_cache: dict[str, Any] = {"at": 0.0, "value": None}
CACHE_SECONDS = 600


def watch_report(use_cache: bool = True) -> dict[str, Any]:
    if use_cache and _cache["value"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
        return _cache["value"]
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from app.data.municipalities import MUNICIPALITIES
    from app.services import evidence_service, flood_events_service, flood_model_service
    from app.services.climate_service import load_daily_rain, rain_record

    forecasts = fetch_forecasts(MUNICIPALITIES)
    connect = evidence_service._default_connect
    connection = connect()
    try:
        record = rain_record(connection)
        records = {
            name: sorted(evidence_service.rolling_sums(load_daily_rain(connection, point, record["source"]), 3).values())
            for name, point in MUNICIPALITIES.items()
        }
    finally:
        connection.close()
    events = flood_events_service.events_report(connect=connect, municipalities=MUNICIPALITIES)["events"]
    model = flood_model_service.model_report()
    now = datetime.now(ZoneInfo("Asia/Manila"))
    value = build_watch(forecasts, records, events, model, record, now.date().isoformat(), now.isoformat(timespec="minutes"))
    _cache.update(at=time.time(), value=value)
    return value
