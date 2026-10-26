"""
AGOS — flood-risk INDICATOR per municipality (draft rules, unverified).

Combines Open-Meteo model data at each municipality's reference point:
  - heaviest forecast hour, next 24 h  (PAGASA-equivalent rain levels)
  - forecast rain totals, next 24 h and 72 h
  - rain over the past 72 h            (wet ground)
  - soil moisture 0-10 cm, current hour
  - GloFAS river discharge, next 3 days vs the median of the past 30 days
and, optionally, a storm read from a news article (typhoon_service): a town
inside the storm's STATED wind radius is raised by one level.

This is a screening indicator, not a flood forecast:
  - every threshold below is a DRAFT chosen for review, not an official value;
  - it has not been checked against past floods;
  - Open-Meteo forecast rain already includes the storm's modeled rain, so the
    storm only adds a separate, capped step (it is not counted as extra rain);
  - missing inputs are reported as missing, never replaced with zero.
Terrain (elevation, river distance) is not used yet; see terrain_service.
"""

from __future__ import annotations

import math
import statistics
from datetime import datetime, timedelta
from typing import Any, Callable
from zoneinfo import ZoneInfo

from app.config.settings import OPEN_METEO_URL
from app.data.municipalities import MUNICIPALITIES
from app.services import overview_service as overview
from app.services.weather_service import FLOOD_API_URL, _cached_request

PH_TZ = ZoneInfo("Asia/Manila")
RULES_STATUS = "draft"  # set to "approved" only after the owner reviews RULES

# ----------------------------------------------------------------- DRAFT RULES
# Points per input; the total picks the level. Change values here only.
RULES: dict[str, Any] = {
    # PAGASA-equivalent level of the heaviest forecast hour in the next 24 h.
    "peak_level_points": {"yellow": 2, "orange": 3, "red": 4},
    # Forecast rain totals (mm): list of (at least, points), highest first.
    "total_24h_mm": [(200, 3), (100, 2), (50, 1)],
    "total_72h_mm": [(300, 2), (150, 1)],
    # Rain already fallen in the past 72 h (mm): wet ground.
    "past_72h_mm": [(100, 2), (50, 1)],
    # Volumetric soil moisture 0-10 cm (m³/m³): near saturation for many soils.
    "soil_moisture": [(0.40, 1)],
    # Highest forecast discharge (next 3 days) / median of the past 30 days.
    "discharge_ratio": [(3.0, 2), (1.5, 1)],
    # Total points -> level (lowest total for each level).
    "levels": [(6, "very_high"), (4, "high"), (2, "moderate"), (0, "low")],
    # Storm from an article: a town inside the stated wind radius goes up one level.
    "storm_inside_radius_steps": 1,
}
LEVELS = ["low", "moderate", "high", "very_high"]

SOURCES = {
    "forecast": "Open-Meteo Forecast API (model forecast, not gauge readings)",
    "glofas": "Open-Meteo Flood API / GloFAS (modeled river discharge)",
    "article": "Storm details extracted from a news article (unverified)",
}


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    return float(value)


def _points(value: float | None, table: list[tuple[float, int]]) -> int:
    if value is None:
        return 0
    for threshold, points in table:
        if value >= threshold:
            return points
    return 0


def _threshold_text(table: list[tuple[float, int]], unit: str) -> str:
    return ", ".join(f"≥{t:g}{unit} +{p}" for t, p in sorted(table))


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(a))


# ----------------------------------------------------------------- inputs
def _as_list(payload: Any, expected: int, what: str) -> list[dict]:
    items = payload if isinstance(payload, list) else [payload]
    if len(items) != expected or not all(isinstance(i, dict) for i in items):
        raise RuntimeError(f"Open-Meteo returned an unexpected {what} response")
    return items


