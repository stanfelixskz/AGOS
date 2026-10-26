"""
AGOS — overview and municipality detail service (read-only).

Turns existing Open-Meteo / GloFAS service output into the shapes the new
interface needs. No new data source and no invented values:
- missing values stay None,
- each section reports its own status so one failing source never hides
  the others,
- rain levels are PAGASA-EQUIVALENT (AGOS rule on model forecasts), not
  official PAGASA warnings.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

PH_TZ = ZoneInfo("Asia/Manila")
DATA_DIR = Path(__file__).resolve().parents[1] / "data"
EVACUATION_FILE = DATA_DIR / "evacuation_centers.json"

# PAGASA Heavy Rainfall Warning intensity criteria (mm per hour), as published
# by PAGASA and reported by news explainers; not yet confirmed on a PAGASA page.
# Keep in sync with frontend/app/js/core/levels.js (a test checks this).
YELLOW_MM_H = 7.5
ORANGE_MM_H = 15.0
RED_ABOVE_MM_H = 30.0
# AGOS display band (not PAGASA): below this a forecast hour is "little rain".
LIGHT_RAIN_MM_H = 1.0

LEVEL_ORDER = ["nodata", "little", "rain", "yellow", "orange", "red"]

LEVEL_LABELS = {
    "nodata": "No data",
    "little": "Little or no rain",
    "rain": "Rain, below PAGASA yellow",
    "yellow": "Yellow-level intensity",
    "orange": "Orange-level intensity",
    "red": "Red-level intensity",
}


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    return float(value)


def rain_level(mm_per_hour: Any) -> str:
    """Classify one hourly rain amount. Mirrors stormRainfallLevel in map.js."""
    value = _number(mm_per_hour)
    if value is None:
        return "nodata"
    if value > RED_ABOVE_MM_H:
        return "red"
    if value >= ORANGE_MM_H:
        return "orange"
    if value >= YELLOW_MM_H:
        return "yellow"
    if value >= LIGHT_RAIN_MM_H:
        return "rain"
    return "little"


def level_rank(level: str) -> int:
    return LEVEL_ORDER.index(level) if level in LEVEL_ORDER else 0


def summarize_points(points: list[dict], hours: int) -> dict[str, Any]:
    """Total and peak hour over the first `hours` points. None if no data."""
    window = points[:hours]
    values = [
        (point.get("time"), _number(point.get("precipitation_mm")))
        for point in window
    ]
    valid = [(time, value) for time, value in values if value is not None]

    if not valid:
        return {
            "hours": hours,
            "hours_with_data": 0,
            "total_mm": None,
            "peak_mm_h": None,
            "peak_time": None,
            "level": "nodata",
        }

    peak_time, peak = max(valid, key=lambda item: item[1])

    return {
        "hours": hours,
        "hours_with_data": len(valid),
        "total_mm": round(sum(value for _, value in valid), 1),
        "peak_mm_h": round(peak, 1),
        "peak_time": peak_time,
        "level": rain_level(peak),
    }


def build_overview(outlook: dict) -> dict[str, Any]:
    """
    Build the province overview from get_bataan_rainfall_outlook() output.
    Pure function: easy to test with a fixture, no network.
    """
    municipalities = []

    for record in outlook.get("municipalities", []):
        points = record.get("points") or []
        series = []

        for point in points:
            mm = _number(point.get("precipitation_mm"))
            series.append({
                "time": point.get("time"),
                "precipitation_mm": mm,
                "probability_percent": _number(
                    point.get("precipitation_probability_percent")
                ),
                "level": rain_level(mm),
                # AGOS consensus extras (absent for the single-model fallback)
                "low_mm": _number(point.get("low_mm")),
                "high_mm": _number(point.get("high_mm")),
                "heavy_chance_percent": _number(point.get("heavy_chance_percent")),
                "models": point.get("models"),
                "condition": point.get("condition"),
                "is_day": point.get("is_day"),
                "temperature_c": _number(point.get("temperature_c")),
            })

        windows = {
            f"next_{hours}h": summarize_points(points, hours)
            for hours in (6, 24, 48)
        }

        municipalities.append({
            "name": record.get("municipality"),
            "point": record.get("requested_coordinates"),
            "model_point": record.get("model_coordinates"),
            "windows": windows,
            "level_24h": windows["next_24h"]["level"],
            "series": series,
            "ensemble": record.get("ensemble"),
            "daily": record.get("daily") or [],
            "fallback_hours": record.get("fallback_hours", 0),
        })

    ranked = sorted(
        municipalities,
        key=lambda item: (
            level_rank(item["level_24h"]),
            item["windows"]["next_24h"]["peak_mm_h"] or -1,
        ),
        reverse=True,
    )

    highest = ranked[0]["level_24h"] if ranked else "nodata"
    alerts = build_alerts(municipalities)

    return {
        "generated_at": outlook.get("generated_at"),
        "timezone": outlook.get("timezone", "Asia/Manila"),
        "source": outlook.get("source", "Open-Meteo Forecast API"),
        "method": outlook.get("method", "single_model"),
        "models": outlook.get("models", []),
        "hours": outlook.get("hours_requested"),
        "time_steps": outlook.get("time_steps", []),
        "thresholds_mm_h": {
            "light_rain": LIGHT_RAIN_MM_H,
            "yellow": YELLOW_MM_H,
            "orange": ORANGE_MM_H,
            "red_above": RED_ABOVE_MM_H,
        },
        "level_labels": LEVEL_LABELS,
        "highest_level_24h": highest,
        "alerts": alerts,
        "briefing": build_briefing(municipalities, alerts),
        "ranking_24h": [item["name"] for item in ranked],
        "municipalities": municipalities,
        "notes": [
            "Rain levels are PAGASA-equivalent: AGOS applies PAGASA Heavy Rainfall Warning intensity criteria to model forecasts. They are not official PAGASA warnings.",
            *outlook.get("limitations", []),
        ],
    }


# ---------------------------------------------------------------------
# Alerts and plain-language briefing (template text from real data only)
# ---------------------------------------------------------------------

WARNING_LEVELS = ("yellow", "orange", "red")
LEVEL_WORDS = {
    "en": {"yellow": "Yellow-level", "orange": "Orange-level", "red": "Red-level"},
    "fil": {"yellow": "Yellow-level", "orange": "Orange-level", "red": "Red-level"},
}
WEEKDAYS_FIL = ["Lunes", "Martes", "Miyerkules", "Huwebes", "Biyernes", "Sabado", "Linggo"]


def _local(stamp: str | None) -> datetime | None:
    if not stamp:
        return None
    try:
        parsed = datetime.fromisoformat(stamp)
    except ValueError:
        return None
    return parsed.replace(tzinfo=PH_TZ) if parsed.tzinfo is None else parsed.astimezone(PH_TZ)


def format_when(stamp: str | None, lang: str = "en") -> str:
    """'Sun 4 PM' / 'Linggo 4 PM'. Empty string if the time is unknown."""
    moment = _local(stamp)
    if moment is None:
        return ""
    hour = moment.strftime("%I %p").lstrip("0")
    day = WEEKDAYS_FIL[moment.weekday()] if lang == "fil" else moment.strftime("%a")
    return f"{day} {hour}"


def build_alerts(municipalities: list[dict], window_hours: int = 24) -> list[dict]:
    """One alert per town whose forecast reaches yellow intensity or more."""
    alerts = []

    for muni in municipalities:
        series = (muni.get("series") or [])[:window_hours]
        hot = [p for p in series if p.get("level") in WARNING_LEVELS]
        if not hot:
            continue
        peak = max(hot, key=lambda p: p["precipitation_mm"])
        level = rain_level(peak["precipitation_mm"])
        alerts.append({
            "municipality": muni.get("name"),
            "level": level,
            "peak_mm_h": round(peak["precipitation_mm"], 1),
            "peak_time": peak.get("time"),
            "starts": hot[0].get("time"),
            "ends": hot[-1].get("time"),
            "hours_at_or_above_yellow": len(hot),
            "text": {
                "en": f"{LEVEL_WORDS['en'][level]} rain intensity possible in {muni.get('name')}, heaviest {peak['precipitation_mm']:.1f} mm/h around {format_when(peak.get('time'), 'en')}.",
                "fil": f"Posible ang {LEVEL_WORDS['fil'][level].lower()} na lakas ng ulan sa {muni.get('name')}, pinakamalakas na {peak['precipitation_mm']:.1f} mm/h bandang {format_when(peak.get('time'), 'fil')}.",
            },
        })

    alerts.sort(key=lambda a: (level_rank(a["level"]), a["peak_mm_h"]), reverse=True)
    return alerts


def _join(names: list[str], word: str) -> str:
    if len(names) <= 1:
        return "".join(names)
    return f"{', '.join(names[:-1])} {word} {names[-1]}"


def build_briefing(municipalities: list[dict], alerts: list[dict]) -> dict[str, str]:
    """Plain-language summary in English and Filipino, from the numbers only."""
    with_data = [
        m for m in municipalities
        if m.get("windows", {}).get("next_24h", {}).get("peak_mm_h") is not None
    ]
    tail_en = "Forecast-based (Open-Meteo model), not an official PAGASA warning."
    tail_fil = "Batay sa forecast (Open-Meteo model), hindi opisyal na babala ng PAGASA."

    if not with_data:
        return {
            "en": "Rain forecast data is not available right now.",
            "fil": "Walang makuhang datos ng forecast ng ulan sa ngayon.",
        }

    if not alerts:
        top = max(with_data, key=lambda m: m["windows"]["next_24h"]["peak_mm_h"])
        w = top["windows"]["next_24h"]
        if w["peak_mm_h"] < LIGHT_RAIN_MM_H:
            return {
                "en": f"Little or no rain is forecast in Bataan in the next 24 hours. {tail_en}",
                "fil": f"Halos walang ulan na inaasahan sa Bataan sa susunod na 24 oras. {tail_fil}",
            }
        return {
            "en": f"No town reaches yellow-level rain intensity in the next 24 hours. Heaviest forecast hour: {w['peak_mm_h']:.1f} mm/h in {top['name']} around {format_when(w['peak_time'], 'en')}. {tail_en}",
            "fil": f"Walang bayan na aabot sa yellow-level na lakas ng ulan sa susunod na 24 oras. Pinakamalakas na oras: {w['peak_mm_h']:.1f} mm/h sa {top['name']} bandang {format_when(w['peak_time'], 'fil')}. {tail_fil}",
        }

    worst = alerts[0]
    same = [a["municipality"] for a in alerts if a["level"] == worst["level"]]
    others = len(alerts) - len(same)
    en = (
        f"{LEVEL_WORDS['en'][worst['level']]} rain intensity possible in {_join(same, 'and')} in the next 24 hours. "
        f"Heaviest: {worst['peak_mm_h']:.1f} mm/h in {worst['municipality']} around {format_when(worst['peak_time'], 'en')}."
    )
    fil = (
        f"Posible ang {LEVEL_WORDS['fil'][worst['level']].lower()} na lakas ng ulan sa {_join(same, 'at')} sa susunod na 24 oras. "
        f"Pinakamalakas: {worst['peak_mm_h']:.1f} mm/h sa {worst['municipality']} bandang {format_when(worst['peak_time'], 'fil')}."
    )
    if others:
        en += f" {others} more town{'s' if others != 1 else ''} at a lower warning color."
        fil += f" May {others} pang bayan na nasa mas mababang kulay."
    return {"en": f"{en} {tail_en}", "fil": f"{fil} {tail_fil}"}


# ---------------------------------------------------------------------
# Evacuation centers (one dataset for the map and the Evacuate page)
# ---------------------------------------------------------------------

def load_evacuation_centers(path: Path = EVACUATION_FILE) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)

    centers = []

    for center in data.get("centers", []):
        lat = _number(center.get("latitude"))
        lon = _number(center.get("longitude"))
        has_point = (
            lat is not None and lon is not None
            and -90 <= lat <= 90 and -180 <= lon <= 180
        )
        centers.append({
            **center,
            "latitude": lat if has_point else None,
            "longitude": lon if has_point else None,
            "has_coordinates": has_point,
        })

    return {
        "source": data.get("source"),
        "note": data.get("compiled_note"),
        "count": len(centers),
        "centers": centers,
    }


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def centers_for_municipality(
    centers: list[dict], name: str, point: dict | None, limit: int = 5
) -> list[dict]:
    """Centers in the municipality first, then the nearest others, with distance."""
    rows = []

    for center in centers:
        distance = None
        if point and center.get("has_coordinates"):
            distance = round(
                haversine_km(
                    point["latitude"], point["longitude"],
                    center["latitude"], center["longitude"],
                ),
                1,
            )
        rows.append({**center, "distance_km_from_town_point": distance})

    rows.sort(
        key=lambda c: (
            0 if str(c.get("municipality", "")).casefold() == name.casefold() else 1,
            c["distance_km_from_town_point"] if c["distance_km_from_town_point"] is not None else 1e9,
        )
    )
    return rows[:limit]


# ---------------------------------------------------------------------
# Municipality detail: several independent sections
# ---------------------------------------------------------------------

def _section(loader: Callable[[], Any]) -> dict[str, Any]:
    try:
        return {"status": "ok", "data": loader()}
    except Exception as error:  # noqa: BLE001 - report, never crash the page
        return {"status": "unavailable", "detail": str(error)}


def municipality_detail(
    name: str,
    *,
    municipalities: dict,
    get_current: Callable[[str], dict],
    get_outlook: Callable[[int], dict],
    get_discharge: Callable[[int], dict],
    get_centers: Callable[[], dict],
) -> dict[str, Any]:
    """Compose everything AGOS knows about one municipality."""
    match = next(
        (key for key in municipalities if key.casefold() == name.strip().casefold()),
        None,
    )
    if match is None:
        raise ValueError(f"Unknown municipality: {name}")

    point = municipalities[match]

    def rain():
        overview = build_overview(get_outlook(48))
        row = next(
            (m for m in overview["municipalities"] if m["name"] == match), None
        )
        if row is None:
            raise RuntimeError("No rainfall forecast returned for this municipality")
        return {
            **row,
            "generated_at": overview["generated_at"],
            "source": overview["source"],
            "method": overview["method"],
            "thresholds_mm_h": overview["thresholds_mm_h"],
        }

    def discharge():
        outlook = get_discharge(7)
        row = next(
            (m for m in outlook.get("municipalities", []) if m.get("municipality") == match),
            None,
        )
        if row is None:
            raise RuntimeError("No river discharge returned for this municipality")
        return {
            "status": row.get("status"),
            "daily": [
                {
                    "date": day.get("date"),
                    "river_discharge": day.get("river_discharge"),
                    "p25": day.get("river_discharge_p25"),
                    "p75": day.get("river_discharge_p75"),
                }
                for day in row.get("daily", [])
            ],
            "unit": "m³/s",
            "model_point": row.get("model_coordinates"),
            "source": row.get("source", "Open-Meteo Flood API / GloFAS"),
            "note": row.get("spatial_note"),
            "generated_at": outlook.get("generated_at"),
        }

    def evacuation():
        data = get_centers()
        return {
            "note": data.get("note"),
            "centers": centers_for_municipality(data["centers"], match, point),
        }

    return {
        "name": match,
        "point": point,
        "generated_at": datetime.now(PH_TZ).isoformat(timespec="seconds"),
        "current_weather": _section(lambda: get_current(match)),
        "rain": _section(rain),
        "river_discharge": _section(discharge),
        "evacuation_centers": _section(evacuation),
        "susceptibility": {
            "status": "not_available",
            "detail": "Municipality-level flood susceptibility is not computed yet. The MGB map layer is available on the Map page.",
        },
    }
