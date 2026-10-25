"""
AGOS — read-only endpoints for the redesigned interface (/api/...).

Thin wrappers around existing services. They add no new data source.
"""

from fastapi import APIRouter, HTTPException, Query

from app.data.municipalities import MUNICIPALITIES
from app.services import overview_service as overview
from app.services.climate_service import climate_report
from app.services.history_service import history_report
from app.services import evidence_service, flood_events_service
from app.services import typhoon_service
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


@router.get("/history")
def daily_history(days: int = Query(30, ge=7, le=365)):
    """Daily rain and river flow per town, from the AGOS database only."""
    return history_report(days=days)


@router.get("/flood-events")
def flood_events():
    """Past Bataan flood events from news and official reports, with sources (kept in the AGOS database)."""
    try:
        return flood_events_service.events_report()
    except ValueError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@router.get("/flood-evidence")
def flood_evidence():
    """How unusual rain and river flow were before each known flood, per town (AGOS database only)."""
    try:
        return evidence_service.evidence_report()
    except ValueError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


@router.get("/climate")
def rainfall_climate():
    """Yearly totals, monthly pattern, trend and return levels per town, from the AGOS database only."""
    return climate_report()


@router.get("/typhoon/from-url")
def typhoon_from_url(url: str = Query(..., min_length=8, max_length=2048)):
    """Storm details stated in a news article or bulletin (unverified, extracted text)."""
    try:
        return typhoon_service.typhoon_from_url(url)
    except typhoon_service.UrlRejected as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except typhoon_service.FetchFailed as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
