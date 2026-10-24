"""
AGOS — forecast snapshot storage (pipeline step: store forecasts as issued)

Every snapshot saves what the forecast model said at one moment, for every
Bataan municipality, together with WHEN it said it (issued_at). Keeping past
forecasts is what later allows forecast accuracy to be measured: a stored
forecast can be compared with the rainfall that actually fell.

Rules
- Raw model output only. Values are never corrected, smoothed or invented.
- A missing value is stored as NULL with quality_flag 'missing', never as 0.
- An out-of-range value is KEPT and flagged 'suspect', never deleted.
- Only hours from the snapshot hour onward are stored (no past hours).
- Re-running within the same hour replaces that hour's snapshot (idempotent).
- Open-Meteo values are model forecasts, not gauge readings.
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

SOURCE = "open_meteo_forecast"
PH_TZ = ZoneInfo("Asia/Manila")
FORECAST_DAYS = 3

# variable -> (unit, minimum, maximum). Ranges are sanity checks only,
# NOT official thresholds; values outside are flagged 'suspect', kept as-is.
VARIABLES: dict[str, tuple[str, float, float]] = {
    "precipitation": ("mm", 0, 300),
    "rain": ("mm", 0, 300),
    "precipitation_probability": ("%", 0, 100),
    "temperature_2m": ("°C", -10, 50),
    "relative_humidity_2m": ("%", 0, 100),
    "wind_speed_10m": ("km/h", 0, 300),
    "soil_moisture_0_to_10cm": ("m³/m³", 0, 1),
}

SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS forecast_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        municipality TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        requested_latitude REAL NOT NULL,
        requested_longitude REAL NOT NULL,
        model_latitude REAL,
        model_longitude REAL,
        values_stored INTEGER NOT NULL DEFAULT 0,
        UNIQUE (source, municipality, issued_at)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS forecast_values (
        run_id INTEGER NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
        valid_at TEXT NOT NULL,
        variable TEXT NOT NULL,
        value REAL,
        unit TEXT NOT NULL,
        quality_flag TEXT NOT NULL,
        PRIMARY KEY (run_id, valid_at, variable)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_forecast_values_valid ON forecast_values(valid_at, variable)",
    "CREATE INDEX IF NOT EXISTS idx_forecast_runs_issued ON forecast_runs(issued_at)",
)


def init_tables(connection: sqlite3.Connection) -> None:
    for statement in SCHEMA:
        connection.execute(statement)


def clean_value(variable: str, raw: Any) -> tuple[float | None, str]:
    """Return (value, quality_flag). Never turns missing into 0."""
    if raw is None or isinstance(raw, bool):
        return None, "missing"

    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None, "missing"

    if value != value or value in (float("inf"), float("-inf")):
        return None, "missing"

    _unit, minimum, maximum = VARIABLES[variable]
    flag = "valid" if minimum <= value <= maximum else "suspect"

    return value, flag


def _issued_hour(now: datetime) -> datetime:
    return now.astimezone(PH_TZ).replace(minute=0, second=0, microsecond=0)


def _valid_time(stamp: str) -> datetime:
    parsed = datetime.fromisoformat(stamp)

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=PH_TZ)

    return parsed.astimezone(PH_TZ)


def store_municipality_forecast(
    connection: sqlite3.Connection,
    municipality: str,
    point: Mapping[str, float],
    payload: Mapping[str, Any],
    issued_at: datetime,
    fetched_at: datetime,
) -> int:
    """Store one municipality's hourly forecast. Returns values stored."""
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []

    if not times:
        raise RuntimeError(f"No hourly forecast returned for {municipality}")

    issued_iso = issued_at.isoformat(timespec="seconds")

    # Replace an earlier snapshot of the same hour (SQLite foreign keys are
    # off by default, so delete the child rows explicitly).
    same_hour = (
        "SELECT id FROM forecast_runs WHERE source = ? AND municipality = ? "
        "AND issued_at = ?"
    )
    connection.execute(
        f"DELETE FROM forecast_values WHERE run_id IN ({same_hour})",
        (SOURCE, municipality, issued_iso),
    )
    connection.execute(
        "DELETE FROM forecast_runs WHERE source = ? AND municipality = ? "
        "AND issued_at = ?",
        (SOURCE, municipality, issued_iso),
    )
    cursor = connection.execute(
        """
        INSERT INTO forecast_runs (
            source, municipality, issued_at, fetched_at,
            requested_latitude, requested_longitude,
            model_latitude, model_longitude
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            SOURCE,
            municipality,
            issued_iso,
            fetched_at.isoformat(timespec="seconds"),
            point["latitude"],
            point["longitude"],
            payload.get("latitude"),
            payload.get("longitude"),
        ),
    )
    run_id = cursor.lastrowid

    rows = []

    for index, stamp in enumerate(times):
        valid = _valid_time(stamp)

        if valid < issued_at:
            continue

        for variable, (unit, _min, _max) in VARIABLES.items():
            series = hourly.get(variable)

            if series is None:
                continue  # variable not returned: store nothing, invent nothing

            raw = series[index] if index < len(series) else None
            value, flag = clean_value(variable, raw)
            rows.append(
                (
                    run_id,
                    valid.isoformat(timespec="seconds"),
                    variable,
                    value,
                    unit,
                    flag,
                )
            )

    connection.executemany(
        "INSERT INTO forecast_values (run_id, valid_at, variable, value, "
        "unit, quality_flag) VALUES (?, ?, ?, ?, ?, ?)",
        rows,
    )
    connection.execute(
        "UPDATE forecast_runs SET values_stored = ? WHERE id = ?",
        (len(rows), run_id),
    )

    return len(rows)


def _default_fetch(names: list[str]) -> list[dict]:
    # Imported lazily so this module can be tested without network helpers.
    from app.services.weather_service import _multi_location_forecast_payload

    return _multi_location_forecast_payload(
        list(VARIABLES), forecast_days=FORECAST_DAYS
    )


def _default_connect() -> sqlite3.Connection:
    # Lazy import: agos_data_lifecycle needs FastAPI.
    from agos_data_lifecycle import _connect

    return _connect()


def run_forecast_snapshot(
    municipalities: Mapping[str, Mapping[str, float]] | None = None,
    fetch: Callable[[list[str]], list[dict]] | None = None,
    connect: Callable[[], sqlite3.Connection] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """
    Fetch the hourly forecast for all municipalities and store it.
    One failing municipality never stops the others; failures are reported.
    """
    if municipalities is None:
        from app.data.municipalities import MUNICIPALITIES

        municipalities = MUNICIPALITIES

    fetch = fetch or _default_fetch
    connect = connect or _default_connect
    fetched_at = now or datetime.now(timezone.utc)
    issued_at = _issued_hour(fetched_at)
    names = list(municipalities.keys())

    summary: dict[str, Any] = {
        "issued_at": issued_at.isoformat(timespec="seconds"),
        "municipalities": len(names),
        "stored": 0,
        "values_stored": 0,
        "errors": [],
    }

    try:
        payloads = fetch(names)

        if len(payloads) != len(names):
            raise RuntimeError(
                f"Expected {len(names)} forecasts, received {len(payloads)}"
            )
    except Exception as error:  # noqa: BLE001 - report, never crash the cycle
        summary["errors"].append({"municipality": "*", "error": str(error)})
        return summary

    connection = connect()

    try:
        init_tables(connection)

        for name, payload in zip(names, payloads):
            try:
                with connection:  # one transaction per municipality
                    summary["values_stored"] += store_municipality_forecast(
                        connection,
                        name,
                        municipalities[name],
                        payload,
                        issued_at,
                        fetched_at,
                    )
                summary["stored"] += 1
            except Exception as error:  # noqa: BLE001
                logger.warning("Forecast snapshot failed for %s: %s", name, error)
                summary["errors"].append(
                    {"municipality": name, "error": str(error)}
                )
    finally:
        connection.close()

    return summary


def forecast_store_summary(
    connect: Callable[[], sqlite3.Connection] | None = None,
) -> dict[str, Any]:
    """Counts and time range of stored forecasts (for /system/status)."""
    connection = (connect or _default_connect)()

    try:
        init_tables(connection)
        row = connection.execute(
            "SELECT COUNT(*) AS runs, MIN(issued_at) AS first_issued, "
            "MAX(issued_at) AS last_issued FROM forecast_runs"
        ).fetchone()
        values = connection.execute(
            "SELECT COUNT(*) AS n, "
            "SUM(CASE WHEN quality_flag = 'suspect' THEN 1 ELSE 0 END) AS suspect, "
            "SUM(CASE WHEN quality_flag = 'missing' THEN 1 ELSE 0 END) AS missing "
            "FROM forecast_values"
        ).fetchone()
    finally:
        connection.close()

    return {
        "runs": row["runs"],
        "first_issued_at": row["first_issued"],
        "last_issued_at": row["last_issued"],
        "values": values["n"],
        "suspect_values": values["suspect"] or 0,
        "missing_values": values["missing"] or 0,
    }
