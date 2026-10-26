"""
AGOS flood-risk indicator, rebuilt day by day for the past (default: since
1 August of this year).

For every municipality and every past day D, the same draft RULES as the
live indicator (flood_risk_service.assess_town) are applied to what happened:

  heaviest hour, heaviest 3 hours, 24 h total   rain on day D
  72 h total                                    rain over D-2 .. D
  past 72 h (wet ground)                        rain over the 3 days before D
  soil moisture                                 mean of day D
  river flow                                    GloFAS on D / median of the 30 days before D
  sea level (coastal towns)                     highest value on D vs the 90th
                                                percentile of the 30 daily highs before D
  low ground, MGB                               static layers (only with a rain signal)

Rain is the AGOS consensus (median of six models) from the Open-Meteo
Historical Forecast API: archived short-range model output, not rain-gauge
records. The storm-from-article step is not applied to past days.

This shows what the indicator would have said each day. It has not been
checked against recorded floods, because AGOS has no flood records for
these dates.
"""

from __future__ import annotations

import statistics
from datetime import date, datetime, timedelta
from threading import Lock
from typing import Any, Callable
from zoneinfo import ZoneInfo

from app.data.municipalities import MUNICIPALITIES
from app.services import flood_risk_service as fr
from app.services.analysis_service import BEST_MATCH, MODELS, clean_series
from app.services.consensus_service import combine
from app.services.weather_service import FLOOD_API_URL, _cached_request

PH_TZ = ZoneInfo("Asia/Manila")
HISTORICAL_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
MARINE_URL = fr.MARINE_API_URL
LOOKBACK_DAYS = 30          # baseline window for river flow and tides
ANTECEDENT_DAYS = 3         # rain before the first day
MAX_DAYS = 120
CACHE_SECONDS = 3 * 3600
HISTORY_WINDOWS = {
    "peak_24h": "that day", "peak_3h": "that day", "total_24h": "that day",
    "total_72h": "3 days ending that day", "past_72h": "3 days before that day",
    "soil": "daily mean", "discharge": "that day vs the 30 days before",
    "tide": "that day vs the 30 days before", "low_ground": "static layer", "mgb": "static layer",
}

_cache: dict[tuple, tuple[float, dict]] = {}
_lock = Lock()


def _coords() -> tuple[list[str], str, str]:
    names = list(MUNICIPALITIES)
    return (names, ",".join(str(MUNICIPALITIES[n]["latitude"]) for n in names),
            ",".join(str(MUNICIPALITIES[n]["longitude"]) for n in names))


def _as_list(payload: Any, n: int, what: str) -> list[dict]:
    items = payload if isinstance(payload, list) else [payload]
    if len(items) != n:
        raise RuntimeError(f"{what} returned {len(items)} locations, expected {n}")
    return items


def fetch(start: date, end: date, request: Callable[..., Any] = _cached_request) -> dict[str, Any]:
    names, lats, lons = _coords()
    rain = _as_list(request(HISTORICAL_URL, {
        "latitude": lats, "longitude": lons, "hourly": "precipitation,soil_moisture_0_to_10cm",
        "start_date": (start - timedelta(days=ANTECEDENT_DAYS)).isoformat(), "end_date": end.isoformat(),
        "models": ",".join([BEST_MATCH, *MODELS]), "timezone": "Asia/Manila",
    }, ttl_seconds=CACHE_SECONDS), len(names), "Historical Forecast API")
    base = (start - timedelta(days=LOOKBACK_DAYS)).isoformat()
    try:
        flood = _as_list(request(FLOOD_API_URL, {
            "latitude": lats, "longitude": lons, "daily": "river_discharge",
            "start_date": base, "end_date": end.isoformat(), "cell_selection": "land",
        }, ttl_seconds=CACHE_SECONDS), len(names), "Flood API")
    except RuntimeError:
        flood = [None] * len(names)
    try:
        marine = _as_list(request(MARINE_URL, {
            "latitude": lats, "longitude": lons, "hourly": "sea_level_height_msl",
            "start_date": base, "end_date": end.isoformat(), "timezone": "Asia/Manila",
        }, ttl_seconds=CACHE_SECONDS), len(names), "Marine API")
    except RuntimeError:
        marine = [None] * len(names)
    return {"names": names, "rain": rain, "flood": flood, "marine": marine}


