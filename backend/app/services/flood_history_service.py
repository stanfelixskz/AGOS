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

import json
import statistics
from datetime import date, datetime, timedelta
from pathlib import Path
from threading import Lock
from typing import Any, Callable
from zoneinfo import ZoneInfo

from app.data.municipalities import MUNICIPALITIES
from app.services import flood_risk_service as fr
from app.services.analysis_service import BEST_MATCH, MODELS, clean_series
from app.services.rain_metrics import METRICS, ensemble_metrics, series_metrics
from app.services.weather_service import FLOOD_API_URL, _cached_request

PH_TZ = ZoneInfo("Asia/Manila")
HISTORICAL_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
MARINE_URL = fr.MARINE_API_URL
LOOKBACK_DAYS = 30          # baseline window for river flow and tides
ANTECEDENT_DAYS = 3         # rain before the first day
MAX_DAYS = 120
CACHE_SECONDS = 3 * 3600
HISTORY_WINDOWS = {
    "peak_24h": "that day", "peak_3h": "that day", "upstream": "that day, high ground", "total_24h": "that day",
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


def fetch(start: date, end: date, request: Callable[..., Any] = _cached_request,
          upstream: dict[str, list[dict]] | None = None) -> dict[str, Any]:
    names, lats, lons = _coords()
    if upstream is None:
        try:
            from app.services.susceptibility_service import upstream_points

            upstream = upstream_points()
        except Exception:  # noqa: BLE001 - terrain layer not built: no upstream factor
            upstream = {}
    # Town points first, then every town's upstream points, in one request.
    extra = [(name, p) for name in names for p in upstream.get(name, [])]
    all_lats = lats + "".join(f",{p['latitude']}" for _, p in extra)
    all_lons = lons + "".join(f",{p['longitude']}" for _, p in extra)
    rain_all = _as_list(request(HISTORICAL_URL, {
        "latitude": all_lats, "longitude": all_lons, "hourly": "precipitation,soil_moisture_0_to_10cm",
        "start_date": (start - timedelta(days=ANTECEDENT_DAYS)).isoformat(), "end_date": end.isoformat(),
        "models": ",".join([BEST_MATCH, *MODELS]), "timezone": "Asia/Manila",
    }, ttl_seconds=CACHE_SECONDS), len(names) + len(extra), "Historical Forecast API")
    rain = rain_all[:len(names)]
    upstream_rain: dict[str, list[dict]] = {}
    for (name, point), location in zip(extra, rain_all[len(names):]):
        upstream_rain.setdefault(name, []).append({"point": point, "location": location})
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
    return {"names": names, "rain": rain, "upstream": upstream_rain, "flood": flood, "marine": marine}


# ------------------------------------------------------------------ per-town daily metrics
def model_series(location: dict) -> dict[str, Any]:
    """Cleaned hourly rain of every model (kept separate), the default model, and soil moisture."""
    hourly = location.get("hourly") or {}
    times = hourly.get("time") or []
    axis, best, _ = clean_series(times, hourly.get(f"precipitation_{BEST_MATCH}") or [None] * len(times), "precipitation")
    models = [clean_series(times, hourly.get(f"precipitation_{m}") or [None] * len(times), "precipitation")[1] for m in MODELS]
    soil_raw = hourly.get(f"soil_moisture_0_to_10cm_{BEST_MATCH}") or [None] * len(times)
    soil = [v if isinstance(v, (int, float)) and 0 <= v <= 0.8 else None for v in soil_raw]
    return {"axis": axis, "models": models, "best": best, "soil": soil}


def daily_values(series: dict, day: date, statistic: str = "median", upstream: list[dict] | None = None) -> dict[str, Any]:
    """
    Rain metrics of day D: computed per model, then combined (rain_metrics). The
    default model is used only if fewer than 3 models have data. Upstream =
    the wettest of the town's high-ground points (24 h total, same combination).
    """
    start = datetime(day.year, day.month, day.day, tzinfo=PH_TZ)
    ens = ensemble_metrics(series["axis"], series["models"], start, "day", statistic)
    if ens["models"] < 3:
        ens = {**ens, **series_metrics(series["axis"], series["best"], start, "day")}
    soil_day = [v for t, v in zip(series["axis"], series["soil"]) if t.date() == day and v is not None]
    ups = []
    for item in upstream or []:
        u = ensemble_metrics(item["axis"], item["models"], start, "day", statistic)["total_24h_mm"]
        if u is not None:
            ups.append(u)
    # Rain shown to people is the best guess (middle model); the scored value may be the cautious one.
    best_guess = ens if statistic == "median" else ensemble_metrics(series["axis"], series["models"], start, "day", "median")
    return {
        **{m: ens[m] for m in METRICS},
        "total_24h_median_mm": best_guess["total_24h_mm"] if best_guess["models"] >= 3 else ens["total_24h_mm"],
        "upstream_24h_mm": round(max(ups), 1) if ups else None,
        "soil_moisture": round(statistics.fmean(soil_day), 3) if soil_day else None,
        "models_low_high_24h": _low_high([pm["total_24h_mm"] for pm in ens.get("per_model", [])]),
    }


def _low_high(values: list) -> list | None:
    valid = [v for v in values if v is not None]
    return [min(valid), max(valid)] if valid else None


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
REPORTED_FILE = Path(__file__).resolve().parents[1] / "data" / "reported_floods.json"
RANK = {"nodata": -1, "low": 0, "moderate": 1, "high": 2, "very_high": 3}


def load_reported(path: Path = REPORTED_FILE) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"events": [], "note": None}


