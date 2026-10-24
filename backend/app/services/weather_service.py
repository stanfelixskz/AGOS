# ==========================================
# AGOS
# Weather + Flood Forecast Service
# ==========================================

from datetime import date as date_type, datetime, timedelta
from threading import Lock
from zoneinfo import ZoneInfo
from typing import Any

import requests

from app.config.settings import OPEN_METEO_URL
from app.data.municipalities import MUNICIPALITIES


FORECAST_TIMEZONE = "Asia/Manila"
FLOOD_API_URL = "https://flood-api.open-meteo.com/v1/flood"

CACHE_TTL_SECONDS = 900
FLOOD_CACHE_TTL_SECONDS = 21600
REQUEST_TIMEOUT_SECONDS = 25

_cache: dict[tuple, tuple[float, Any]] = {}
_cache_lock = Lock()


# Keep these variable names available to the existing routes.
FORECAST_VARIABLES = {
    "precipitation": {
        "api_name": "precipitation",
        "unit": "mm",
        "label": "Precipitation",
    },
    "rain": {
        "api_name": "rain",
        "unit": "mm",
        "label": "Rain",
    },
    "precipitation_probability": {
        "api_name": "precipitation_probability",
        "unit": "%",
        "label": "Precipitation probability",
    },
    "temperature_2m": {
        "api_name": "temperature_2m",
        "unit": "°C",
        "label": "Temperature at 2 m",
    },
    "relative_humidity_2m": {
        "api_name": "relative_humidity_2m",
        "unit": "%",
        "label": "Relative humidity",
    },
    "cloud_cover": {
        "api_name": "cloud_cover",
        "unit": "%",
        "label": "Cloud cover",
    },
    "wind_speed_10m": {
        "api_name": "wind_speed_10m",
        "unit": "km/h",
        "label": "Wind speed at 10 m",
    },
    "wind_gusts_10m": {
        "api_name": "wind_gusts_10m",
        "unit": "km/h",
        "label": "Wind gusts at 10 m",
    },
    "soil_moisture_0_to_10cm": {
        "api_name": "soil_moisture_0_to_10cm",
        "unit": "m³/m³",
        "label": "Soil moisture (0–10 cm)",
    },
    "soil_temperature_0_to_10cm": {
        "api_name": "soil_temperature_0_to_10cm",
        "unit": "°C",
        "label": "Soil temperature (0–10 cm)",
    },
    "et0_fao_evapotranspiration": {
        "api_name": "et0_fao_evapotranspiration",
        "unit": "mm",
        "label": "Reference evapotranspiration",
    },
}

CURRENT_VARIABLES = [
    "temperature_2m",
    "relative_humidity_2m",
    "apparent_temperature",
    "is_day",
    "precipitation",
    "rain",
    "showers",
    "weather_code",
    "cloud_cover",
    "wind_speed_10m",
    "wind_direction_10m",
    "wind_gusts_10m",
]

RAINFALL_OUTLOOK_VARIABLES = [
    "precipitation",
    "rain",
    "precipitation_probability",
]

FLOOD_DAILY_VARIABLES = [
    "river_discharge",
    "river_discharge_mean",
    "river_discharge_median",
    "river_discharge_max",
    "river_discharge_min",
    "river_discharge_p25",
    "river_discharge_p75",
]


def _now_local() -> datetime:
    return datetime.now(ZoneInfo(FORECAST_TIMEZONE))


