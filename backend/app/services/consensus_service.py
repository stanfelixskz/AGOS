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

import math
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

from app.config.settings import OPEN_METEO_URL
from app.data.municipalities import MUNICIPALITIES
from app.services.analysis_service import BEST_MATCH, MODELS, clean_series
from app.services.overview_service import YELLOW_MM_H
from app.services.weather_service import _cached_request

PH_TZ = ZoneInfo("Asia/Manila")
VARIABLES = ["precipitation", "temperature_2m", "relative_humidity_2m", "wind_speed_10m", "cloud_cover"]
CODE_VARIABLE = "weather_code"  # used only for model votes on thunderstorm and fog
THUNDER_CODES = range(95, 100)
FOG_CODES = (45, 48)
MIN_MODELS = 3
WET_MM = 0.1
SOURCE = f"AGOS consensus: median of {len(MODELS)} weather models (via Open-Meteo)"


def fetch(request: Callable[..., Any] = _cached_request) -> list[dict]:
    names = list(MUNICIPALITIES)
    payload = request(OPEN_METEO_URL, {
        "latitude": ",".join(str(MUNICIPALITIES[n]["latitude"]) for n in names),
        "longitude": ",".join(str(MUNICIPALITIES[n]["longitude"]) for n in names),
        "hourly": ",".join([*VARIABLES, CODE_VARIABLE]), "past_days": 3, "forecast_days": 4,
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
    # Model votes from each model's own WMO weather code: share forecasting thunderstorm / fog.
    votes = []
    for model in MODELS:
        _, codes, _ = clean_series(times, hourly.get(f"{CODE_VARIABLE}_{model}") or [None] * len(times), CODE_VARIABLE)
        votes.append(codes)
    out["codes"] = []
    for i in range(len(out["times"])):
        valid = [int(series[i]) for series in votes if i < len(series) and series[i] is not None]
        out["codes"].append({
            "models": len(valid),
            "thunder": round(sum(1 for c in valid if c in THUNDER_CODES) / len(valid), 2) if valid else None,
            "fog": round(sum(1 for c in valid if c in FOG_CODES) / len(valid), 2) if valid else None,
        })
    out["model_point"] = {"latitude": location.get("latitude"), "longitude": location.get("longitude")}
    return out


# ------------------------------------------------------------------ condition (icons)
def sun_elevation(lat: float, lon: float, when: datetime) -> float:
    """Solar elevation angle in degrees (NOAA low-precision formulas, good to about 1 degree)."""
    t = when.astimezone(timezone.utc)
    day = t.timetuple().tm_yday
    hour = t.hour + t.minute / 60
    gamma = 2 * math.pi / 365 * (day - 1 + (hour - 12) / 24)
    decl = (0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma) - 0.006758 * math.cos(2 * gamma)
            + 0.000907 * math.sin(2 * gamma) - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma))
    eqtime = 229.18 * (0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma)
                       - 0.014615 * math.cos(2 * gamma) - 0.040849 * math.sin(2 * gamma))
    solar_minutes = hour * 60 + eqtime + 4 * lon
    hour_angle = math.radians(solar_minutes / 4 - 180)
    phi = math.radians(lat)
    cos_zenith = math.sin(phi) * math.sin(decl) + math.cos(phi) * math.cos(decl) * math.cos(hour_angle)
    return 90 - math.degrees(math.acos(max(-1.0, min(1.0, cos_zenith))))


def is_day(lat: float, lon: float, when: datetime) -> bool:
    """Daytime = the centre of the sun above -0.833 degrees (standard sunrise/sunset definition)."""
    return sun_elevation(lat, lon, when) > -0.833


CONDITION_RULE = (
    "Per hour, from the AGOS consensus: thunderstorm if at least half of the models forecast one and rain >= 0.1 mm; "
    "heavy rain >= 7.5 mm/h; rain >= 2.5 mm/h; light rain >= 0.1 mm/h with at least half of the models wet; "
    "fog if at least half of the models forecast fog; otherwise cloud cover >= 80% cloudy, >= 50% mostly cloudy, "
    ">= 20% partly cloudy, else clear. Day or night from the position of the sun."
)


def condition(rain: dict, cloud: dict, code: dict) -> str:
    """Weather condition id for one hour, from consensus values (AGOS rule, see CONDITION_RULE)."""
    mm = rain.get("value")
    chance = rain.get("chance")
    if mm is not None and mm >= WET_MM and (code.get("thunder") or 0) >= 0.5:
        return "thunder"
    if mm is not None and mm >= YELLOW_MM_H:
        return "heavy_rain"
    if mm is not None and mm >= 2.5:
        return "rain"
    if mm is not None and mm >= WET_MM and (chance is None or chance >= 50):
        return "light_rain"
    if (code.get("fog") or 0) >= 0.5:
        return "fog"
    cover = cloud.get("value")
    if cover is None:
        return "unknown"
    if cover >= 80:
        return "overcast"
    if cover >= 50:
        return "mostly_cloudy"
    if cover >= 20:
        return "partly_cloudy"
    return "clear"


def hourly_condition(series: dict, i: int, point: dict) -> dict:
    return {
        "condition": condition(series["precipitation"][i], series["cloud_cover"][i], series["codes"][i]),
        "is_day": is_day(point["latitude"], point["longitude"], series["times"][i]),
    }


