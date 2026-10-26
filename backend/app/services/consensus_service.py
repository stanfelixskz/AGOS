"""
AGOS consensus forecast: the numbers the dashboard shows are computed here,
not passed through from one API value.

For all 12 municipalities AGOS fetches hourly forecasts from six independent
global weather models (one Open-Meteo request), cleans every series with the
same rules as the analysis page, and computes per hour:

  value       the MEDIAN of the valid model values (consensus)
  low / high  the lowest and highest model (uncertainty range)
  rain chance share of models forecasting at least 0.1 mm in that hour
  heavy chance share of models at PAGASA-equivalent yellow level or above
  models      how many models had a valid value

An hour with fewer than MIN_MODELS valid models falls back to the default
model (best_match) and is marked "fallback". Rain levels, alerts, the
briefing, map colours and the flood-risk indicator are then computed from
these consensus values.

Limits: the chance is a share of six models, not a calibrated probability;
the median smooths out single-model extremes, which is why the range is
shown with it.
"""

from __future__ import annotations

import statistics
from datetime import datetime, timedelta
from typing import Any, Callable
from zoneinfo import ZoneInfo

from app.config.settings import OPEN_METEO_URL
from app.data.municipalities import MUNICIPALITIES
from app.services.analysis_service import BEST_MATCH, MODELS, clean_series
from app.services.overview_service import YELLOW_MM_H
from app.services.weather_service import _cached_request

PH_TZ = ZoneInfo("Asia/Manila")
VARIABLES = ["precipitation", "temperature_2m", "relative_humidity_2m", "wind_speed_10m", "cloud_cover"]
MIN_MODELS = 3
WET_MM = 0.1
SOURCE = f"AGOS consensus: median of {len(MODELS)} weather models (via Open-Meteo)"


def fetch(request: Callable[..., Any] = _cached_request) -> list[dict]:
    names = list(MUNICIPALITIES)
    payload = request(OPEN_METEO_URL, {
        "latitude": ",".join(str(MUNICIPALITIES[n]["latitude"]) for n in names),
        "longitude": ",".join(str(MUNICIPALITIES[n]["longitude"]) for n in names),
        "hourly": ",".join(VARIABLES), "past_days": 3, "forecast_days": 4,
        "models": ",".join([BEST_MATCH, *MODELS]), "timezone": "Asia/Manila",
        "precipitation_unit": "mm", "wind_speed_unit": "kmh",
    })
    items = payload if isinstance(payload, list) else [payload]
    if len(items) != len(names):
        raise RuntimeError(f"Multi-model forecast returned {len(items)} locations, expected {len(names)}")
    return items


def combine(values: list[float | None], fallback: float | None, rain: bool = False) -> dict[str, Any]:
    """Consensus of one hour's model values. Pure function."""
    valid = [v for v in values if v is not None]
    if len(valid) < MIN_MODELS:
        return {"value": fallback, "low": None, "high": None, "models": len(valid), "basis": "fallback",
                **({"chance": None, "heavy_chance": None} if rain else {})}
    out = {
        "value": round(statistics.median(valid), 2), "low": round(min(valid), 2), "high": round(max(valid), 2),
        "models": len(valid), "basis": "consensus",
    }
    if rain:
        out["chance"] = round(100 * sum(1 for v in valid if v >= WET_MM) / len(valid))
        out["heavy_chance"] = round(100 * sum(1 for v in valid if v >= YELLOW_MM_H) / len(valid))
    return out


def town_series(location: dict) -> dict[str, Any]:
    """Clean every model series of one town and combine them hour by hour."""
    hourly = location.get("hourly") or {}
    times = hourly.get("time") or []
    out: dict[str, Any] = {"times": [], "quality": {}}
    for variable in VARIABLES:
        axis, best, report = clean_series(times, hourly.get(f"{variable}_{BEST_MATCH}") or [None] * len(times), variable)
        per_model = []
        for model in MODELS:
            _, values, model_report = clean_series(times, hourly.get(f"{variable}_{model}") or [None] * len(times), variable)
            per_model.append(values)
            report[model] = model_report["valid_percent"]
        out["times"] = axis
        out[variable] = [
            combine([series[i] for series in per_model], best[i], rain=variable == "precipitation")
            for i in range(len(axis))
        ]
        out[f"{variable}_models"] = per_model
        out["quality"][variable] = report
    out["model_point"] = {"latitude": location.get("latitude"), "longitude": location.get("longitude")}
    return out


def all_towns(fetcher: Callable[[], list[dict]] = fetch) -> dict[str, dict]:
    return {name: town_series(location) for name, location in zip(MUNICIPALITIES, fetcher())}