def _cached_request(
    url: str,
    params: dict,
    ttl_seconds: int = CACHE_TTL_SECONDS,
) -> Any:
    """GET JSON with an in-process cache."""
    cache_key = (
        url,
        tuple(sorted((str(k), str(v)) for k, v in params.items())),
    )
    now_epoch = datetime.now().timestamp()

    with _cache_lock:
        cached = _cache.get(cache_key)
        if cached and now_epoch - cached[0] < ttl_seconds:
            return cached[1]

    try:
        response = requests.get(
            url,
            params=params,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as error:
        raise RuntimeError(
            f"Open-Meteo request failed: {error}"
        ) from error

    if response.status_code == 429:
        raise RuntimeError("Open-Meteo daily request limit exceeded")

    if response.status_code >= 400:
        raise RuntimeError(
            f"Open-Meteo returned HTTP {response.status_code}: "
            f"{response.text[:300]}"
        )

    try:
        payload = response.json()
    except ValueError as error:
        raise RuntimeError(
            "Open-Meteo returned invalid JSON"
        ) from error

    if isinstance(payload, dict) and payload.get("error"):
        reason = (
            payload.get("reason")
            or payload.get("message")
            or "Unknown API error"
        )
        raise RuntimeError(f"Open-Meteo API error: {reason}")

    with _cache_lock:
        _cache[cache_key] = (now_epoch, payload)

    return payload


def _get_location(municipality: str = "Balanga") -> tuple[str, dict]:
    if not isinstance(municipality, str) or not municipality.strip():
        raise ValueError("Municipality must be a non-empty name")

    requested = municipality.strip()

    for name, coordinates in MUNICIPALITIES.items():
        if name.casefold() == requested.casefold():
            return name, coordinates

    raise ValueError(f"Unknown municipality: {requested}")


def _request_open_meteo(municipality: str, params: dict) -> dict:
    name, coordinates = _get_location(municipality)

    request_params = {
        "latitude": coordinates["latitude"],
        "longitude": coordinates["longitude"],
        "timezone": FORECAST_TIMEZONE,
        **params,
    }

    payload = _cached_request(OPEN_METEO_URL, request_params)

    if not isinstance(payload, dict):
        raise RuntimeError("Unexpected Open-Meteo forecast response")

    payload["_agos_municipality"] = name
    payload["_agos_requested_coordinates"] = coordinates
    return payload


def _validate_forecast_time(
    forecast_date: str,
    hour: int | None = None,
) -> tuple[date_type, int | None]:
    if not isinstance(forecast_date, str):
        raise ValueError("Date must use YYYY-MM-DD format")

    try:
        parsed_date = date_type.fromisoformat(forecast_date)
    except (TypeError, ValueError) as error:
        raise ValueError(
            "Date must use YYYY-MM-DD format"
        ) from error

    today = _now_local().date()
    max_date = today + timedelta(days=15)

    if parsed_date < today:
        raise ValueError("Forecast date cannot be in the past")

    if parsed_date > max_date:
        raise ValueError(
            "Forecast date is beyond the supported 15-day window"
        )

    if hour is not None:
        if isinstance(hour, bool) or not isinstance(hour, int):
            raise ValueError("Hour must be an integer from 0 to 23")

        if not 0 <= hour <= 23:
            raise ValueError("Hour must be an integer from 0 to 23")

        if parsed_date == today and hour < _now_local().hour:
            raise ValueError("Forecast time cannot be in the past")

    return parsed_date, hour


def get_current_weather(municipality: str = "Balanga") -> dict:
    """Get current weather for one configured municipality."""
    name, coordinates = _get_location(municipality)

    payload = _request_open_meteo(
        name,
        {
            "current": ",".join(CURRENT_VARIABLES),
            "temperature_unit": "celsius",
            "wind_speed_unit": "kmh",
            "precipitation_unit": "mm",
            "forecast_days": 1,
        },
    )

    current = payload.get("current") or {}
    units = payload.get("current_units") or {}

    return {
        "municipality": name,
        "latitude": payload.get("latitude", coordinates["latitude"]),
        "longitude": payload.get("longitude", coordinates["longitude"]),
        "requested_coordinates": coordinates,
        "timezone": payload.get("timezone", FORECAST_TIMEZONE),
        "source": "Open-Meteo Forecast API",
        "updated_at": current.get("time"),
        "current": current,
        "current_units": units,
        "temperature_c": current.get("temperature_2m"),
        "humidity_percent": current.get("relative_humidity_2m"),
        "apparent_temperature_c": current.get("apparent_temperature"),
        "precipitation_mm": current.get("precipitation"),
        "rain_mm": current.get("rain"),
        "cloud_cover_percent": current.get("cloud_cover"),
        "wind_speed_kmh": current.get("wind_speed_10m"),
        "wind_direction_degrees": current.get("wind_direction_10m"),
        "wind_gusts_kmh": current.get("wind_gusts_10m"),
        "weather_code": current.get("weather_code"),
        "is_day": current.get("is_day"),
    }


def get_hourly_forecast_series(
    municipality: str = "Balanga",
    variable: str = "precipitation",
    forecast_date: str | None = None,
) -> dict:
    """Get hourly forecast values for one variable and municipality."""
    if variable not in FORECAST_VARIABLES:
        raise ValueError(
            "Unsupported forecast variable. Supported variables: "
            + ", ".join(FORECAST_VARIABLES.keys())
        )

    if not forecast_date:
        forecast_date = _now_local().date().isoformat()

    parsed_date, _ = _validate_forecast_time(forecast_date)
    name, coordinates = _get_location(municipality)
    api_variable = FORECAST_VARIABLES[variable]["api_name"]

    payload = _request_open_meteo(
        name,
        {
            "hourly": api_variable,
            "start_date": parsed_date.isoformat(),
            "end_date": parsed_date.isoformat(),
            "temperature_unit": "celsius",
            "wind_speed_unit": "kmh",
            "precipitation_unit": "mm",
        },
    )

    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    values = hourly.get(api_variable) or []

    points = [
        {
            "time": timestamp,
            "value": values[index] if index < len(values) else None,
            "variable": variable,
            "unit": FORECAST_VARIABLES[variable]["unit"],
        }
        for index, timestamp in enumerate(times)
    ]

    return {
        "municipality": name,
        "latitude": payload.get("latitude", coordinates["latitude"]),
        "longitude": payload.get("longitude", coordinates["longitude"]),
        "requested_coordinates": coordinates,
        "date": parsed_date.isoformat(),
        "timezone": payload.get("timezone", FORECAST_TIMEZONE),
        "variable": variable,
        "label": FORECAST_VARIABLES[variable]["label"],
        "unit": FORECAST_VARIABLES[variable]["unit"],
        "source": "Open-Meteo Forecast API",
        "points": points,
    }


def get_hourly_forecast_grid(
    municipality: str = "Balanga",
    variable: str = "precipitation",
    forecast_date: str | None = None,
    hour: int = 15,
) -> dict:
    """
    Return a point forecast at the selected municipality coordinate.

    This deliberately does not invent a polygon or claim to be a spatial grid.
    """
    if variable not in FORECAST_VARIABLES:
        raise ValueError(
            "Unsupported forecast variable. Supported variables: "
            + ", ".join(FORECAST_VARIABLES.keys())
        )

    if not forecast_date:
        forecast_date = _now_local().date().isoformat()

    parsed_date, parsed_hour = _validate_forecast_time(
        forecast_date, hour
    )
    name, coordinates = _get_location(municipality)

    series = get_hourly_forecast_series(
        municipality=name,
        variable=variable,
        forecast_date=parsed_date.isoformat(),
    )

    selected_time = f"{parsed_date.isoformat()}T{parsed_hour:02d}:00"

    selected = next(
        (
            point for point in series["points"]
            if point["time"] == selected_time
        ),
        None,
    )

    if selected is None:
        raise RuntimeError(
            f"No forecast value returned for {selected_time}"
        )

    feature = {
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": [
                series["longitude"],
                series["latitude"],
            ],
        },
        "properties": {
            "municipality": name,
            "variable": variable,
            "label": series["label"],
            "value": selected["value"],
            "unit": series["unit"],
            "time": selected_time,
            "source": series["source"],
            "spatial_resolution_note": (
                "Point forecast at a representative municipality coordinate; "
                "not an area-wide grid or flood extent."
            ),
        },
    }

    return {
        "type": "FeatureCollection",
        "features": [feature],
        "municipality": name,
        "date": parsed_date.isoformat(),
        "hour": parsed_hour,
        "time": selected_time,
        "variable": variable,
        "unit": series["unit"],
        "source": series["source"],
        "cells": [
            {
                "municipality": name,
                "latitude": series["latitude"],
                "longitude": series["longitude"],
                "time": selected_time,
                "variable": variable,
                "value": selected["value"],
                "unit": series["unit"],
            }
        ],
        "note": (
            "This is a point forecast for one municipality. It does not "
            "represent a continuous weather grid or confirmed flooding."
        ),
    }


