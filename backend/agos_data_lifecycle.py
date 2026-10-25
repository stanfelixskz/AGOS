
"""
AGOS Data Lifecycle API
Historical weather and modeled river-discharge ingestion,
SQLite storage, daily analytics, and data-quality validation.

Important:
- Weather values are gridded historical estimates/reanalysis data.
- River discharge is modeled data, not a verified local gauge reading.
- Validation identifies completeness issues and suspicious values.
- Screening bounds are sanity checks, not official flood-warning thresholds.
- Existing data is preserved; validation never deletes or corrects observations.
"""

from __future__ import annotations

import json
import math
import os
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query


router = APIRouter(prefix="/data-lifecycle", tags=["AGOS Data Lifecycle"])

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("AGOS_DATA_DIR", str(BASE_DIR / "data")))
DB_PATH = DATA_DIR / "agos_analytics.sqlite3"

WEATHER_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FLOOD_API_URL = "https://flood-api.open-meteo.com/v1/flood"
PH_TIMEZONE = "Asia/Manila"

WEATHER_DAILY_VARIABLES = [
    "precipitation_sum",
    "rain_sum",
    "precipitation_hours",
    "temperature_2m_max",
    "temperature_2m_min",
    "wind_speed_10m_max",
]

FLOOD_DAILY_VARIABLES = ["river_discharge"]

# ERA5-only rain. The archive's default model ("best_match") is ERA5 up to 2016
# and ECMWF IFS (9 km) from 2017, so its rain record changes model in 2017.
# This source asks for ERA5 alone, giving one consistent rain record over all years
# (published with about 5 days of delay). Stored under its own source name.
ERA5_SOURCE = "open_meteo_era5"
ERA5_MODEL = "era5"
ERA5_DAILY_VARIABLES = ["precipitation_sum"]

UNITS = {
    "precipitation_sum": "mm",
    "rain_sum": "mm",
    "precipitation_hours": "hours",
    "temperature_2m_max": "°C",
    "temperature_2m_min": "°C",
    "wind_speed_10m_max": "km/h",
    "river_discharge": "m³/s",
}

# Broad initial sanity-check ranges.
# These are NOT official flood thresholds or proof that a value is accurate.
VALIDATION_RULES = {
    "precipitation_sum": {
        "source": "open_meteo_archive",
        "unit": "mm",
        "minimum": 0,
        "maximum": 1000,
    },
    "rain_sum": {
        "source": "open_meteo_archive",
        "unit": "mm",
        "minimum": 0,
        "maximum": 1000,
    },
    "precipitation_hours": {
        "source": "open_meteo_archive",
        "unit": "hours",
        "minimum": 0,
        "maximum": 24,
    },
    "temperature_2m_max": {
        "source": "open_meteo_archive",
        "unit": "°C",
        "minimum": -30,
        "maximum": 60,
    },
    "temperature_2m_min": {
        "source": "open_meteo_archive",
        "unit": "°C",
        "minimum": -30,
        "maximum": 60,
    },
    "wind_speed_10m_max": {
        "source": "open_meteo_archive",
        "unit": "km/h",
        "minimum": 0,
        "maximum": 400,
    },
    "river_discharge": {
        "source": "open_meteo_glofas",
        "unit": "m³/s",
        "minimum": 0,
        "maximum": 100000,
    },
}


# ---------------------------------------------------------------------
# DATABASE
# ---------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(str(DB_PATH), timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=15000")

    return connection


