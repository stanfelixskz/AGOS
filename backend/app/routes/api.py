"""
AGOS — read-only endpoints for the redesigned interface (/api/...).

Thin wrappers around existing services. They add no new data source.
"""

from fastapi import APIRouter, HTTPException, Query

from app.data.municipalities import MUNICIPALITIES
from app.services import overview_service as overview
from app.services.weather_service import (
    get_bataan_flood_outlook,
    get_bataan_rainfall_outlook,
    get_current_weather,
)

router = APIRouter(prefix="/api", tags=["AGOS interface"])


@router.get("/municipalities")
def list_municipalities():
    return {
        "count": len(MUNICIPALITIES),
        "municipalities": [
            {"name": name, **point} for name, point in MUNICIPALITIES.items()
        ],
        "note": "One reference point per municipality, used for all forecasts. It is not an official administrative centroid.",
    }


@router.get("/overview")
def province_overview(hours: int = Query(48, ge=6, le=48)):
    try:
        return overview.build_overview(get_bataan_rainfall_outlook(hours=hours))
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.get("/municipalities/{name}")
def municipality(name: str):
    try:
        return overview.municipality_detail(
            name,
            municipalities=MUNICIPALITIES,
            get_current=get_current_weather,
            get_outlook=lambda hours: get_bataan_rainfall_outlook(hours=hours),
            get_discharge=lambda days: get_bataan_flood_outlook(forecast_days=days),
            get_centers=overview.load_evacuation_centers,
        )
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/evacuation-centers")
def evacuation_centers():
    try:
        return overview.load_evacuation_centers()
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=500, detail=f"Evacuation list could not be read: {error}") from error
