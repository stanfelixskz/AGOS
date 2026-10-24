
import logging
import threading
import time
from copy import deepcopy
from datetime import datetime, timezone

import requests

from app.config.settings import (
    LATITUDE,
    LONGITUDE,
    WEATHERAPI_API_KEY,
    WEATHERAPI_BASE_URL,
    WEATHER_CACHE_TTL_SECONDS,
    WEATHER_STALE_CACHE_TTL_SECONDS,
    WEATHER_REQUEST_TIMEOUT_SECONDS,
)

logger = logging.getLogger(__name__)

_CACHE_LOCK = threading.Lock()
_CACHE_DATA = None
_CACHE_FETCHED_AT = 0.0


def _fetch_rainfall_grid():
    """Fetch actual current weather for the Balanga City reference point."""

    if not WEATHERAPI_API_KEY:
        raise RuntimeError(
            "WeatherAPI key is missing. Set WEATHERAPI_API_KEY "
            "in backend/.env and restart the backend."
        )

    url = f"{WEATHERAPI_BASE_URL}/current.json"

    params = {
        "key": WEATHERAPI_API_KEY,
        "q": f"{LATITUDE},{LONGITUDE}",
        "aqi": "no",
    }

    try:
        response = requests.get(
            url,
            params=params,
            timeout=WEATHER_REQUEST_TIMEOUT_SECONDS,
        )

        try:
            payload = response.json()
        except ValueError:
            payload = {}

        if not response.ok:
            error_info = payload.get("error", {})
            message = error_info.get(
                "message",
                f"WeatherAPI returned HTTP {response.status_code}.",
            )
            # Do not include the request URL; it contains the API key.
            raise RuntimeError(f"WeatherAPI request failed: {message}")

    except requests.RequestException as error:
        raise RuntimeError(
            f"WeatherAPI request failed: {error}"
        ) from error

    location = payload.get("location") or {}
    current = payload.get("current") or {}
    condition = current.get("condition") or {}

    if not current:
        raise RuntimeError(
            "WeatherAPI response did not contain current weather data."
        )

    precipitation = current.get("precip_mm")
    fetched_at = datetime.now(timezone.utc).isoformat()

    cell = {
        "id": "balanga_reference",
        "latitude": location.get("lat", LATITUDE),
        "longitude": location.get("lon", LONGITUDE),
        "precipitation_mm": precipitation,
        "model_time": current.get("last_updated"),
        "temperature_c": current.get("temp_c"),
        "feelslike_c": current.get("feelslike_c"),
        "humidity_percent": current.get("humidity"),
        "cloud_percent": current.get("cloud"),
        "wind_kph": current.get("wind_kph"),
        "wind_direction": current.get("wind_dir"),
        "condition_text": condition.get("text"),
        "condition_code": condition.get("code"),
        "is_day": current.get("is_day"),
    }

    return {
        "source": "WeatherAPI.com",
        "variable": "current weather and precipitation",
        "unit": "mm",
        "interpretation": (
            "Current weather returned for one reference location "
            "in Balanga City, Bataan. Precipitation is the provider's "
            "reported current-condition value, not a rainfall grid, "
            "daily accumulation, rain-gauge observation, or flood "
            "measurement. Do not infer conditions for other locations."
        ),
        "last_updated": current.get("last_updated"),
        "grid_step_degrees": None,
        "cells": [cell],
        "reference_location": {
            "name": location.get("name", "Balanga"),
            "region": location.get("region", "Bataan"),
            "country": location.get("country", "Philippines"),
            "latitude": cell["latitude"],
            "longitude": cell["longitude"],
        },
        "cache": {
            "is_cached": False,
            "is_stale": False,
            "fetched_at": fetched_at,
        },
    }


def get_rainfall_grid():
    """Return fresh cached weather or safely fall back to stale data."""

    global _CACHE_DATA, _CACHE_FETCHED_AT

    with _CACHE_LOCK:
        now = time.monotonic()

        if (
            _CACHE_DATA is not None
            and now - _CACHE_FETCHED_AT < WEATHER_CACHE_TTL_SECONDS
        ):
            result = deepcopy(_CACHE_DATA)
            result["cache"]["is_cached"] = True
            result["cache"]["is_stale"] = False
            return result

        try:
            result = _fetch_rainfall_grid()

        except RuntimeError:
            if _CACHE_DATA is not None:
                cache_age = now - _CACHE_FETCHED_AT

                if cache_age <= WEATHER_STALE_CACHE_TTL_SECONDS:
                    logger.warning(
                        "WeatherAPI refresh failed; serving stale cache.",
                        exc_info=True,
                    )
                    stale_result = deepcopy(_CACHE_DATA)
                    stale_result["cache"]["is_cached"] = True
                    stale_result["cache"]["is_stale"] = True
                    stale_result["cache"]["stale_reason"] = (
                        "WeatherAPI could not refresh the current conditions."
                    )
                    return stale_result

            raise

        _CACHE_DATA = deepcopy(result)
        _CACHE_FETCHED_AT = time.monotonic()

        return deepcopy(result)