def _init_db() -> None:
    with _connect() as con:
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS observations (
                source TEXT NOT NULL,
                variable TEXT NOT NULL,
                observed_at TEXT NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                value REAL NOT NULL,
                unit TEXT NOT NULL,
                quality_flag TEXT NOT NULL DEFAULT 'valid',
                fetched_at TEXT NOT NULL,
                PRIMARY KEY (
                    source,
                    variable,
                    observed_at,
                    latitude,
                    longitude
                )
            )
            """
        )

        con.execute(
            """
            CREATE TABLE IF NOT EXISTS ingest_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                status TEXT NOT NULL,
                records_received INTEGER NOT NULL DEFAULT 0,
                records_stored INTEGER NOT NULL DEFAULT 0,
                message TEXT,
                fetched_at TEXT NOT NULL
            )
            """
        )

        con.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_observations_time
            ON observations(observed_at)
            """
        )

        con.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_observations_variable
            ON observations(variable, observed_at)
            """
        )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------
# INPUT VALIDATION
# ---------------------------------------------------------------------

def _validate_dates(start_date: date, end_date: date) -> None:
    if end_date < start_date:
        raise HTTPException(
            status_code=400,
            detail="end_date must be on or after start_date",
        )

    if (end_date - start_date).days > 365:
        raise HTTPException(
            status_code=400,
            detail=(
                "Request at most 366 calendar days per ingestion. "
                "Import longer histories in yearly batches."
            ),
        )

    if end_date > date.today():
        raise HTTPException(
            status_code=400,
            detail="Historical ingestion end_date cannot be in the future",
        )


def _validate_coordinates(
    latitude: float,
    longitude: float,
) -> tuple[float, float]:
    if not math.isfinite(latitude) or not -90 <= latitude <= 90:
        raise HTTPException(
            status_code=400,
            detail="latitude must be between -90 and 90",
        )

    if not math.isfinite(longitude) or not -180 <= longitude <= 180:
        raise HTTPException(
            status_code=400,
            detail="longitude must be between -180 and 180",
        )

    return round(latitude, 4), round(longitude, 4)


# ---------------------------------------------------------------------
# OPEN-METEO HTTP CLIENT
# ---------------------------------------------------------------------

def _fetch_json(
    base_url: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    url = f"{base_url}?{urllib.parse.urlencode(params)}"

    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "AGOS-DataLifecycle/1.0",
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            payload = response.read(12 * 1024 * 1024 + 1)

            if len(payload) > 12 * 1024 * 1024:
                raise HTTPException(
                    status_code=502,
                    detail="Upstream response exceeded 12 MB safety limit",
                )

            data = json.loads(payload.decode("utf-8"))

    except HTTPException:
        raise

    except urllib.error.HTTPError as exc:
        detail = exc.read(1200).decode("utf-8", errors="replace")

        raise HTTPException(
            status_code=502,
            detail=f"Open-Meteo returned HTTP {exc.code}: {detail}",
        ) from exc

    except (urllib.error.URLError, TimeoutError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach Open-Meteo: {exc}",
        ) from exc

    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=502,
            detail="Open-Meteo returned invalid JSON",
        ) from exc

    if not isinstance(data, dict):
        raise HTTPException(
            status_code=502,
            detail="Unexpected Open-Meteo response format",
        )

    if data.get("error"):
        raise HTTPException(
            status_code=502,
            detail=data.get("reason", "Open-Meteo query failed"),
        )

    return data


# ---------------------------------------------------------------------
# STORAGE AND NORMALIZATION
# ---------------------------------------------------------------------

def _store_daily(
    source: str,
    data: dict[str, Any],
    date_key: str,
    variables_key: str,
    latitude: float,
    longitude: float,
) -> tuple[int, int]:
    """
    Normalize daily values and upsert them into SQLite.

    The existing schema requires numeric values. Missing, non-numeric,
    infinite, and negative precipitation/discharge values are skipped.

    The 'valid' flag here means the value passed ingestion cleaning.
    It does not mean independent scientific verification.
    """
    daily = data.get(variables_key) or {}
    times = daily.get(date_key) or []

    if not isinstance(times, list):
        raise HTTPException(
            status_code=502,
            detail="Open-Meteo returned an invalid daily date array",
        )

    variables = {
        key: daily[key]
        for key in daily
        if key != date_key
    }

    received = 0
    cleaned: list[tuple[Any, ...]] = []
    fetched_at = _now()

    for index, day in enumerate(times):
        try:
            normalized_day = date.fromisoformat(str(day)).isoformat()
        except (TypeError, ValueError):
            continue

        for variable, values in variables.items():
            if not isinstance(values, list) or index >= len(values):
                continue

            value = values[index]
            received += 1

            if value is None or isinstance(value, bool):
                continue

            try:
                number = float(value)
            except (TypeError, ValueError, OverflowError):
                continue

            if not math.isfinite(number):
                continue

            if (
                variable in (
                    "precipitation_sum",
                    "rain_sum",
                    "precipitation_hours",
                    "river_discharge",
                )
                and number < 0
            ):
                continue

            cleaned.append(
                (
                    source,
                    variable,
                    normalized_day,
                    latitude,
                    longitude,
                    number,
                    UNITS.get(variable, "unknown"),
                    "valid",
                    fetched_at,
                )
            )

    with _connect() as con:
        con.executemany(
            """
            INSERT INTO observations (
                source,
                variable,
                observed_at,
                latitude,
                longitude,
                value,
                unit,
                quality_flag,
                fetched_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (
                source,
                variable,
                observed_at,
                latitude,
                longitude
            )
            DO UPDATE SET
                value = excluded.value,
                unit = excluded.unit,
                quality_flag = excluded.quality_flag,
                fetched_at = excluded.fetched_at
            """,
            cleaned,
        )

    return received, len(cleaned)


def _log_run(
    source: str,
    latitude: float,
    longitude: float,
    start_date: date,
    end_date: date,
    status: str,
    received: int = 0,
    stored: int = 0,
    message: str | None = None,
) -> None:
    with _connect() as con:
        con.execute(
            """
            INSERT INTO ingest_runs (
                source,
                latitude,
                longitude,
                start_date,
                end_date,
                status,
                records_received,
                records_stored,
                message,
                fetched_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source,
                latitude,
                longitude,
                start_date.isoformat(),
                end_date.isoformat(),
                status,
                received,
                stored,
                message,
                _now(),
            ),
        )