# ------------------------------------------------------------------ per-town daily metrics
def hourly_consensus(location: dict) -> tuple[list[datetime], list[float | None], list[float | None]]:
    """Cleaned hourly consensus rain (median of six models) and default-model soil moisture."""
    hourly = location.get("hourly") or {}
    times = hourly.get("time") or []
    axis, best, _ = clean_series(times, hourly.get(f"precipitation_{BEST_MATCH}") or [None] * len(times), "precipitation")
    models = [clean_series(times, hourly.get(f"precipitation_{m}") or [None] * len(times), "precipitation")[1] for m in MODELS]
    rain = [combine([s[i] for s in models], best[i], rain=True)["value"] for i in range(len(axis))]
    soil_raw = hourly.get(f"soil_moisture_0_to_10cm_{BEST_MATCH}") or [None] * len(times)
    soil = [v if isinstance(v, (int, float)) and 0 <= v <= 0.8 else None for v in soil_raw]
    return axis, rain, soil


def _by_day(axis: list[datetime], values: list) -> dict[date, list]:
    out: dict[date, list] = {}
    for t, v in zip(axis, values):
        out.setdefault(t.date(), []).append(v)
    return out


def _sum(values: list, need: int) -> float | None:
    valid = [v for v in values if v is not None]
    return round(sum(valid), 1) if len(valid) >= need else None


def daily_values(axis: list[datetime], rain: list, soil: list, day: date) -> dict[str, Any]:
    by_day = _by_day(axis, rain)
    today = by_day.get(day, [])
    window3 = [v for d in range(3) for v in by_day.get(day - timedelta(days=d), [])]
    before3 = [v for d in range(1, 4) for v in by_day.get(day - timedelta(days=d), [])]
    sums3 = [sum(today[i:i + 3]) for i in range(len(today) - 2) if None not in today[i:i + 3]]
    valid = [v for v in today if v is not None]
    soil_day = [v for v in _by_day(axis, soil).get(day, []) if v is not None]
    return {
        "peak_24h_mm_h": round(max(valid), 2) if valid else None,
        "peak_3h_mm": round(max(sums3), 1) if sums3 else None,
        "total_24h_mm": _sum(today, 20),
        "total_72h_mm": _sum(window3, 60),
        "past_72h_mm": _sum(before3, 60),
        "soil_moisture": round(statistics.fmean(soil_day), 3) if soil_day else None,
    }


def daily_discharge(location: dict | None, day: date) -> dict[str, Any]:
    empty = {"ratio": None, "forecast_max": None, "median_30d": None}
    if not location:
        return empty
    daily = location.get("daily") or {}
    series = {d: v for d, v in zip(daily.get("time") or [], daily.get("river_discharge") or []) if isinstance(v, (int, float))}
    value = series.get(day.isoformat())
    before = [series[(day - timedelta(days=k)).isoformat()] for k in range(1, LOOKBACK_DAYS + 1)
              if (day - timedelta(days=k)).isoformat() in series]
    if value is None or len(before) < 20:
        return {**empty, "forecast_max": value}
    median = statistics.median(before)
    return {"ratio": round(value / median, 2) if median > 0 else None, "forecast_max": round(value, 2), "median_30d": round(median, 2)}


def daily_highs(location: dict | None) -> dict[date, float]:
    if not location:
        return {}
    hourly = location.get("hourly") or {}
    highs: dict[date, float] = {}
    for stamp, value in zip(hourly.get("time") or [], hourly.get("sea_level_height_msl") or []):
        if not isinstance(value, (int, float)):
            continue
        d = datetime.fromisoformat(stamp).date()
        highs[d] = max(value, highs.get(d, value))
    return highs


def daily_tide(highs: dict[date, float], day: date) -> dict[str, Any]:
    before = [highs[day - timedelta(days=k)] for k in range(1, LOOKBACK_DAYS + 1) if day - timedelta(days=k) in highs]
    if day not in highs or len(before) < 20:
        return {"peak_24h_m": None, "p90_30d_m": None, "high": None}
    p90 = statistics.quantiles(before, n=10)[-1]
    return {"peak_24h_m": round(highs[day], 2), "p90_30d_m": round(p90, 2), "high": highs[day] >= p90}