def _multi_location_forecast_payload(
    variables: list[str],
    forecast_days: int = 2,
) -> list[dict]:
    """Fetch hourly weather for all configured municipality coordinates."""
    names = list(MUNICIPALITIES.keys())

    latitudes = [
        str(MUNICIPALITIES[name]["latitude"])
        for name in names
    ]
    longitudes = [
        str(MUNICIPALITIES[name]["longitude"])
        for name in names
    ]

    payload = _cached_request(
        OPEN_METEO_URL,
        {
            "latitude": ",".join(latitudes),
            "longitude": ",".join(longitudes),
            "hourly": ",".join(variables),
            "timezone": FORECAST_TIMEZONE,
            "forecast_days": forecast_days,
            "temperature_unit": "celsius",
            "wind_speed_unit": "kmh",
            "precipitation_unit": "mm",
        },
        ttl_seconds=CACHE_TTL_SECONDS,
    )

    if isinstance(payload, dict):
        payload = [payload]

    if not isinstance(payload, list):
        raise RuntimeError(
            "Unexpected multi-location forecast response"
        )

    if len(payload) != len(names):
        raise RuntimeError(
            "Open-Meteo returned an unexpected number of municipality "
            f"forecasts ({len(payload)} received, {len(names)} expected)"
        )

    return payload