# ---------------------------------------------------------------------
# HEALTH
# ---------------------------------------------------------------------

@router.get("/health")
def lifecycle_health() -> dict[str, Any]:
    """Check the local pipeline and report database statistics."""
    _init_db()

    with _connect() as con:
        obs_count = con.execute(
            "SELECT COUNT(*) FROM observations"
        ).fetchone()[0]

        run_count = con.execute(
            "SELECT COUNT(*) FROM ingest_runs"
        ).fetchone()[0]

        sources = [
            dict(row)
            for row in con.execute(
                """
                SELECT source, COUNT(*) AS records
                FROM observations
                GROUP BY source
                ORDER BY source
                """
            ).fetchall()
        ]

    size_bytes = DB_PATH.stat().st_size if DB_PATH.exists() else 0

    return {
        "status": "ok",
        "database": str(DB_PATH),
        "database_size_bytes": size_bytes,
        "observation_records": obs_count,
        "ingestion_runs": run_count,
        "records_by_source": sources,
    }


# ---------------------------------------------------------------------
# HISTORICAL WEATHER INGESTION
# ---------------------------------------------------------------------

def _ingest_archive(
    latitude: float,
    longitude: float,
    start_date: date,
    end_date: date,
    source: str,
    variables: list[str],
    model: str | None = None,
) -> dict[str, Any]:
    """Fetch daily archive values and upsert them under `source` (shared by both archive sources)."""
    _validate_dates(start_date, end_date)
    lat, lon = _validate_coordinates(latitude, longitude)
    _init_db()

    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "daily": ",".join(variables),
        "timezone": PH_TIMEZONE,
        "wind_speed_unit": "kmh",
        "precipitation_unit": "mm",
    }
    if model:
        params["models"] = model

    try:
        data = _fetch_json(WEATHER_ARCHIVE_URL, params)

        received, stored = _store_daily(
            source,
            data,
            "time",
            "daily",
            lat,
            lon,
        )

        _log_run(
            source,
            lat,
            lon,
            start_date,
            end_date,
            "success",
            received,
            stored,
        )

    except HTTPException as exc:
        _log_run(
            source,
            lat,
            lon,
            start_date,
            end_date,
            "error",
            message=str(exc.detail),
        )
        raise

    return {
        "status": "success",
        "source": (
            "Open-Meteo Historical Weather API "
            + (f"(model {model}, reanalysis)" if model else "(default best_match: ERA5 to 2016, ECMWF IFS from 2017)")
        ),
        "location": {
            "latitude": lat,
            "longitude": lon,
            "timezone": PH_TIMEZONE,
        },
        "period": {
            "start": start_date.isoformat(),
            "end": end_date.isoformat(),
        },
        "records_received": received,
        "records_upserted": stored,
        "database": str(DB_PATH),
        "note": (
            "These are gridded historical weather estimates, "
            "not local rain-gauge observations."
        ),
    }