def daily_summary(series: dict, start: datetime, days: int = 3) -> list[dict]:
    """Per local calendar day: condition, min/max temperature, rain total and the highest chance."""
    out = []
    first = start.replace(hour=0, minute=0, second=0, microsecond=0)
    for d in range(days):
        day_start = first + timedelta(days=d)
        idx = [i for i, t in enumerate(series["times"]) if day_start <= t < day_start + timedelta(days=1)]
        if len(idx) < 20:
            continue
        rain = [series["precipitation"][i] for i in idx]
        temps = [series["temperature_2m"][i]["value"] for i in idx if series["temperature_2m"][i]["value"] is not None]
        mm = [c["value"] for c in rain if c["value"] is not None]
        conds = [condition(series["precipitation"][i], series["cloud_cover"][i], series["codes"][i]) for i in idx]
        daytime = [series["cloud_cover"][i]["value"] for i in idx
                   if 6 <= series["times"][i].hour < 18 and series["cloud_cover"][i]["value"] is not None]
        total = round(sum(mm), 1) if mm else None
        # The worst wet condition of the day wins; a dry day takes its daytime mean cloud cover.
        for wet in ("thunder", "heavy_rain", "rain", "light_rain"):
            if wet in conds and (wet != "light_rain" or (total or 0) >= 1):
                day_condition = wet
                break
        else:
            cover = statistics.fmean(daytime) if daytime else None
            day_condition = condition({"value": 0}, {"value": cover}, {"fog": 0})
        out.append({
            "date": day_start.date().isoformat(),
            "condition": day_condition,
            "temp_min": round(min(temps), 1) if temps else None,
            "temp_max": round(max(temps), 1) if temps else None,
            "rain_total_mm": total,
            "rain_chance_max": max((c.get("chance") or 0) for c in rain) if rain else None,
        })
    return out


def all_towns(fetcher: Callable[[], list[dict]] = fetch) -> dict[str, dict]:
    return {name: town_series(location) for name, location in zip(MUNICIPALITIES, fetcher())}


def _window_index(times: list[datetime], start: datetime, hours: int) -> list[int]:
    end = start + timedelta(hours=hours)
    return [i for i, t in enumerate(times) if start <= t < end]


def window_totals(series: dict, start: datetime, hours: int) -> dict[str, Any]:
    """24-hour (or other) total: consensus sum, and each model's own total for the range."""
    idx = _window_index(series["times"], start, hours)
    model_totals, model_peaks = [], []
    for values in series["precipitation_models"]:
        picked = [values[i] for i in idx]
        if picked and None not in picked:
            model_totals.append(round(sum(picked), 1))
            model_peaks.append(max(picked))
    enough = len(model_totals) >= MIN_MODELS
    return {
        "models": len(model_totals),
        "low": min(model_totals) if model_totals else None,
        "high": max(model_totals) if model_totals else None,
        # Totals and peaks are combined per model, never by adding hour-by-hour medians.
        "median_of_totals": round(statistics.median(model_totals), 1) if enough else None,
        "median_of_peaks": round(statistics.median(model_peaks), 1) if enough else None,
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
                **hourly_condition(series, i, MUNICIPALITIES[name]),
                "temperature_c": series["temperature_2m"][i]["value"],
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
            "daily": daily_summary(series, current),
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
        "condition_rule": CONDITION_RULE,
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
        **hourly_condition(series, i, MUNICIPALITIES[name]),
        "condition_rule": CONDITION_RULE,
    }


def precipitation_by_time(towns: dict | None = None) -> dict[str, dict[str, float | None]]:
    """{town: {"YYYY-MM-DDTHH:MM": consensus mm}} for the flood-risk indicator."""
    towns = towns if towns is not None else all_towns()
    return {
        name: {t.strftime("%Y-%m-%dT%H:%M"): cell["value"] for t, cell in zip(series["times"], series["precipitation"])}
        for name, series in towns.items()
    }


def point_models(points_by_town: dict[str, list[dict]], request: Callable[..., Any] = _cached_request) -> dict[str, list[dict]]:
    """
    Every model's cleaned hourly rain at extra points (for example each town's high
    ground), past 3 days and next 4 days, in one request: {town: [{"times", "models", "point"}]}.
    """
    flat = [(name, p) for name, pts in points_by_town.items() for p in pts]
    if not flat:
        return {}
    payload = request(OPEN_METEO_URL, {
        "latitude": ",".join(str(p["latitude"]) for _, p in flat),
        "longitude": ",".join(str(p["longitude"]) for _, p in flat),
        "hourly": "precipitation", "past_days": 3, "forecast_days": 4,
        "models": ",".join(MODELS), "timezone": "Asia/Manila", "precipitation_unit": "mm",
    })
    items = payload if isinstance(payload, list) else [payload]
    if len(items) != len(flat):
        raise RuntimeError(f"Upstream request returned {len(items)} locations, expected {len(flat)}")
    out: dict[str, list[dict]] = {}
    for (name, point), location in zip(flat, items):
        hourly = location.get("hourly") or {}
        times = hourly.get("time") or []
        models, axis = [], []
        for model in MODELS:
            axis, values, _ = clean_series(times, hourly.get(f"precipitation_{model}") or [None] * len(times), "precipitation")
            models.append(values)
        out.setdefault(name, []).append({"times": axis, "models": models, "point": point})
    return out