def _parse_local_hour(timestamp: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(timestamp)
    except (TypeError, ValueError) as error:
        raise RuntimeError(
            f"Invalid forecast timestamp returned: {timestamp}"
        ) from error

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=ZoneInfo(FORECAST_TIMEZONE))

    return parsed.astimezone(ZoneInfo(FORECAST_TIMEZONE))


def get_bataan_rainfall_outlook(hours: int = 6) -> dict:
    """
    Return hourly rainfall forecasts for all configured municipalities.

    Accumulation is the sum of the returned hourly precipitation values.
    Each value represents the model forecast at that municipality's point.
    """
    if (
        isinstance(hours, bool)
        or not isinstance(hours, int)
        or not 1 <= hours <= 24
    ):
        raise ValueError("hours must be an integer from 1 to 24")

    now = _now_local()
    payloads = _multi_location_forecast_payload(
        RAINFALL_OUTLOOK_VARIABLES,
        forecast_days=2,
    )

    municipality_results = []
    all_times = []

    for index, name in enumerate(MUNICIPALITIES.keys()):
        coordinates = MUNICIPALITIES[name]
        payload = payloads[index]
        hourly = payload.get("hourly") or {}

        times = hourly.get("time") or []
        precipitation = hourly.get("precipitation") or []
        rain = hourly.get("rain") or []
        probability = hourly.get("precipitation_probability") or []

        if not times:
            raise RuntimeError(
                f"No hourly rainfall forecast returned for {name}"
            )

        current_hour = now.replace(
            minute=0, second=0, microsecond=0
        )

        start_index = next(
            (
                i for i, stamp in enumerate(times)
                if _parse_local_hour(stamp) >= current_hour
            ),
            None,
        )

        if start_index is None:
            raise RuntimeError(
                f"No current/future hourly forecast returned for {name}"
            )

        end_index = min(start_index + hours, len(times))
        points = []

        for i in range(start_index, end_index):
            points.append({
                "time": times[i],
                "precipitation_mm": (
                    precipitation[i]
                    if i < len(precipitation) else None
                ),
                "rain_mm": rain[i] if i < len(rain) else None,
                "precipitation_probability_percent": (
                    probability[i] if i < len(probability) else None
                ),
            })

        valid_precipitation = [
            point["precipitation_mm"]
            for point in points
            if isinstance(point["precipitation_mm"], (int, float))
            and not isinstance(point["precipitation_mm"], bool)
        ]

        municipality_results.append({
            "municipality": name,
            "requested_coordinates": coordinates,
            "model_coordinates": {
                "latitude": payload.get(
                    "latitude", coordinates["latitude"]
                ),
                "longitude": payload.get(
                    "longitude", coordinates["longitude"]
                ),
            },
            "timezone": payload.get(
                "timezone", FORECAST_TIMEZONE
            ),
            "points": points,
            "forecast_hours_returned": len(points),
            "precipitation_accumulation_mm": (
                round(sum(valid_precipitation), 2)
                if valid_precipitation else None
            ),
            "accumulation_period_hours": len(points),
            "source": "Open-Meteo Forecast API",
        })

        for point in points:
            if point["time"] not in all_times:
                all_times.append(point["time"])

    all_times.sort()

    return {
        "title": f"Bataan {hours}-hour rainfall outlook",
        "generated_at": now.isoformat(),
        "timezone": FORECAST_TIMEZONE,
        "hours_requested": hours,
        "source": "Open-Meteo Forecast API",
        "municipality_count": len(municipality_results),
        "municipalities": municipality_results,
        "time_steps": all_times,
        "limitations": [
            "Forecasts represent the configured point coordinate for each municipality.",
            "They do not represent uniform rainfall over the entire municipality.",
            "Rainfall accumulation is not a direct prediction of flood depth or inundation.",
        ],
    }