@router.post("/ingest/weather")
def ingest_historical_weather(
    latitude: float = Query(14.6760, ge=-90, le=90),
    longitude: float = Query(120.5363, ge=-180, le=180),
    start_date: date = Query(
        ...,
        description="YYYY-MM-DD; up to 366 days per request",
    ),
    end_date: date = Query(
        ...,
        description="YYYY-MM-DD; historical date",
    ),
) -> dict[str, Any]:
    """Fetch historical weather (default model) and upsert records into SQLite."""
    return _ingest_archive(
        latitude, longitude, start_date, end_date,
        "open_meteo_archive", WEATHER_DAILY_VARIABLES,
    )


@router.post("/ingest/era5-rain")
def ingest_era5_rain(
    latitude: float = Query(14.6760, ge=-90, le=90),
    longitude: float = Query(120.5363, ge=-180, le=180),
    start_date: date = Query(
        ...,
        description="YYYY-MM-DD; up to 366 days per request",
    ),
    end_date: date = Query(
        ...,
        description="YYYY-MM-DD; historical date (ERA5 lags about 5 days)",
    ),
) -> dict[str, Any]:
    """Fetch ERA5-only daily rain (one model for all years) and upsert it as open_meteo_era5."""
    return _ingest_archive(
        latitude, longitude, start_date, end_date,
        ERA5_SOURCE, ERA5_DAILY_VARIABLES, ERA5_MODEL,
    )


# ---------------------------------------------------------------------
# MODELED RIVER-DISCHARGE INGESTION
# ---------------------------------------------------------------------

@router.post("/ingest/river-discharge")
def ingest_river_discharge(
    latitude: float = Query(14.6760, ge=-90, le=90),
    longitude: float = Query(120.5363, ge=-180, le=180),
    start_date: date = Query(
        ...,
        description="YYYY-MM-DD; up to 366 days per request",
    ),
    end_date: date = Query(
        ...,
        description="YYYY-MM-DD; historical date",
    ),
) -> dict[str, Any]:
    """Fetch modeled daily river discharge from the Open-Meteo Flood API."""
    _validate_dates(start_date, end_date)
    lat, lon = _validate_coordinates(latitude, longitude)
    _init_db()

    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "daily": ",".join(FLOOD_DAILY_VARIABLES),
        "timezone": "GMT",
        "cell_selection": "nearest",
    }

    try:
        data = _fetch_json(FLOOD_API_URL, params)

        received, stored = _store_daily(
            "open_meteo_glofas",
            data,
            "time",
            "daily",
            lat,
            lon,
        )

        _log_run(
            "open_meteo_glofas",
            lat,
            lon,
            start_date,
            end_date,
            "success",
            received,
            stored,
        )

    except HTTPException as exc:
        _log_run(
            "open_meteo_glofas",
            lat,
            lon,
            start_date,
            end_date,
            "error",
            message=str(exc.detail),
        )
        raise

    return {
        "status": "success",
        "source": "Open-Meteo Flood API / GloFAS modeled river discharge",
        "location": {
            "requested_latitude": lat,
            "requested_longitude": lon,
            "returned_latitude": data.get("latitude"),
            "returned_longitude": data.get("longitude"),
            "timezone": data.get("timezone", "GMT"),
        },
        "period": {
            "start": start_date.isoformat(),
            "end": end_date.isoformat(),
        },
        "records_received": received,
        "records_upserted": stored,
        "database": str(DB_PATH),
        "warning": (
            "The nearest modeled grid cell may not represent the "
            "intended local river. These values are not verified "
            "gauge readings or confirmed flood events."
        ),
    }


