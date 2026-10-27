"""
AGOS — flood risk on the day of a storm read from an article (past, present or near future).

Nothing new is modeled here. For the chosen day this returns:

- the tested warning sign per town (flood_factors_service.day_report): the
  stored rain record for past days, the Open-Meteo forecast API for recent days,
  today and the next 2 days;
- where the storm stood relative to the towns, from the article's own numbers:
  distance from the storm centre to each town point and which towns lie inside
  the wind-extent radius the article states. Context only: storm strength and
  distance are NOT part of the sign, because no storm rule has been tested on
  Bataan's floods;
- for days with listed floods around them, which towns the list names as flooded
  next to the towns where the sign was raised, so past storms can be checked.

Not an official warning and not a flood probability.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Mapping

EARTH_RADIUS_KM = 6371.0


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance (haversine)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def storm_context(
    latitude: float | None,
    longitude: float | None,
    radius_km: float | None,
    municipalities: Mapping[str, Mapping[str, float]],
) -> dict[str, Any] | None:
    """Distance from the storm centre to every town point, nearest first, and the towns inside the stated radius."""
    if latitude is None or longitude is None:
        return None
    towns = sorted(
        ({"name": name, "km": round(distance_km(latitude, longitude, p["latitude"], p["longitude"]))} for name, p in municipalities.items()),
        key=lambda x: x["km"],
    )
    return {
        "position": {"latitude": latitude, "longitude": longitude},
        "radius_km": radius_km,
        "nearest": towns[0] if towns else None,
        "farthest": towns[-1] if towns else None,
        "inside_radius": [t["name"] for t in towns if t["km"] <= radius_km] if radius_km else None,
        "towns": towns,
    }


def comparison(factors: Mapping[str, Any]) -> dict[str, Any] | None:
    """Towns the flood list names as flooded around the day, next to the towns where the sign was raised."""
    near = factors.get("events_near") or []
    if not near:
        return None
    flooded = sorted({town for event in near for town in event.get("towns", [])})
    raised = list(factors.get("raised") or [])
    return {
        "listed_flooded": flooded,
        "raised": raised,
        "both": [t for t in flooded if t in raised],
        "flooded_not_raised": [t for t in flooded if t not in raised],
        "raised_not_listed": [t for t in raised if t not in flooded],
    }


def storm_flood_risk(
    day: str,
    latitude: float | None = None,
    longitude: float | None = None,
    radius_km: float | None = None,
    municipalities: Mapping[str, Mapping[str, float]] | None = None,
    report: Callable[[str], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if municipalities is None:
        from app.data.municipalities import MUNICIPALITIES as municipalities
    if report is None:
        from app.services.flood_factors_service import day_report as report
    factors = report(day)
    return {
        "date": day,
        "mode": factors["mode"],
        "factors": factors,
        "storm": storm_context(latitude, longitude, radius_km, municipalities),
        "comparison": comparison(factors),
        "notes": [
            "The sign is the tested rain rule for that day: 3-day rain ranked against each town's own record. Storm strength and distance are shown for context and are not part of it.",
            "Past days use the rain that actually fell (ERA5) where AGOS has it stored; recent days use Open-Meteo model analysis; today and the next 2 days use the forecast.",
            "The flood list comes from news and official reports and misses small floods, so a town not listed may still have flooded.",
            "Not an official warning and not a flood probability; follow PAGASA and your MDRRMO.",
        ],
    }