# ------------------------------------------------------------------ build
LEVEL_KEYS = ["low", "moderate", "high", "very_high", "nodata"]


def build_history(
    start: date | None = None,
    end: date | None = None,
    fetcher: Callable[[date, date], dict] = fetch,
    static_loader: Callable[[], dict] = fr.load_static,
    today: date | None = None,
) -> dict[str, Any]:
    today = today or datetime.now(PH_TZ).date()
    start = start or date(today.year, 8, 1)
    end = end or today - timedelta(days=1)
    if end < start:
        raise ValueError("The end date is before the start date.")
    if (end - start).days + 1 > MAX_DAYS:
        raise ValueError(f"At most {MAX_DAYS} days can be rebuilt at once.")

    data = fetcher(start, end)
    static = (static_loader() or {}).get("towns") or {}
    days = [start + timedelta(days=k) for k in range((end - start).days + 1)]
    towns_out, events = [], []
    for index, name in enumerate(data["names"]):
        axis, rain, soil = hourly_consensus(data["rain"][index])
        highs = daily_highs(data["marine"][index])
        rows = []
        for day in days:
            values = daily_values(axis, rain, soil, day)
            assessed = fr.assess_town(name, values, daily_discharge(data["flood"][index], day), None,
                                      daily_tide(highs, day), static.get(name))
            row = {
                "date": day.isoformat(), "level": assessed["level"], "score": assessed["score"],
                "rain_mm": values["total_24h_mm"], "peak_mm_h": values["peak_24h_mm_h"],
                # factors without the long rule/source texts (those are the same every day)
                "factors": [
                    {k: f[k] for k in ("id", "value", "points", "held_back", "unit", "level", "forecast_max", "median_30d", "p90_30d")
                     if f.get(k) not in (None, 0) or k in ("id", "value", "points")}
                    for f in assessed["factors"]
                ],
            }
            rows.append(row)
            if assessed["level"] in ("moderate", "high", "very_high"):
                events.append({"date": row["date"], "municipality": name, "level": row["level"], "score": row["score"],
                               "rain_mm": row["rain_mm"], "peak_mm_h": row["peak_mm_h"]})
        counts = {k: sum(1 for r in rows if r["level"] == k) for k in LEVEL_KEYS}
        scored = [r for r in rows if r["score"] is not None]
        worst = max(scored, key=lambda r: (r["score"], r["rain_mm"] or 0)) if scored else None
        towns_out.append({
            "municipality": name,
            "days": rows,
            "summary": {
                **counts,
                "rain_total_mm": round(sum(r["rain_mm"] or 0 for r in rows), 1),
                "wettest_day": max(rows, key=lambda r: r["rain_mm"] or 0)["date"] if rows else None,
                "worst_day": worst["date"] if worst else None,
                "worst_score": worst["score"] if worst else None,
                "worst_level": worst["level"] if worst else None,
            },
        })
    rank = {"very_high": 3, "high": 2, "moderate": 1}
    events.sort(key=lambda e: (rank[e["level"]], e["score"] or 0, e["rain_mm"] or 0), reverse=True)
    return {
        "start": start.isoformat(), "end": end.isoformat(), "days": [d.isoformat() for d in days],
        "rules_status": fr.RULES_STATUS,
        "levels_rule": "Total points: 0-2 low, 3-5 moderate, 6-8 high, 9 or more very high.",
        "windows": HISTORY_WINDOWS,
        "source": "AGOS consensus of six models from the Open-Meteo Historical Forecast API; GloFAS river flow; Open-Meteo Marine sea level",
        "municipalities": towns_out,
        "events": events[:40],
        "limitations": [
            "Rebuilt with the draft rules of the live indicator; not checked against recorded floods.",
            "Past rain is archived short-range model output (median of six models), not rain-gauge records.",
            "The storm-from-article step is not applied to past days.",
        ],
    }


def cached_history(start: date | None = None, end: date | None = None) -> dict[str, Any]:
    key = (start, end, datetime.now(PH_TZ).date())
    now = datetime.now().timestamp()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1]
    result = build_history(start, end)
    with _lock:
        _cache[key] = (now, result)
    return result