# ---------------------------------------------------------------------
# DAILY ANALYTICS
# ---------------------------------------------------------------------

@router.get("/analytics/daily")
def daily_analytics(
    latitude: float = Query(14.6760, ge=-90, le=90),
    longitude: float = Query(120.5363, ge=-180, le=180),
    start_date: date = Query(...),
    end_date: date = Query(...),
) -> dict[str, Any]:
    """Return chart-ready daily observations for one grid location."""
    _validate_dates(start_date, end_date)
    lat, lon = _validate_coordinates(latitude, longitude)
    _init_db()

    with _connect() as con:
        rows = con.execute(
            """
            SELECT
                source,
                variable,
                observed_at,
                value,
                unit,
                quality_flag,
                fetched_at
            FROM observations
            WHERE latitude = ?
              AND longitude = ?
              AND observed_at BETWEEN ? AND ?
            ORDER BY observed_at ASC, source ASC, variable ASC
            """,
            (
                lat,
                lon,
                start_date.isoformat(),
                end_date.isoformat(),
            ),
        ).fetchall()

    daily: dict[str, dict[str, Any]] = {}

    for row in rows:
        day = row["observed_at"]

        daily.setdefault(
            day,
            {
                "date": day,
                "values": {},
            },
        )

        daily[day]["values"][row["variable"]] = {
            "value": row["value"],
            "unit": row["unit"],
            "source": row["source"],
            "quality_flag": row["quality_flag"],
        }

    records = list(daily.values())

    rain_values = [
        item["values"]["precipitation_sum"]["value"]
        for item in records
        if "precipitation_sum" in item["values"]
    ]

    discharge_values = [
        item["values"]["river_discharge"]["value"]
        for item in records
        if "river_discharge" in item["values"]
    ]

    rainfall_points = [
        {
            "date": item["date"],
            "value": item["values"]["precipitation_sum"]["value"],
        }
        for item in records
        if "precipitation_sum" in item["values"]
    ]

    discharge_points = [
        {
            "date": item["date"],
            "value": item["values"]["river_discharge"]["value"],
        }
        for item in records
        if "river_discharge" in item["values"]
    ]

    max_rainfall_point = (
        max(rainfall_points, key=lambda point: point["value"])
        if rainfall_points
        else None
    )

    max_discharge_point = (
        max(discharge_points, key=lambda point: point["value"])
        if discharge_points
        else None
    )

    return {
        "status": "ok",
        "location": {
            "latitude": lat,
            "longitude": lon,
        },
        "period": {
            "start": start_date.isoformat(),
            "end": end_date.isoformat(),
        },
        "record_days": len(records),
        "charts": {
            "rainfall": {
                "label": "Daily precipitation",
                "unit": "mm",
                "points": rainfall_points,
                "total_mm": (
                    round(sum(rain_values), 2)
                    if rain_values
                    else None
                ),
                "max_daily_mm": (
                    max(rain_values)
                    if rain_values
                    else None
                ),
                "max_daily_date": (
                    max_rainfall_point["date"]
                    if max_rainfall_point
                    else None
                ),
            },
            "river_discharge": {
                "label": "Modeled daily river discharge",
                "unit": "m³/s",
                "points": discharge_points,
                "max_m3_s": (
                    max(discharge_values)
                    if discharge_values
                    else None
                ),
                "max_date": (
                    max_discharge_point["date"]
                    if max_discharge_point
                    else None
                ),
            },
        },
        "records": records,
        "note": (
            "Charts are based only on records already ingested "
            "for this exact coordinate and date range."
        ),
        "data_limitations": [
            "Precipitation totals refer to this grid location, not an entire municipality or catchment.",
            "River discharge is modeled and is not a verified local gauge reading.",
        ],
    }