def fetch_inputs(request: Callable[..., Any] = _cached_request) -> dict[str, Any]:
    """One forecast request and one flood request for all municipalities."""
    names = list(MUNICIPALITIES)
    lats = ",".join(str(MUNICIPALITIES[n]["latitude"]) for n in names)
    lons = ",".join(str(MUNICIPALITIES[n]["longitude"]) for n in names)
    forecast = _as_list(request(OPEN_METEO_URL, {
        "latitude": lats, "longitude": lons,
        "hourly": "precipitation,soil_moisture_0_to_10cm",
        "past_days": 3, "forecast_days": 4,
        "timezone": "Asia/Manila", "precipitation_unit": "mm",
    }), len(names), "forecast")
    try:
        flood = _as_list(request(FLOOD_API_URL, {
            "latitude": lats, "longitude": lons,
            "daily": "river_discharge", "past_days": 30, "forecast_days": 4,
            "cell_selection": "land",
        }, ttl_seconds=21600), len(names), "flood")
        flood_error = None
    except RuntimeError as error:  # river data is optional; say why it is missing
        flood, flood_error = [None] * len(names), str(error)
    return {"names": names, "forecast": forecast, "flood": flood, "flood_error": flood_error}


def _hourly_windows(hourly: dict, now: datetime) -> dict[str, Any]:
    times = hourly.get("time") or []
    rain = hourly.get("precipitation") or []
    soil = hourly.get("soil_moisture_0_to_10cm") or []
    current = now.replace(minute=0, second=0, microsecond=0)
    past, next24, next72 = [], [], []
    soil_now = None
    for i, stamp in enumerate(times):
        try:
            t = datetime.fromisoformat(stamp).replace(tzinfo=PH_TZ)
        except (TypeError, ValueError):
            continue
        value = _num(rain[i]) if i < len(rain) else None
        if current - timedelta(hours=72) <= t < current:
            past.append(value)
        if current <= t < current + timedelta(hours=24):
            next24.append(value)
        if current <= t < current + timedelta(hours=72):
            next72.append(value)
        if t == current and i < len(soil):
            soil_now = _num(soil[i])

    def total(values, need):
        valid = [v for v in values if v is not None]
        return round(sum(valid), 1) if len(valid) >= need else None

    valid24 = [v for v in next24 if v is not None]
    return {
        "peak_24h_mm_h": max(valid24) if valid24 else None,
        "total_24h_mm": total(next24, 20),
        "total_72h_mm": total(next72, 60),
        "past_72h_mm": total(past, 60),
        "soil_moisture": soil_now,
    }


def _discharge_ratio(location: dict | None, today: str) -> dict[str, Any]:
    if not location:
        return {"ratio": None, "forecast_max": None, "median_30d": None}
    daily = location.get("daily") or {}
    days = daily.get("time") or []
    values = daily.get("river_discharge") or []
    past = [_num(v) for d, v in zip(days, values) if d < today]
    ahead = [_num(v) for d, v in zip(days, values) if d >= today][:3]
    past = [v for v in past if v is not None]
    ahead = [v for v in ahead if v is not None]
    if len(past) < 20 or not ahead:
        return {"ratio": None, "forecast_max": max(ahead) if ahead else None, "median_30d": None}
    median = statistics.median(past)
    peak = max(ahead)
    return {
        "ratio": round(peak / median, 2) if median > 0 else None,
        "forecast_max": round(peak, 2),
        "median_30d": round(median, 2),
    }


# ----------------------------------------------------------------- assessment
def _level_for(score: int) -> str:
    for minimum, level in RULES["levels"]:
        if score >= minimum:
            return level
    return "low"


