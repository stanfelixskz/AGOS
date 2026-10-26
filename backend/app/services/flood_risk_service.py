"""
AGOS — flood-risk INDICATOR per municipality (draft rules, unverified).

Weather inputs (Open-Meteo model data at each municipality's reference point):
  - heaviest forecast hour and heaviest 3 hours, next 24 h
  - forecast rain totals, next 24 h and 72 h
  - rain over the past 72 h            (wet ground)
  - soil moisture 0-10 cm, current hour
  - GloFAS river discharge, next 3 days vs the median of the past 30 days
  - coastal towns: modeled sea level (tides, no storm surge), next-24 h peak
    vs the 90th percentile of the past 30 days' daily highs
Static inputs (susceptibility_service; built once, do not change with weather):
  - share of the town that is low ground (≤5 m, or ≤10 m within 300 m of a
    waterway) and share rated High/Very High on the DENR-MGB flood
    susceptibility map.
    They only add points when the weather already gives a rain signal, so a
    flood-prone town is not shown at risk on a dry day.
Optional storm read from a news article (typhoon_service): a town inside the
storm's STATED wind radius is raised by one level.

This is a screening indicator, not a flood forecast:
  - every threshold below is a DRAFT chosen for review, not an official value;
  - it has not been checked against past floods;
  - Open-Meteo forecast rain already includes the storm's modeled rain, so the
    storm only adds a separate, capped step (it is not counted as extra rain);
  - missing inputs are reported as missing, never replaced with zero.
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
MARINE_API_URL = "https://marine-api.open-meteo.com/v1/marine"

# ----------------------------------------------------------------- DRAFT RULES
# Points per input; the total picks the level. Change values here only.
RULES: dict[str, Any] = {
    # PAGASA-equivalent level of the heaviest forecast hour in the next 24 h.
    "peak_level_points": {"yellow": 2, "orange": 3, "red": 4},
    # Heaviest 3 consecutive hours in the next 24 h (mm): short bursts, flash floods.
    "peak_3h_mm": [(60, 2), (30, 1)],
    # Forecast rain totals (mm): list of (at least, points), highest first.
    "total_24h_mm": [(200, 3), (100, 2), (50, 1)],
    "total_72h_mm": [(300, 2), (150, 1)],
    # Rain already fallen in the past 72 h (mm): wet ground.
    "past_72h_mm": [(100, 2), (50, 1)],
    # Volumetric soil moisture 0-10 cm (m³/m³): near saturation for many soils.
    "soil_moisture": [(0.40, 1)],
    # Highest forecast discharge (next 3 days) / median of the past 30 days.
    "discharge_ratio": [(3.0, 2), (1.5, 1)],
    # Coastal towns: next-24 h peak sea level at or above the 90th percentile of
    # the past 30 days' DAILY highs (i.e. among the highest-tide days of the month).
    "tide_points": 1,
    # Static shares of the town (0-1). Counted only with a rain signal (see below).
    "low_ground_share": [(0.22, 2), (0.12, 1)],
    "mgb_high_share": [(0.5, 2), (0.25, 1)],
    # Weather points needed before the static inputs count.
    "static_needs_weather_points": 2,
    # Total points -> level (lowest total for each level).
    "levels": [(9, "very_high"), (6, "high"), (3, "moderate"), (0, "low")],
    # Storm from an article: a town inside the stated wind radius goes up one level.
    "storm_inside_radius_steps": 1,
}
LEVELS = ["low", "moderate", "high", "very_high"]
WEATHER_FACTORS = ("peak_24h", "peak_3h", "total_24h", "total_72h", "past_72h", "soil", "discharge")
STATIC_FACTORS = ("low_ground", "mgb")

SOURCES = {
    "forecast": "AGOS consensus: median of 6 weather models via Open-Meteo (soil moisture: default model); model forecasts, not gauge readings",
    "glofas": "Open-Meteo Flood API / GloFAS (modeled river discharge)",
    "marine": "Open-Meteo Marine API (modeled sea level with tides; no storm surge; limited near coasts)",
    "terrain": "Copernicus DEM GLO-90 via Open-Meteo + OpenStreetMap waterways, AGOS 1 km terrain cells",
    "mgb": "DENR-MGB Detailed Flood Susceptibility, AGOS sample points",
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
    # Rain inputs use the AGOS consensus of six models (same numbers as the dashboard).
    # Copies are changed, never the cached API payload.
    rain_basis = "single_model_fallback"
    try:
        from app.services import consensus_service

        consensus = consensus_service.precipitation_by_time()
        replaced = []
        for name, location in zip(names, forecast):
            hourly = dict(location.get("hourly") or {})
            by_time = consensus.get(name, {})
            hourly["precipitation"] = [
                by_time.get(stamp) if by_time.get(stamp) is not None else value
                for stamp, value in zip(hourly.get("time") or [], hourly.get("precipitation") or [])
            ]
            replaced.append({**location, "hourly": hourly})
        forecast, rain_basis = replaced, "consensus"
    except (RuntimeError, ValueError, KeyError):
        pass
    try:
        flood = _as_list(request(FLOOD_API_URL, {
            "latitude": lats, "longitude": lons,
            "daily": "river_discharge", "past_days": 30, "forecast_days": 4,
            "cell_selection": "land",
        }, ttl_seconds=21600), len(names), "flood")
        flood_error = None
    except RuntimeError as error:  # river data is optional; say why it is missing
        flood, flood_error = [None] * len(names), str(error)
    try:
        marine = _as_list(request(MARINE_API_URL, {
            "latitude": lats, "longitude": lons,
            "hourly": "sea_level_height_msl", "past_days": 30, "forecast_days": 2,
            "timezone": "Asia/Manila",
        }, ttl_seconds=3600), len(names), "marine")
        marine_error = None
    except RuntimeError as error:  # sea level is optional too
        marine, marine_error = [None] * len(names), str(error)
    return {
        "names": names, "forecast": forecast, "flood": flood, "flood_error": flood_error,
        "marine": marine, "marine_error": marine_error, "rain_basis": rain_basis,
    }


def load_static() -> dict[str, Any]:
    """Static susceptibility per town; an empty result (with a note) if the layers are not built."""
    try:
        from app.services import susceptibility_service

        return susceptibility_service.town_summaries()
    except Exception as error:  # noqa: BLE001 - static layers are optional
        return {"towns": {}, "error": f"{type(error).__name__}: {error}"}


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
    # Heaviest 3 consecutive hours (windows with a missing hour are skipped).
    windows = [next24[i:i + 3] for i in range(max(0, len(next24) - 2))]
    sums3 = [sum(w) for w in windows if None not in w]
    return {
        "peak_24h_mm_h": max(valid24) if valid24 else None,
        "peak_3h_mm": round(max(sums3), 1) if sums3 else None,
        "total_24h_mm": total(next24, 20),
        "total_72h_mm": total(next72, 60),
        "past_72h_mm": total(past, 60),
        "soil_moisture": soil_now,
    }


def _tide(location: dict | None, now: datetime) -> dict[str, Any]:
    """Next-24 h peak modeled sea level vs the 90th percentile of the past 30 days' daily highs."""
    empty = {"peak_24h_m": None, "p90_30d_m": None, "high": None}
    if not location:
        return empty
    hourly = location.get("hourly") or {}
    times = hourly.get("time") or []
    values = hourly.get("sea_level_height_msl") or []
    current = now.replace(minute=0, second=0, microsecond=0)
    daily_highs: dict[str, float] = {}
    ahead = []
    for stamp, value in zip(times, values):
        value = _num(value)
        if value is None:
            continue
        try:
            t = datetime.fromisoformat(stamp).replace(tzinfo=PH_TZ)
        except (TypeError, ValueError):
            continue
        if t < current.replace(hour=0):  # whole past days only
            day = t.date().isoformat()
            daily_highs[day] = max(value, daily_highs.get(day, value))
        elif current <= t < current + timedelta(hours=24):
            ahead.append(value)
    if len(daily_highs) < 20 or not ahead:
        return empty
    p90 = statistics.quantiles(list(daily_highs.values()), n=10)[-1]
    peak = max(ahead)
    return {"peak_24h_m": round(peak, 2), "p90_30d_m": round(p90, 2), "high": peak >= p90}


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


