"""
AGOS — system status route

Reports whether the API is running, how the background ingestion
scheduler is doing, and basic database statistics. It never returns
secrets: only whether the WeatherAPI key is configured.
"""

from fastapi import APIRouter

from app.config.settings import WEATHERAPI_API_KEY
from app.services.scheduler import scheduler

router = APIRouter(prefix="/system", tags=["System"])


@router.get("/status")
def system_status():
    # Imported here so a broken database never prevents the API from starting.
    from agos_data_lifecycle import lifecycle_health

    try:
        database = lifecycle_health()
    except Exception as error:  # noqa: BLE001
        database = {"status": "error", "detail": str(error)}

    return {
        "api": {"status": "running"},
        "scheduler": scheduler.status(),
        "database": database,
        "weatherapi_key_configured": bool(WEATHERAPI_API_KEY),
    }