def assess_town(name: str, values: dict, discharge: dict, storm: dict | None = None) -> dict[str, Any]:
    """Score one town from its input values. Pure function (no network)."""
    point = MUNICIPALITIES[name]
    peak_level = overview.rain_level(values["peak_24h_mm_h"]) if values["peak_24h_mm_h"] is not None else "nodata"
    factors = [
        {
            "id": "peak_24h", "value": values["peak_24h_mm_h"], "unit": "mm/h", "level": peak_level,
            "points": RULES["peak_level_points"].get(peak_level, 0),
            "rule": "PAGASA-equivalent level of the heaviest hour: yellow +2, orange +3, red +4",
            "source": SOURCES["forecast"], "window": "next 24 h",
        },
        {
            "id": "total_24h", "value": values["total_24h_mm"], "unit": "mm",
            "points": _points(values["total_24h_mm"], RULES["total_24h_mm"]),
            "rule": _threshold_text(RULES["total_24h_mm"], " mm"), "source": SOURCES["forecast"], "window": "next 24 h",
        },
        {
            "id": "total_72h", "value": values["total_72h_mm"], "unit": "mm",
            "points": _points(values["total_72h_mm"], RULES["total_72h_mm"]),
            "rule": _threshold_text(RULES["total_72h_mm"], " mm"), "source": SOURCES["forecast"], "window": "next 72 h",
        },
        {
            "id": "past_72h", "value": values["past_72h_mm"], "unit": "mm",
            "points": _points(values["past_72h_mm"], RULES["past_72h_mm"]),
            "rule": _threshold_text(RULES["past_72h_mm"], " mm"), "source": SOURCES["forecast"], "window": "past 72 h",
        },
        {
            "id": "soil", "value": values["soil_moisture"], "unit": "m³/m³",
            "points": _points(values["soil_moisture"], RULES["soil_moisture"]),
            "rule": _threshold_text(RULES["soil_moisture"], " m³/m³"), "source": SOURCES["forecast"], "window": "current hour",
        },
        {
            "id": "discharge", "value": discharge["ratio"], "unit": "× median",
            "forecast_max": discharge["forecast_max"], "median_30d": discharge["median_30d"],
            "points": _points(discharge["ratio"], RULES["discharge_ratio"]),
            "rule": _threshold_text(RULES["discharge_ratio"], "×"), "source": SOURCES["glofas"],
            "window": "next 3 days vs past 30 days",
        },
    ]
    missing = [f["id"] for f in factors if f["value"] is None]
    if values["peak_24h_mm_h"] is None and values["total_24h_mm"] is None:
        level, score = "nodata", None
    else:
        score = sum(f["points"] for f in factors)
        level = _level_for(score)

    storm_effect = None
    if storm:
        distance = haversine_km(point["latitude"], point["longitude"], storm["latitude"], storm["longitude"])
        radius = storm.get("radius_km")
        inside = radius is not None and distance <= radius
        steps = RULES["storm_inside_radius_steps"] if inside and level != "nodata" else 0
        base_level = level
        if steps:
            level = LEVELS[min(len(LEVELS) - 1, LEVELS.index(level) + steps)]
        storm_effect = {
            "name": storm.get("name"), "distance_km": round(distance), "radius_km": radius,
            "inside_radius": inside, "steps": steps, "level_before": base_level,
            "strength_level": storm.get("strength_level"), "source": SOURCES["article"],
            "note": (
                "Inside the storm's stated wind radius: raised one level." if steps
                else "Outside the stated wind radius: no change." if radius is not None
                else "The article states no wind radius, so AGOS cannot tell whether this town is inside it: no change."
            ),
        }

    return {
        "municipality": name,
        "point": point,
        "level": level,
        "score": score,
        "factors": factors,
        "missing": missing,
        "storm": storm_effect,
    }


def build_flood_risk(
    storm: dict | None = None,
    fetch: Callable[[], dict] = fetch_inputs,
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or datetime.now(PH_TZ)
    data = fetch()
    today = now.date().isoformat()
    towns = []
    for index, name in enumerate(data["names"]):
        values = _hourly_windows(data["forecast"][index].get("hourly") or {}, now)
        discharge = _discharge_ratio(data["flood"][index], today)
        towns.append(assess_town(name, values, discharge, storm))
    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "rules_status": RULES_STATUS,
        "rules": {
            "levels": "Total points: 0-1 low, 2-3 moderate, 4-5 high, 6 or more very high.",
            "storm": "A town inside the storm's stated wind radius goes up one level (only when a storm is supplied).",
        },
        "river_data_note": data.get("flood_error"),
        "municipalities": towns,
        "limitations": [
            "Draft rules chosen for review; not official thresholds and not checked against past floods.",
            "Uses one model point per municipality; it does not describe every barangay.",
            "Open-Meteo values are model output, not gauge readings; GloFAS discharge is modeled.",
            "A storm's rain is already inside the Open-Meteo forecast; the storm adds only a separate, capped step.",
            "Terrain (low-lying areas, distance to rivers) is not used yet.",
        ],
    }