def evaluate(towns_out: list[dict], reported: dict) -> list[dict]:
    """For each reported flood and town: the highest level the indicator gave in the event window."""
    rows = []
    for event in reported.get("events", []):
        for name in event["towns"]:
            town = next((t for t in towns_out if t["municipality"] == name), None)
            window = [d for d in (town or {}).get("days", []) if event["start"] <= d["date"] <= event["end"]]
            if not window:
                continue
            best = max(window, key=lambda d: (RANK[d["level"]], d["score"] if d["score"] is not None else -1))
            rows.append({"event": event["id"], "municipality": name, "start": event["start"], "end": event["end"],
                         "summary": event["summary"], "sources": event["sources"],
                         "date": best["date"], "level": best["level"], "score": best["score"],
                         "rain_mm": best["rain_mm"], "upstream_mm": best.get("upstream_mm")})
    return rows


def build_history(
    start: date | None = None,
    end: date | None = None,
    fetcher: Callable[[date, date], dict] = fetch,
    static_loader: Callable[[], dict] = fr.load_static,
    today: date | None = None,
    statistic: str | None = None,
) -> dict[str, Any]:
    statistic = statistic or fr.RULES["ensemble_statistic"]
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
        series = model_series(data["rain"][index])
        upstream = [model_series(item["location"]) for item in (data.get("upstream") or {}).get(name, [])]
        highs = daily_highs(data["marine"][index])
        rows = []
        for day in days:
            values = daily_values(series, day, statistic, upstream)
            assessed = fr.assess_town(name, values, daily_discharge(data["flood"][index], day), None,
                                      daily_tide(highs, day), static.get(name))
            row = {
                "date": day.isoformat(), "level": assessed["level"], "score": assessed["score"],
                "rain_mm": values["total_24h_median_mm"], "rain_scored_mm": values["total_24h_mm"],
                "peak_mm_h": values["peak_24h_mm_h"],
                "upstream_mm": values["upstream_24h_mm"], "models_low_high": values["models_low_high_24h"],
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
    reported = load_reported()
    evaluation = evaluate(towns_out, reported)
    rank = {"very_high": 3, "high": 2, "moderate": 1}
    events.sort(key=lambda e: (rank[e["level"]], e["score"] or 0, e["rain_mm"] or 0), reverse=True)
    return {
        "start": start.isoformat(), "end": end.isoformat(), "days": [d.isoformat() for d in days],
        "rules_status": fr.RULES_STATUS,
        "ensemble_statistic": statistic,
        "levels_rule": "Total points: 0-2 low, 3-5 moderate, 6-8 high, 9 or more very high.",
        "windows": HISTORY_WINDOWS,
        "source": "AGOS consensus of six models from the Open-Meteo Historical Forecast API; GloFAS river flow; Open-Meteo Marine sea level",
        "municipalities": towns_out,
        "events": events[:40],
        "reported_floods": reported.get("events", []),
        "reported_note": reported.get("note"),
        "evaluation": evaluation,
        "evaluation_summary": {
            "town_events": len(evaluation),
            "moderate_or_above": sum(1 for r in evaluation if RANK[r["level"]] >= 1),
            "high_or_above": sum(1 for r in evaluation if RANK[r["level"]] >= 2),
        },
        "limitations": [
            "Rebuilt with the draft rules of the live indicator; checked only against the floods reported in the news listed here (not a complete record).",
            "Past rain is archived short-range model output of six models, combined per day (not hour by hour), not rain-gauge records.",
            "Upstream rain uses each town's own high ground; rivers fed from outside Bataan (for example Zambales) are not covered.",
            "The storm-from-article step is not applied to past days.",
        ],
    }


def cached_history(start: date | None = None, end: date | None = None) -> dict[str, Any]:
    key = (start, end, datetime.now(PH_TZ).date(), fr.RULES["ensemble_statistic"])
    now = datetime.now().timestamp()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1]
    result = build_history(start, end)
    with _lock:
        _cache[key] = (now, result)
    return result
