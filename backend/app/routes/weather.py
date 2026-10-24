
# ==========================================
# AGOS
# Weather Routes
# ==========================================

from fastapi import APIRouter, Query, HTTPException

from app.services.weather_service import (
    get_current_weather,
    get_hourly_forecast_grid,
    get_hourly_forecast_series,
    get_bataan_rainfall_outlook,
    get_bataan_flood_outlook,
    FORECAST_VARIABLES,
)

router = APIRouter()


def _raise_weather_error(error):
    message = str(error)
    lowered = message.lower()
    status_code = 502

    if "unknown municipality" in lowered:
        status_code = 404
    elif (
        "past" in lowered
        or "beyond the supported" in lowered
        or "must use yyyy-mm-dd" in lowered
        or "must be an integer" in lowered
        or "hours must" in lowered
        or "forecast_days must" in lowered
        or "unsupported forecast variable" in lowered
    ):
        status_code = 422
    elif "daily request limit exceeded" in lowered:
        status_code = 503

    raise HTTPException(
        status_code=status_code,
        detail=message,
    )


@router.get("/weather")
def weather(
    municipality: str = Query(
        "Balanga",
        description="Selected Bataan municipality",
    ),
):
    try:
        return get_current_weather(municipality)
    except (ValueError, RuntimeError) as error:
        _raise_weather_error(error)


@router.get("/weather/forecast-grid")
def weather_forecast_grid(
    municipality: str = Query(
        "Balanga",
        description="Selected Bataan municipality",
    ),
    variable: str = Query(
        "precipitation",
        description="Supported Open-Meteo hourly variable",
    ),
    date: str = Query(
        ...,
        description="Date in YYYY-MM-DD format, Philippine local date",
    ),
    hour: int = Query(
        15,
        ge=0,
        le=23,
        description="Hour in Philippine local time, 0-23",
    ),
):
    if variable not in FORECAST_VARIABLES:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Unsupported forecast variable",
                "supported_variables": list(FORECAST_VARIABLES.keys()),
            },
        )

    try:
        return get_hourly_forecast_grid(
            municipality=municipality,
            variable=variable,
            forecast_date=date,
            hour=hour,
        )
    except (ValueError, RuntimeError) as error:
        _raise_weather_error(error)


@router.get("/weather/forecast-series")
def weather_forecast_series(
    municipality: str = Query(
        "Balanga",
        description="Selected Bataan municipality",
    ),
    variable: str = Query(
        "precipitation",
        description="Supported Open-Meteo hourly variable",
    ),
    date: str = Query(
        ...,
        description="Date in YYYY-MM-DD format, Philippine local date",
    ),
):
    if variable not in FORECAST_VARIABLES:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Unsupported forecast variable",
                "supported_variables": list(FORECAST_VARIABLES.keys()),
            },
        )

    try:
        return get_hourly_forecast_series(
            municipality=municipality,
            variable=variable,
            forecast_date=date,
        )
    except (ValueError, RuntimeError) as error:
        _raise_weather_error(error)


@router.get("/weather/rainfall-outlook")
def weather_rainfall_outlook(
    hours: int = Query(
        6,
        ge=1,
        le=24,
        description="Number of hourly forecast steps to return, 1-24",
    ),
):
    """Hourly rainfall forecast for all configured municipalities."""
    try:
        return get_bataan_rainfall_outlook(hours=hours)
    except (ValueError, RuntimeError) as error:
        _raise_weather_error(error)


@router.get("/weather/flood-outlook")
def weather_flood_outlook(
    forecast_days: int = Query(
        7,
        ge=1,
        le=30,
        description="Number of daily GloFAS discharge forecast days, 1-30",
    ),
):
    """Daily simulated river discharge from Open-Meteo Flood API / GloFAS."""
    try:
        return get_bataan_flood_outlook(
            forecast_days=forecast_days
        )
    except (ValueError, RuntimeError) as error:
        _raise_weather_error(error)
