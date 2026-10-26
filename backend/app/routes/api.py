"""
AGOS — read-only endpoints for the redesigned interface (/api/...).

Thin wrappers around existing services. They add no new data source.
"""

from fastapi import APIRouter, HTTPException, Query

from app.data.municipalities import MUNICIPALITIES
from app.services import overview_service as overview
from app.services.history_service import history_report
from app.services import typhoon_service
from app.services import flood_risk_service
from app.services import analysis_service
from app.services import consensus_service
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


def _outlook(hours: int) -> dict:
    """AGOS consensus of six models; the default model only if the multi-model request fails."""
    try:
        return consensus_service.rainfall_outlook(hours=hours)
    except (ValueError, RuntimeError, KeyError) as error:
        outlook = get_bataan_rainfall_outlook(hours=hours)
        outlook["method"] = "single_model_fallback"
        outlook["source"] = "Open-Meteo default model (AGOS consensus unavailable)"
        outlook.setdefault("limitations", []).insert(0, f"AGOS consensus unavailable ({error}); showing the default model only.")
        return outlook


def _current(name: str) -> dict:
    try:
        return consensus_service.current_conditions(name)
    except (ValueError, RuntimeError, KeyError):
        data = get_current_weather(name)
        data["method"] = "single_model_fallback"
        return data


@router.get("/overview")
def province_overview(hours: int = Query(48, ge=6, le=48)):
    try:
        return overview.build_overview(_outlook(hours))
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.get("/municipalities/{name}")
def municipality(name: str):
    try:
        return overview.municipality_detail(
            name,
            municipalities=MUNICIPALITIES,
            get_current=_current,
            get_outlook=_outlook,
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


@router.get("/typhoon/from-url")
def typhoon_from_url(url: str = Query(..., min_length=8, max_length=2048)):
    """Storm details stated in a news article or bulletin (unverified, extracted text)."""
    try:
        return typhoon_service.typhoon_from_url(url)
    except typhoon_service.UrlRejected as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except typhoon_service.FetchFailed as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.get("/flood-risk")
def flood_risk(
    storm_lat: float | None = Query(None, ge=-60, le=60),
    storm_lon: float | None = Query(None, ge=-180, le=180),
    storm_radius_km: float | None = Query(None, gt=0, le=2000),
    storm_strength: int | None = Query(None, ge=0, le=4),
    storm_name: str | None = Query(None, max_length=60),
):
    """Flood-risk indicator per town (DRAFT rules, unverified). Optional storm from an article."""
    storm = None
    if storm_lat is not None and storm_lon is not None:
        storm = {
            "latitude": storm_lat, "longitude": storm_lon, "radius_km": storm_radius_km,
            "strength_level": storm_strength, "name": storm_name,
        }
    try:
        return flood_risk_service.build_flood_risk(storm=storm)
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.get("/analysis/{name}")
def municipality_analysis(name: str):
    """Step-by-step data analysis behind one town's forecast numbers (fetch, clean, statistics, models, climate, skill, classification)."""
    try:
        return analysis_service.analyze_municipality(
            name, skill=analysis_service.default_skill, risk=analysis_service.default_risk,
        )
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.get("/flood-risk/history")
def flood_risk_history(start: str | None = Query(None, description="YYYY-MM-DD; default 1 August of this year"),
                       end: str | None = Query(None, description="YYYY-MM-DD; default yesterday")):
    """The flood-risk indicator rebuilt for each past day (draft rules, not checked against recorded floods)."""
    from datetime import date as date_type

    from app.services import flood_history_service

    try:
        start_date = date_type.fromisoformat(start) if start else None
        end_date = date_type.fromisoformat(end) if end else None
        return flood_history_service.cached_history(start_date, end_date)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