def _window_index(times: list[datetime], start: datetime, hours: int) -> list[int]:
    end = start + timedelta(hours=hours)
    return [i for i, t in enumerate(times) if start <= t < end]


def window_totals(series: dict, start: datetime, hours: int) -> dict[str, Any]:
    """24-hour (or other) total: consensus sum, and each model's own total for the range."""
    idx = _window_index(series["times"], start, hours)
    model_totals = []
    for values in series["precipitation_models"]:
        picked = [values[i] for i in idx]
        if picked and None not in picked:
            model_totals.append(round(sum(picked), 1))
    return {
        "models": len(model_totals),
        "low": min(model_totals) if model_totals else None,
        "high": max(model_totals) if model_totals else None,
        "median_of_totals": round(statistics.median(model_totals), 1) if model_totals else None,
    }


def rainfall_outlook(hours: int = 48, towns: dict | None = None, now: datetime | None = None) -> dict[str, Any]:
    """Same shape as weather_service.get_bataan_rainfall_outlook(), computed from the consensus."""
    now = now or datetime.now(PH_TZ)
    current = now.replace(minute=0, second=0, microsecond=0)
    towns = towns if towns is not None else all_towns()
    records, steps = [], set()
    for name, series in towns.items():
        idx = _window_index(series["times"], current, hours)
        points = []
        for i in idx:
            rain = series["precipitation"][i]
            stamp = series["times"][i].strftime("%Y-%m-%dT%H:%M")
            steps.add(stamp)
            points.append({
                "time": stamp,
                "precipitation_mm": rain["value"],
                "precipitation_probability_percent": rain.get("chance"),
                "low_mm": rain["low"], "high_mm": rain["high"],
                "heavy_chance_percent": rain.get("heavy_chance"),
                "models": rain["models"], "basis": rain["basis"],
            })
        records.append({
            "municipality": name,
            "requested_coordinates": MUNICIPALITIES[name],
            "model_coordinates": series["model_point"],
            "points": points,
            "ensemble": {f"next_{h}h": window_totals(series, current, h) for h in (6, 24, 48)},
            "fallback_hours": sum(1 for p in points if p["basis"] == "fallback"),
        })
    return {
        "title": f"Bataan {hours}-hour rainfall outlook (AGOS consensus)",
        "generated_at": now.isoformat(),
        "timezone": "Asia/Manila",
        "hours_requested": hours,
        "source": SOURCE,
        "method": "consensus",
        "models": list(MODELS.values()),
        "municipalities": records,
        "time_steps": sorted(steps),
        "limitations": [
            "Hourly rain is the median of six weather models at each town's reference point; the range shows the lowest and highest model.",
            "Chance of rain is the share of models forecasting at least 0.1 mm in that hour, not a calibrated probability.",
            "Model forecasts, not rain-gauge readings, and not official PAGASA warnings.",
        ],
    }


def current_conditions(name: str, towns: dict | None = None, now: datetime | None = None) -> dict[str, Any]:
    """Consensus for the current hour, with the keys the town page already uses."""
    now = now or datetime.now(PH_TZ)
    current = now.replace(minute=0, second=0, microsecond=0)
    towns = towns if towns is not None else all_towns()
    series = towns[name]
    idx = _window_index(series["times"], current, 1)
    if not idx:
        raise RuntimeError("No consensus value for the current hour")
    i = idx[0]
    temp = series["temperature_2m"][i]
    rh = series["relative_humidity_2m"][i]
    wind = series["wind_speed_10m"][i]
    cloud = series["cloud_cover"][i]
    rain = series["precipitation"][i]
    return {
        "municipality": name,
        "source": SOURCE,
        "method": "consensus",
        "updated_at": series["times"][i].isoformat(),
        "temperature_c": temp["value"], "temperature_range": [temp["low"], temp["high"]],
        "humidity_percent": rh["value"], "humidity_range": [rh["low"], rh["high"]],
        "wind_speed_kmh": wind["value"], "wind_range": [wind["low"], wind["high"]],
        "cloud_cover_percent": cloud["value"],
        "precipitation_mm": rain["value"], "precipitation_range": [rain["low"], rain["high"]],
        "rain_chance_percent": rain.get("chance"),
        "models": temp["models"],
    }


def precipitation_by_time(towns: dict | None = None) -> dict[str, dict[str, float | None]]:
    """{town: {"YYYY-MM-DDTHH:MM": consensus mm}} for the flood-risk indicator."""
    towns = towns if towns is not None else all_towns()
    return {
        name: {t.strftime("%Y-%m-%dT%H:%M"): cell["value"] for t, cell in zip(series["times"], series["precipitation"])}
        for name, series in towns.items()
    }