def assess_town(
    name: str,
    values: dict,
    discharge: dict,
    storm: dict | None = None,
    tide: dict | None = None,
    static: dict | None = None,
) -> dict[str, Any]:
    """Score one town from its input values. Pure function (no network)."""
    point = MUNICIPALITIES[name]
    tide = tide or {"peak_24h_m": None, "p90_30d_m": None, "high": None}
    static = static or {}
    peak_level = overview.rain_level(values["peak_24h_mm_h"]) if values["peak_24h_mm_h"] is not None else "nodata"
    factors = [
        {
            "id": "peak_24h", "value": values["peak_24h_mm_h"], "unit": "mm/h", "level": peak_level,
            "points": RULES["peak_level_points"].get(peak_level, 0),
            "rule": "PAGASA-equivalent level of the heaviest hour: yellow +2, orange +3, red +4",
            "source": SOURCES["forecast"], "window": "next 24 h",
        },
        {
            "id": "peak_3h", "value": values.get("peak_3h_mm"), "unit": "mm",
            "points": _points(values.get("peak_3h_mm"), RULES["peak_3h_mm"]),
            "rule": _threshold_text(RULES["peak_3h_mm"], " mm"), "source": SOURCES["forecast"],
            "window": "heaviest 3 hours in the next 24 h",
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
    weather_points = sum(f["points"] for f in factors)

    # Coastal high tide: only for towns known to be on the coast.
    coastal = static.get("coastal")
    if coastal:
        factors.append({
            "id": "tide", "value": tide["peak_24h_m"], "unit": "m", "p90_30d": tide["p90_30d_m"],
            "points": RULES["tide_points"] if tide["high"] else 0,
            "rule": f"next-24 h peak ≥ 90th percentile of the past 30 daily highs +{RULES['tide_points']}",
            "source": SOURCES["marine"], "window": "next 24 h vs past 30 days",
        })

    # Static susceptibility: counted only when the weather already gives a rain signal.
    rain_signal = weather_points >= RULES["static_needs_weather_points"]
    for factor_id, key, table, source in (
        ("low_ground", "low_ground_share", RULES["low_ground_share"], SOURCES["terrain"]),
        ("mgb", "mgb_high_share", RULES["mgb_high_share"], SOURCES["mgb"]),
    ):
        value = static.get(key)
        earned = _points(value, table)
        factors.append({
            "id": factor_id, "value": value, "unit": "share",
            "points": earned if rain_signal else 0,
            "held_back": earned if not rain_signal else 0,
            "rule": _threshold_text([(t * 100, p) for t, p in table], "%")
            + f" (only with ≥{RULES['static_needs_weather_points']} weather points)",
            "source": source, "window": "static layer",
        })

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
        "coastal": coastal,
        "rain_signal": rain_signal,
        "storm": storm_effect,
    }


def build_flood_risk(
    storm: dict | None = None,
    fetch: Callable[[], dict] = fetch_inputs,
    static_loader: Callable[[], dict] = load_static,
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or datetime.now(PH_TZ)
    data = fetch()
    static = static_loader()
    static_towns = static.get("towns") or {}
    today = now.date().isoformat()
    towns = []
    marine = data.get("marine") or [None] * len(data["names"])
    for index, name in enumerate(data["names"]):
        values = _hourly_windows(data["forecast"][index].get("hourly") or {}, now)
        discharge = _discharge_ratio(data["flood"][index], today)
        tide = _tide(marine[index], now)
        towns.append(assess_town(name, values, discharge, storm, tide, static_towns.get(name)))
    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "rules_status": RULES_STATUS,
        "rules": {
            "levels": "Total points: 0-2 low, 3-5 moderate, 6-8 high, 9 or more very high.",
            "static": "Low ground and MGB susceptibility count only with at least 2 weather points.",
            "storm": "A town inside the storm's stated wind radius goes up one level (only when a storm is supplied).",
        },
        "rain_basis": data.get("rain_basis", "consensus"),
        "river_data_note": data.get("flood_error"),
        "sea_level_note": data.get("marine_error"),
        "static_layers": {
            "terrain_built_at": static.get("terrain_built_at"),
            "mgb_sampled_at": static.get("mgb_sampled_at"),
            "coastline_available": static.get("coastline_available", False),
            "error": static.get("error"),
        },
        "municipalities": towns,
        "limitations": [
            "Draft rules chosen for review; not official thresholds and not checked against past floods.",
            "Uses one model point per municipality for weather; it does not describe every barangay.",
            "Open-Meteo values are model output, not gauge readings; GloFAS discharge is modeled.",
            "Sea level is modeled with tides but without storm surge, and is less accurate near the coast.",
            "Terrain shares use 1 km cells on a 90 m elevation model; MGB shares use sample points about 2 km apart.",
            "A storm's rain is already inside the Open-Meteo forecast; the storm adds only a separate, capped step.",
        ],
    }