def get_bataan_flood_outlook(forecast_days: int = 7) -> dict:
    """
    Return daily GloFAS discharge forecasts for configured coordinates.

    Status definitions:
    - available: river_discharge is present for every returned date.
    - partial_data: river_discharge is present for some returned dates.
    - no_data: river_discharge is missing for every returned date.

    Missing readings remain None; they are never replaced with zero.
    """
    if (
        isinstance(forecast_days, bool)
        or not isinstance(forecast_days, int)
        or not 1 <= forecast_days <= 30
    ):
        raise ValueError(
            "forecast_days must be an integer from 1 to 30"
        )

    names = list(MUNICIPALITIES.keys())

    latitudes = [
        str(MUNICIPALITIES[name]["latitude"])
        for name in names
    ]
    longitudes = [
        str(MUNICIPALITIES[name]["longitude"])
        for name in names
    ]

    payload = _cached_request(
        FLOOD_API_URL,
        {
            "latitude": ",".join(latitudes),
            "longitude": ",".join(longitudes),
            "daily": ",".join(FLOOD_DAILY_VARIABLES),
            "forecast_days": forecast_days,
            "timezone": "GMT",
            "cell_selection": "land",
        },
        ttl_seconds=FLOOD_CACHE_TTL_SECONDS,
    )

    if isinstance(payload, dict):
        payloads = [payload]
    elif isinstance(payload, list):
        payloads = payload
    else:
        raise RuntimeError(
            "Unexpected Open-Meteo Flood API response"
        )

    if len(payloads) != len(names):
        raise RuntimeError(
            "Open-Meteo Flood API returned an unexpected number of "
            f"locations ({len(payloads)} received, {len(names)} expected)"
        )

    results = []

    for index, name in enumerate(names):
        coordinates = MUNICIPALITIES[name]
        location_payload = payloads[index]
        daily = location_payload.get("daily") or {}
        dates = daily.get("time") or []

        model_coordinates = {
            "latitude": location_payload.get("latitude"),
            "longitude": location_payload.get("longitude"),
        }

        if not dates:
            results.append({
                "municipality": name,
                "requested_coordinates": coordinates,
                "model_coordinates": model_coordinates,
                "timezone": location_payload.get("timezone", "GMT"),
                "daily_units": location_payload.get("daily_units", {}),
                "daily": [],
                "status": "no_data",
                "valid_discharge_days": 0,
                "missing_discharge_days": 0,
                "data_coverage_percent": 0.0,
                "source": "Open-Meteo Flood API / GloFAS",
                "spatial_note": (
                    "No daily dates were returned for this location. "
                    "This is missing data, not evidence of zero discharge."
                ),
            })
            continue

        daily_points = []

        for day_index, day in enumerate(dates):
            values = {}

            for variable in FLOOD_DAILY_VARIABLES:
                series = daily.get(variable) or []

                value = (
                    series[day_index]
                    if day_index < len(series)
                    else None
                )

                # Preserve missing values and normalize booleans/non-numeric
                # data to None instead of treating them as measurements.
                if (
                    value is not None
                    and (
                        isinstance(value, bool)
                        or not isinstance(value, (int, float))
                    )
                ):
                    value = None

                values[variable] = value

            daily_points.append({
                "date": day,
                "unit": "m³/s",
                **values,
            })

        valid_discharge_days = sum(
            1
            for point in daily_points
            if point.get("river_discharge") is not None
        )

        total_days = len(daily_points)
        missing_discharge_days = (
            total_days - valid_discharge_days
        )

        if valid_discharge_days == 0:
            data_status = "no_data"
        elif missing_discharge_days > 0:
            data_status = "partial_data"
        else:
            data_status = "available"

        data_coverage_percent = (
            round(
                valid_discharge_days / total_days * 100,
                1,
            )
            if total_days > 0
            else 0.0
        )

        results.append({
            "municipality": name,
            "requested_coordinates": coordinates,
            "model_coordinates": model_coordinates,
            "timezone": location_payload.get("timezone", "GMT"),
            "daily_units": location_payload.get("daily_units", {}),
            "daily": daily_points,
            "status": data_status,
            "valid_discharge_days": valid_discharge_days,
            "missing_discharge_days": missing_discharge_days,
            "data_coverage_percent": data_coverage_percent,
            "source": "Open-Meteo Flood API / GloFAS",
            "spatial_note": (
                "Discharge is for the model-selected river grid cell near "
                "this coordinate; verify river alignment before local interpretation."
            ),
        })

    available_count = sum(
        1 for item in results if item["status"] == "available"
    )
    partial_count = sum(
        1 for item in results if item["status"] == "partial_data"
    )
    no_data_count = sum(
        1 for item in results if item["status"] == "no_data"
    )

    return {
        "title": "Bataan river-discharge outlook",
        "generated_at": datetime.now(ZoneInfo("UTC")).isoformat(),
        "timezone": "GMT",
        "temporal_resolution": "daily",
        "forecast_days_requested": forecast_days,
        "discharge_unit": "m³/s",
        "variables": FLOOD_DAILY_VARIABLES,
        "source": "Open-Meteo Flood API / GloFAS",
        "municipality_count": len(results),
        "available_municipality_count": available_count,
        "partial_data_municipality_count": partial_count,
        "no_data_municipality_count": no_data_count,
        "municipalities": results,
        "limitations": [
            "GloFAS values are simulated daily river discharge, not observed river levels.",
            "A municipality coordinate may select a nearby river grid cell that is not the intended river.",
            "Discharge alone does not confirm flooding in a barangay or settlement.",
            "Daily values must not be interpolated and presented as hourly predictions.",
            "A no_data status means the primary river_discharge series is missing for the returned dates; it does not mean the river has zero flow.",
            "An available status indicates data coverage only; it does not confirm that the selected grid cell represents the municipality's intended river.",
        ],
    }
"""WritingBlock>
**After replacing and saving:**

1. Keep your backend server running; `--reload` should restart it automatically.
2. Open `http://127.0.0.1:8000/docs`.
3. Run `GET /weather/flood-outlook?forecast_days=7`.
4. Check `no_data_municipality_count`, `partial_data_municipality_count`, and `available_municipality_count`.

One caveat: the existing six-hour cache may return the previously cached API payload, but the new status calculations will still run against that payload. The four municipalities with all-null discharge should now report `no_data`."""