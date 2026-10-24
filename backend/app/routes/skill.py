"""AGOS — forecast skill route (forecast accuracy and bias)."""

from fastapi import APIRouter, Query

from app.services.forecast_skill import skill_report

router = APIRouter(prefix="/skill", tags=["Forecast skill"])


@router.get("/rain")
def rain_skill(days: int = Query(30, ge=7, le=365)):
    return skill_report(days=days)
