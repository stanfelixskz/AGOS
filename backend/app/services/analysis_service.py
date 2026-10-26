"""
AGOS — data analysis per municipality: how every number on screen was made.

AGOS does not run its own weather model. Forecasts come from global
numerical weather models served by Open-Meteo. What AGOS does, step by step,
and reports in full:

  1. fetch     the exact requests and what came back (source, variables,
               time range, the model grid point actually used)
  2. clean     per variable: missing values, duplicate timestamps, gaps in
               the hourly series and physically impossible values. Invalid
               values are removed, never filled in.
  3. describe  descriptive statistics for the next 24 h and the past 7 days
  4. models    the same forecast from several independent weather models:
               mean, median, spread, coefficient of variation and how many
               models reach each rain level (a measure of uncertainty)
  5. climate   the forecast compared with 10 years of daily rain at this
               point for the same season (Open-Meteo archive / ERA5-based
               reanalysis): percentile rank, z-score, how often it happens
  6. skill     how past AGOS-stored forecasts compared with what happened
               (forecast_skill), and a bias adjustment only when enough data
  7. classify  weather condition and rain level from stated rules, the
               model's own WMO weather code, and the flood-risk indicator

Every threshold used here is written in the output next to the result.
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
from app.services.weather_service import _cached_request

PH_TZ = ZoneInfo("Asia/Manila")
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
CLIMATE_YEARS = 10
SEASON_HALF_WINDOW_DAYS = 15

# Independent global models compared in step 4 (Open-Meteo model ids).
MODELS = {
    "ecmwf_ifs025": "ECMWF IFS (Europe)",
    "gfs_seamless": "NOAA GFS (USA)",
    "icon_seamless": "DWD ICON (Germany)",
    "jma_seamless": "JMA (Japan)",
    "meteofrance_seamless": "Météo-France ARPEGE (France)",
    "ukmo_seamless": "UK Met Office (UK)",
}
BEST_MATCH = "best_match"  # what the rest of AGOS shows

HOURLY = ["precipitation", "temperature_2m", "relative_humidity_2m", "cloud_cover", "wind_speed_10m", "weather_code"]
UNITS = {
    "precipitation": "mm", "temperature_2m": "°C", "relative_humidity_2m": "%",
    "cloud_cover": "%", "wind_speed_10m": "km/h", "weather_code": "WMO code",
}
# Physically possible ranges for lowland/upland Bataan. Values outside are removed as invalid.
VALID_RANGE = {
    "precipitation": (0.0, 300.0),
    "temperature_2m": (5.0, 45.0),
    "relative_humidity_2m": (0.0, 100.0),
    "cloud_cover": (0.0, 100.0),
    "wind_speed_10m": (0.0, 300.0),
    "weather_code": (0, 99),
}

# WMO 4677 weather codes as documented by Open-Meteo.
WMO_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle", 56: "Light freezing drizzle", 57: "Dense freezing drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain", 66: "Light freezing rain", 67: "Heavy freezing rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers", 85: "Slight snow showers",
    86: "Heavy snow showers", 95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
}

# AGOS display bands (not PAGASA categories) for the 24-hour condition summary.
CLOUD_BANDS = [(80, "overcast"), (50, "mostly_cloudy"), (20, "partly_cloudy"), (0, "clear")]
WET_HOUR_MM = 0.1


# ------------------------------------------------------------------ helpers
def _num(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    return float(value)


def _r(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(value, digits)


def describe(values: list[float | None]) -> dict[str, Any]:
    """Descriptive statistics of the valid values; counts what was missing."""
    valid = [v for v in values if v is not None]
    if not valid:
        return {"n": 0, "missing": len(values)}
    return {
        "n": len(valid),
        "missing": len(values) - len(valid),
        "sum": _r(sum(valid), 1),
        "mean": _r(statistics.fmean(valid)),
        "std": _r(statistics.pstdev(valid)) if len(valid) > 1 else 0.0,
        "min": _r(min(valid)),
        "max": _r(max(valid)),
        "median": _r(statistics.median(valid)),
    }


def percentile(sorted_values: list[float], q: float) -> float | None:
    """Linear-interpolated percentile (q in 0..100) of an already sorted list."""
    if not sorted_values:
        return None
    k = (len(sorted_values) - 1) * q / 100
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return sorted_values[int(k)]
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (k - lo)


def percentile_rank(sorted_values: list[float], x: float) -> float | None:
    """Share (0-100) of baseline values at or below x."""
    if not sorted_values:
        return None
    return round(100 * sum(1 for v in sorted_values if v <= x) / len(sorted_values), 1)


def max_rolling_sum(values: list[float | None], window: int) -> float | None:
    sums = [sum(values[i:i + window]) for i in range(len(values) - window + 1) if None not in values[i:i + window]]
    return _r(max(sums), 1) if sums else None


# ------------------------------------------------------------------ 1. fetch
def fetch_forecast(name: str, request: Callable[..., Any] = _cached_request) -> tuple[dict, dict]:
    point = MUNICIPALITIES[name]
    params = {
        "latitude": point["latitude"], "longitude": point["longitude"],
        "hourly": ",".join(HOURLY), "past_days": 7, "forecast_days": 3,
        "models": ",".join([BEST_MATCH, *MODELS]), "timezone": "Asia/Manila",
        "precipitation_unit": "mm", "wind_speed_unit": "kmh",
    }
    return request(OPEN_METEO_URL, params), params


def fetch_climate(name: str, today: datetime, request: Callable[..., Any] = _cached_request) -> tuple[dict, dict]:
    point = MUNICIPALITIES[name]
    end_year = today.year - 1
    params = {
        "latitude": point["latitude"], "longitude": point["longitude"],
        "start_date": f"{end_year - CLIMATE_YEARS + 1}-01-01", "end_date": f"{end_year}-12-31",
        "daily": "precipitation_sum", "timezone": "Asia/Manila",
    }
    return request(ARCHIVE_URL, params, ttl_seconds=86400), params


# ------------------------------------------------------------------ 2. clean
def clean_series(times: list[str], values: list[Any], variable: str) -> tuple[list[datetime], list[float | None], dict]:
    """Parse, de-duplicate and validate one hourly series. Returns times, values and a report."""
    low, high = VALID_RANGE[variable]
    seen: set[str] = set()
    out_t, out_v = [], []
    report = {"variable": variable, "unit": UNITS[variable], "received": len(values), "missing": 0,
              "duplicates": 0, "out_of_range": 0, "unparseable_times": 0, "gaps": 0,
              "valid_range": [low, high]}
    for stamp, raw in zip(times, values):
        if stamp in seen:
            report["duplicates"] += 1
            continue
        seen.add(stamp)
        try:
            t = datetime.fromisoformat(stamp).replace(tzinfo=PH_TZ)
        except (TypeError, ValueError):
            report["unparseable_times"] += 1
            continue
        value = _num(raw)
        if value is None:
            report["missing"] += 1
        elif not low <= value <= high:
            report["out_of_range"] += 1
            value = None  # removed as physically impossible; not replaced
        out_t.append(t)
        out_v.append(value)
    report["gaps"] = sum(1 for a, b in zip(out_t, out_t[1:]) if b - a != timedelta(hours=1))
    report["valid"] = sum(1 for v in out_v if v is not None)
    report["valid_percent"] = round(100 * report["valid"] / report["received"], 1) if report["received"] else 0.0
    return out_t, out_v, report


def _window(times: list[datetime], values: list, start: datetime, hours: int) -> list:
    end = start + timedelta(hours=hours)
    return [v for t, v in zip(times, values) if start <= t < end]


# ------------------------------------------------------------------ 4. models
def model_agreement(model_totals: dict[str, float | None], yellow_mm_h: dict[str, float | None]) -> dict[str, Any]:
    """Spread of the next-24 h rain total across models, and how many reach each PAGASA-equivalent level."""
    totals = {m: v for m, v in model_totals.items() if v is not None}
    values = sorted(totals.values())
    if not values:
        return {"n": 0}
    mean = statistics.fmean(values)
    std = statistics.pstdev(values) if len(values) > 1 else 0.0
    peaks = {m: p for m, p in yellow_mm_h.items() if p is not None}
    levels = {m: overview.rain_level(p) for m, p in peaks.items()}
    reach = lambda names: sum(1 for lv in levels.values() if lv in names)  # noqa: E731
    cv = std / mean if mean > 0 else None
    if mean < 1 and max(values) < 5:
        agreement = "dry_agree"
    elif cv is None or cv <= 0.35:
        agreement = "high"
    elif cv <= 0.75:
        agreement = "moderate"
    else:
        agreement = "low"
    return {
        "n": len(values),
        "mean": _r(mean, 1), "median": _r(statistics.median(values), 1), "std": _r(std, 1),
        "min": _r(values[0], 1), "max": _r(values[-1], 1),
        "cv": _r(cv),
        "agreement": agreement,
        "agreement_rule": "CV = std ÷ mean of the models' 24 h totals: ≤0.35 high, ≤0.75 moderate, >0.75 low; all <5 mm and mean <1 mm = models agree it stays dry",
        "models_yellow_or_above": reach({"yellow", "orange", "red"}),
        "models_orange_or_above": reach({"orange", "red"}),
        "models_red": reach({"red"}),
        "models_with_peak": len(levels),
        "levels": levels,
    }


# ------------------------------------------------------------------ 5. climate
def climate_context(daily_times: list[str], daily_values: list[Any], today: datetime,
                    forecast_24h: float | None, forecast_72h: float | None) -> dict[str, Any]:
    """Compare forecast totals with the same season (±15 days of today's date) over past years."""
    doy = today.timetuple().tm_yday
    season, rolling = [], []
    series = []
    for stamp, raw in zip(daily_times, daily_values):
        try:
            d = datetime.fromisoformat(stamp)
        except (TypeError, ValueError):
            continue
        series.append((d, _num(raw)))
    for i, (d, v) in enumerate(series):
        diff = abs(d.timetuple().tm_yday - doy)
        if min(diff, 366 - diff) > SEASON_HALF_WINDOW_DAYS or v is None:
            continue
        season.append(v)
        window = [x for _, x in series[i:i + 3]]
        if len(window) == 3 and None not in window:
            rolling.append(sum(window))
    season.sort()
    rolling.sort()
    if len(season) < 100:
        return {"status": "insufficient_data", "n_days": len(season), "n_days_total": len(series)}

    def compare(x: float | None, base: list[float]) -> dict[str, Any] | None:
        if x is None or not base:
            return None
        mean, std = statistics.fmean(base), statistics.pstdev(base)
        rank = percentile_rank(base, x)
        exceed = sum(1 for v in base if v >= x) / len(base)
        return {
            "value": _r(x, 1), "percentile_rank": rank,
            "z_score": _r((x - mean) / std) if std > 0 else None,
            "days_at_or_above": round(100 * exceed, 1),
            "about_one_in": round(1 / exceed) if 0 < exceed <= 0.5 else None,
        }

    return {
        "status": "ok",
        "years": CLIMATE_YEARS,
        "n_days_total": len(series),
        "window": f"±{SEASON_HALF_WINDOW_DAYS} days around {today.strftime('%d %b')}",
        "n_days": len(season),
        "daily": {
            "mean": _r(statistics.fmean(season), 1), "std": _r(statistics.pstdev(season), 1),
            "p50": _r(percentile(season, 50), 1), "p75": _r(percentile(season, 75), 1),
            "p90": _r(percentile(season, 90), 1), "p95": _r(percentile(season, 95), 1),
            "p99": _r(percentile(season, 99), 1), "max": _r(season[-1], 1),
            "wet_day_percent": round(100 * sum(1 for v in season if v >= 1) / len(season), 1),
            "histogram": histogram(season),
        },
        "three_day": {"p90": _r(percentile(rolling, 90), 1), "p99": _r(percentile(rolling, 99), 1)} if rolling else None,
        "forecast_24h": compare(forecast_24h, season),
        "forecast_72h": compare(forecast_72h, rolling),
    }


HIST_BINS = [0, 1, 5, 10, 20, 50, 100]


def histogram(values: list[float]) -> list[dict[str, Any]]:
    bins = []
    for i, low in enumerate(HIST_BINS):
        high = HIST_BINS[i + 1] if i + 1 < len(HIST_BINS) else None
        count = sum(1 for v in values if v >= low and (high is None or v < high))
        bins.append({"from": low, "to": high, "count": count})
    return bins


# ------------------------------------------------------------------ 7. classify
def condition_24h(rain: dict, cloud_mean: float | None, peak_level: str) -> dict[str, Any]:
    """AGOS's 24-hour condition summary from stated rules (display bands, not PAGASA categories)."""
    total, wet = rain.get("sum") or 0.0, rain.get("wet_hours") or 0
    if peak_level in ("yellow", "orange", "red"):
        rain_part = peak_level  # PAGASA-equivalent heavy-rain levels
    elif total >= 10 or peak_level == "rain":
        rain_part = "rain"
    elif total >= 1 or wet >= 3:
        rain_part = "light_rain"
    else:
        rain_part = "dry"
    sky = next((band for minimum, band in CLOUD_BANDS if cloud_mean is not None and cloud_mean >= minimum), None)
    return {
        "rain": rain_part, "sky": sky,
        "rule": ("Rain: heaviest hour at PAGASA-equivalent yellow/orange/red → that level; else ≥10 mm in 24 h or an hour ≥1 mm "
                 "→ rain; else ≥1 mm or ≥3 wet hours (≥0.1 mm) → light rain; else dry. Sky: mean cloud cover ≥80% overcast, "
                 "≥50% mostly cloudy, ≥20% partly cloudy, else clear."),
    }


# ------------------------------------------------------------------ pipeline
def analyze_municipality(
    name: str,
    fetch_fc: Callable[[str], tuple[dict, dict]] = fetch_forecast,
    fetch_clim: Callable[[str, datetime], tuple[dict, dict]] = fetch_climate,
    skill: Callable[[str], dict | None] | None = None,
    risk: Callable[[str], dict | None] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    canonical = next((n for n in MUNICIPALITIES if n.casefold() == name.strip().casefold()), None)
    if canonical is None:
        raise ValueError(f"Unknown municipality: {name}")
    now = now or datetime.now(PH_TZ)
    current = now.replace(minute=0, second=0, microsecond=0)
    fetched_at = now.isoformat(timespec="seconds")

    # 1. fetch
    payload, fc_params = fetch_fc(canonical)
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []

    # 2. clean (best_match series for every variable; precipitation of every model)
    cleaned: dict[str, list] = {}
    reports = []
    t_axis: list[datetime] = []
    for variable in HOURLY:
        # With several models requested, Open-Meteo suffixes every column with the model id.
        column = hourly.get(f"{variable}_{BEST_MATCH}") or hourly.get(variable) or [None] * len(times)
        t_axis, values, report = clean_series(times, column, variable)
        cleaned[variable] = values
        reports.append(report)
    model_series = {}
    for model in MODELS:
        _, values, report = clean_series(times, hourly.get(f"precipitation_{model}") or [None] * len(times), "precipitation")
        model_series[model] = values
        report["variable"] = f"precipitation ({MODELS[model]})"
        reports.append(report)

    # AGOS consensus (the numbers the dashboard shows): per hour, the median of the
    # cleaned values of the six models; the default model only when fewer than 3 are valid.
    consensus: dict[str, list] = {}
    for variable in HOURLY:
        if variable == "weather_code":
            continue
        per_model = [model_series[m] for m in MODELS] if variable == "precipitation" else [
            clean_series(times, hourly.get(f"{variable}_{m}") or [None] * len(times), variable)[1] for m in MODELS
        ]
        column = []
        for i in range(len(t_axis)):
            valid = [series[i] for series in per_model if i < len(series) and series[i] is not None]
            column.append(statistics.median(valid) if len(valid) >= 3 else cleaned[variable][i])
        consensus[variable] = column

    # 3. describe
    rain24 = _window(t_axis, consensus["precipitation"], current, 24)
    rain72 = _window(t_axis, consensus["precipitation"], current, 72)
    past7 = _window(t_axis, consensus["precipitation"], current - timedelta(days=7), 24 * 7)
    rain_desc = describe(rain24)
    rain_desc["wet_hours"] = sum(1 for v in rain24 if v is not None and v >= WET_HOUR_MM)
    rain_desc["max_3h"] = max_rolling_sum(rain24, 3)
    valid_idx = [i for i, v in enumerate(rain24) if v is not None]
    peak_idx = max(valid_idx, key=lambda i: rain24[i]) if valid_idx else None
    peak_times = [t for t in t_axis if current <= t < current + timedelta(hours=24)]
    rain_desc["peak_time"] = peak_times[peak_idx].isoformat() if peak_idx is not None and peak_idx < len(peak_times) else None
    stats = {
        "next_24h": {
            "precipitation": rain_desc,
            "temperature_2m": describe(_window(t_axis, consensus["temperature_2m"], current, 24)),
            "relative_humidity_2m": describe(_window(t_axis, consensus["relative_humidity_2m"], current, 24)),
            "cloud_cover": describe(_window(t_axis, consensus["cloud_cover"], current, 24)),
            "wind_speed_10m": describe(_window(t_axis, consensus["wind_speed_10m"], current, 24)),
        },
        "next_72h_precipitation": describe(rain72),
        "past_7d_precipitation": {**describe(past7), "wet_hours": sum(1 for v in past7 if v is not None and v >= WET_HOUR_MM)},
    }

    # 4. models
    per_model = []
    totals, peaks = {}, {}
    for model, label in MODELS.items():
        window = _window(t_axis, model_series[model], current, 24)
        d = describe(window)
        totals[model] = d.get("sum") if d.get("n", 0) >= 20 else None
        peaks[model] = d.get("max") if d.get("n", 0) >= 20 else None
        per_model.append({"model": model, "label": label, "total_24h": totals[model], "peak_mm_h": peaks[model], "valid_hours": d.get("n", 0)})
    agreement = model_agreement(totals, peaks)

    # 5. climate
    try:
        clim_payload, clim_params = fetch_clim(canonical, now)
        daily = clim_payload.get("daily") or {}
        climate = climate_context(daily.get("time") or [], daily.get("precipitation_sum") or [], now,
                                  rain_desc.get("sum"), stats["next_72h_precipitation"].get("sum"))
        climate["source_params"] = {k: v for k, v in clim_params.items() if k not in ("latitude", "longitude")}
    except (RuntimeError, ValueError) as error:
        climate, clim_params = {"status": "unavailable", "detail": str(error)}, None

    # 6. skill
    skill_result = None
    if skill:
        try:
            skill_result = skill(canonical)
        except Exception as error:  # noqa: BLE001 - optional step
            skill_result = {"status": "unavailable", "detail": str(error)}
    adjusted = None
    if skill_result and skill_result.get("status") == "ok" and rain_desc.get("sum") is not None:
        adjusted = round(rain_desc["sum"] * skill_result["adjustment_factor"], 1)

    # 7. classify
    peak = rain_desc.get("max")
    peak_level = overview.rain_level(peak) if peak is not None else "nodata"
    now_codes = _window(t_axis, cleaned["weather_code"], current, 1)
    code = int(now_codes[0]) if now_codes and now_codes[0] is not None else None
    cond = condition_24h(rain_desc, stats["next_24h"]["cloud_cover"].get("mean"), peak_level)
    risk_result = None
    if risk:
        try:
            risk_result = risk(canonical)
        except Exception as error:  # noqa: BLE001
            risk_result = {"status": "unavailable", "detail": str(error)}

    return {
        "municipality": canonical,
        "point": MUNICIPALITIES[canonical],
        "generated_at": fetched_at,
        "steps": {
            "fetch": {
                "sources": [
                    {
                        "name": "Open-Meteo Forecast API", "url": OPEN_METEO_URL,
                        "params": {k: v for k, v in fc_params.items() if k not in ("latitude", "longitude")},
                        "received_hours": len(times), "first": times[0] if times else None, "last": times[-1] if times else None,
                        "grid_point": {"latitude": payload.get("latitude"), "longitude": payload.get("longitude"), "elevation_m": payload.get("elevation")},
                    },
                    {
                        "name": "Open-Meteo Historical Weather API (reanalysis)", "url": ARCHIVE_URL,
                        "params": {k: v for k, v in (clim_params or {}).items() if k not in ("latitude", "longitude")},
                        "received_days": climate.get("n_days_total") if isinstance(climate, dict) else None,
                    },
                ],
                "fetched_at": fetched_at,
            },
            "clean": {
                "reports": reports,
                "rules": "Duplicate timestamps dropped (first kept); values outside the valid range removed; missing values stay missing (no interpolation); gaps = steps that are not exactly 1 hour.",
            },
            "describe": stats,
            "models": {"per_model": per_model, "summary": agreement},
            "climate": climate,
            "skill": {"result": skill_result, "adjusted_24h_mm": adjusted},
            "classify": {
                "rain_level": {
                    "peak_mm_h": peak, "level": peak_level,
                    "rule": f"Heaviest hour in the next 24 h: ≥{overview.YELLOW_MM_H} yellow, ≥{overview.ORANGE_MM_H} orange, >{overview.RED_ABOVE_MM_H} red (PAGASA-equivalent), ≥{overview.LIGHT_RAIN_MM_H} rain, else little or no rain",
                },
                "condition_24h": cond,
                "model_weather_code": {"code": code, "meaning": WMO_CODES.get(code) if code is not None else None,
                                       "note": "WMO code chosen by the weather model for the current hour (best_match)."},
                "flood_risk": risk_result,
            },
        },
    }


# ------------------------------------------------------------------ defaults used by the API
def default_skill(name: str) -> dict | None:
    from agos_data_lifecycle import _connect
    from app.services import forecast_skill
    from app.services.forecast_store import init_tables

    today = datetime.now(PH_TZ).date()
    connection = _connect()
    try:
        init_tables(connection)
        end = today - timedelta(days=1)
        return forecast_skill.municipality_skill(connection, name, MUNICIPALITIES[name], end - timedelta(days=29), end)
    finally:
        connection.close()


def default_risk(name: str) -> dict | None:
    from app.services import flood_risk_service

    result = flood_risk_service.build_flood_risk()
    town = next((t for t in result["municipalities"] if t["municipality"] == name), None)
    if town:
        town = {**town, "rules_status": result["rules_status"], "levels_rule": result["rules"]["levels"]}
    return town