# ---------------------------------------------------------------------
# DATA QUALITY VALIDATION
# ---------------------------------------------------------------------

@router.get("/validation/daily")
def validate_daily_data(
    latitude: float = Query(14.6760, ge=-90, le=90),
    longitude: float = Query(120.5363, ge=-180, le=180),
    start_date: date = Query(...),
    end_date: date = Query(...),
) -> dict[str, Any]:
    """
    Check expected daily coverage, units, source identifiers,
    stored duplicate keys, existing flags, and broad value bounds.

    Does not modify or delete observations.
    """
    _validate_dates(start_date, end_date)
    lat, lon = _validate_coordinates(latitude, longitude)
    _init_db()

    expected_dates = [
        (start_date + timedelta(days=offset)).isoformat()
        for offset in range((end_date - start_date).days + 1)
    ]

    expected_date_set = set(expected_dates)

    with _connect() as con:
        rows = con.execute(
            """
            SELECT
                source,
                variable,
                observed_at,
                latitude,
                longitude,
                value,
                unit,
                quality_flag,
                fetched_at
            FROM observations
            WHERE latitude = ?
              AND longitude = ?
              AND observed_at BETWEEN ? AND ?
            ORDER BY observed_at, source, variable
            """,
            (
                lat,
                lon,
                start_date.isoformat(),
                end_date.isoformat(),
            ),
        ).fetchall()

        duplicate_rows = con.execute(
            """
            SELECT
                source,
                variable,
                observed_at,
                latitude,
                longitude,
                COUNT(*) AS occurrences
            FROM observations
            WHERE latitude = ?
              AND longitude = ?
              AND observed_at BETWEEN ? AND ?
            GROUP BY
                source,
                variable,
                observed_at,
                latitude,
                longitude
            HAVING COUNT(*) > 1
            """,
            (
                lat,
                lon,
                start_date.isoformat(),
                end_date.isoformat(),
            ),
        ).fetchall()

    observed_dates: dict[str, set[str]] = {
        variable: set()
        for variable in VALIDATION_RULES
    }

    variable_counts = {
        variable: 0
        for variable in VALIDATION_RULES
    }

    out_of_range_counts = {
        variable: 0
        for variable in VALIDATION_RULES
    }

    wrong_unit_counts = {
        variable: 0
        for variable in VALIDATION_RULES
    }

    issues: list[dict[str, Any]] = []
    non_valid_flags = 0

    for row in rows:
        source = row["source"]
        variable = row["variable"]
        day = row["observed_at"]
        value = row["value"]
        unit = row["unit"]
        quality_flag = row["quality_flag"]

        if variable not in VALIDATION_RULES:
            issues.append(
                {
                    "type": "unexpected_variable",
                    "date": day,
                    "variable": variable,
                    "source": source,
                    "message": (
                        "Variable is not in the configured "
                        "daily validation list."
                    ),
                }
            )
            continue

        rule = VALIDATION_RULES[variable]

        if source != rule["source"]:
            issues.append(
                {
                    "type": "unexpected_source",
                    "date": day,
                    "variable": variable,
                    "actual_source": source,
                    "expected_source": rule["source"],
                    "message": (
                        "Variable is stored under an unexpected source."
                    ),
                }
            )
            continue

        variable_counts[variable] += 1
        observed_dates[variable].add(day)

        if unit != rule["unit"]:
            wrong_unit_counts[variable] += 1
            issues.append(
                {
                    "type": "unit_mismatch",
                    "date": day,
                    "variable": variable,
                    "actual_unit": unit,
                    "expected_unit": rule["unit"],
                }
            )

        if quality_flag != "valid":
            non_valid_flags += 1
            issues.append(
                {
                    "type": "existing_quality_flag",
                    "date": day,
                    "variable": variable,
                    "quality_flag": quality_flag,
                }
            )

        if not math.isfinite(value):
            out_of_range_counts[variable] += 1
            issues.append(
                {
                    "type": "non_finite_value",
                    "date": day,
                    "variable": variable,
                    "value": value,
                }
            )
            continue

        if value < rule["minimum"] or value > rule["maximum"]:
            out_of_range_counts[variable] += 1
            issues.append(
                {
                    "type": "value_outside_screening_bounds",
                    "date": day,
                    "variable": variable,
                    "value": value,
                    "unit": unit,
                    "screening_minimum": rule["minimum"],
                    "screening_maximum": rule["maximum"],
                    "message": (
                        "Review this value. Screening bounds are "
                        "not official thresholds and do not prove "
                        "the value is wrong."
                    ),
                }
            )

    variable_report: dict[str, Any] = {}
    total_expected = 0
    total_present = 0

    for variable, rule in VALIDATION_RULES.items():
        present_dates = observed_dates[variable]
        missing_dates = sorted(expected_date_set - present_dates)

        expected_count = len(expected_dates)
        present_count = len(present_dates)

        total_expected += expected_count
        total_present += present_count

        variable_report[variable] = {
            "source": rule["source"],
            "expected_unit": rule["unit"],
            "expected_days": expected_count,
            "days_present": present_count,
            "days_missing": len(missing_dates),
            "missing_dates": missing_dates,
            "records_found": variable_counts[variable],
            "unit_mismatches": wrong_unit_counts[variable],
            "values_outside_screening_bounds": (
                out_of_range_counts[variable]
            ),
            "screening_bounds": {
                "minimum": rule["minimum"],
                "maximum": rule["maximum"],
            },
        }

    completeness_pct = (
        round(total_present / total_expected * 100, 2)
        if total_expected
        else 100.0
    )

    duplicate_count = len(duplicate_rows)
    missing_count = sum(
        item["days_missing"]
        for item in variable_report.values()
    )

    issue_count = len(issues)
    review_count = issue_count + duplicate_count

    if missing_count or review_count:
        result = "review_required"
    else:
        result = "passed_basic_checks"

    return {
        "status": "ok",
        "validation_scope": {
            "latitude": lat,
            "longitude": lon,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "expected_calendar_days": len(expected_dates),
            "variables_checked": len(VALIDATION_RULES),
        },
        "summary": {
            "expected_observations": total_expected,
            "observations_present": total_present,
            "missing_variable_days": missing_count,
            "completeness_percent": completeness_pct,
            "duplicate_stored_keys": duplicate_count,
            "unit_mismatches": sum(wrong_unit_counts.values()),
            "values_outside_screening_bounds": sum(
                out_of_range_counts.values()
            ),
            "non_valid_existing_quality_flags": non_valid_flags,
            "issues_for_review": review_count,
            "result": result,
        },
        "variables": variable_report,
        "issues": issues,
        "duplicate_records": [
            dict(row)
            for row in duplicate_rows
        ],
        "limitations": [
            (
                "Completeness means a value is stored for the expected "
                "date and variable; it does not prove source accuracy."
            ),
            (
                "Screening bounds are broad sanity checks, not official "
                "meteorological or flood-warning thresholds."
            ),
            (
                "The database primary key prevents duplicate stored keys. "
                "Duplicate incoming dates may not be detectable after upsert."
            ),
            (
                "Modeled river discharge is not a verified local gauge "
                "reading or proof of a flood event."
            ),
            (
                "This endpoint does not independently verify upstream "
                "data or correct suspicious values."
            ),
        ],
    }


# ---------------------------------------------------------------------
# INGESTION HISTORY
# ---------------------------------------------------------------------

@router.get("/ingestion-runs")
def ingestion_runs(
    limit: int = Query(20, ge=1, le=100),
) -> dict[str, Any]:
    """Show recent successful and failed ingestion attempts."""
    _init_db()

    with _connect() as con:
        rows = con.execute(
            """
            SELECT *
            FROM ingest_runs
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return {
        "runs": [
            dict(row)
            for row in rows
        ]
    }


# Initialize the database when this module is imported.
_init_db()
