"""
AGOS — scheduled data ingestion

Keeps the SQLite analytics database fresh by periodically calling the
existing data-lifecycle ingestion functions for every Bataan municipality:

- Open-Meteo Historical Weather API (reanalysis / model data)
- Open-Meteo Flood API (GloFAS modeled river discharge)

Design notes
- OFF by default. Enable with AGOS_SCHEDULER_ENABLED=true in backend/.env.
- Uses one background thread (no extra dependencies). Run the API with a
  single worker (one uvicorn process) so only one scheduler is active.
- Each cycle re-ingests the last few days. Upserts are idempotent, and
  the archive API publishes recent days with a delay, so re-ingesting
  fills values that were missing on an earlier run.
- A failure for one municipality or source never stops the others.
  Failures are recorded, never hidden. No data is invented.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo

# Importing settings loads backend/.env so AGOS_* variables are available.
import app.config.settings  # noqa: F401
from app.data.municipalities import MUNICIPALITIES

logger = logging.getLogger(__name__)

PH_TIMEZONE = ZoneInfo("Asia/Manila")

DEFAULT_INTERVAL_HOURS = 6.0
MIN_INTERVAL_HOURS = 1.0
DEFAULT_LOOKBACK_DAYS = 7
MAX_LOOKBACK_DAYS = 30
PAUSE_BETWEEN_REQUESTS_SECONDS = 1.0

IngestFunction = Callable[..., dict]


# ---------------------------------------------------------------------
# SETTINGS
# ---------------------------------------------------------------------

def _parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default

    return value.strip().lower() in {"1", "true", "yes", "on"}


def _parse_number(
    value: str | None,
    default: float,
    minimum: float,
    maximum: float,
) -> float:
    if value is None or not value.strip():
        return default

    try:
        number = float(value)
    except ValueError:
        logger.warning("Ignoring invalid scheduler setting %r", value)
        return default

    return max(minimum, min(maximum, number))


def load_settings(env: Mapping[str, str] | None = None) -> dict[str, Any]:
    """Read scheduler settings from environment variables."""
    env = os.environ if env is None else env

    return {
        "enabled": _parse_bool(env.get("AGOS_SCHEDULER_ENABLED")),
        "interval_hours": _parse_number(
            env.get("AGOS_INGEST_INTERVAL_HOURS"),
            DEFAULT_INTERVAL_HOURS,
            MIN_INTERVAL_HOURS,
            24 * 7,
        ),
        "lookback_days": int(
            _parse_number(
                env.get("AGOS_INGEST_LOOKBACK_DAYS"),
                DEFAULT_LOOKBACK_DAYS,
                1,
                MAX_LOOKBACK_DAYS,
            )
        ),
        "forecast_snapshot": _parse_bool(
            env.get("AGOS_FORECAST_SNAPSHOT"), default=True
        ),
    }


# ---------------------------------------------------------------------
# ONE INGESTION CYCLE
# ---------------------------------------------------------------------

def _default_ingest_functions() -> tuple[IngestFunction, IngestFunction]:
    # Imported lazily so this module can be tested without FastAPI.
    from agos_data_lifecycle import (
        ingest_historical_weather,
        ingest_river_discharge,
    )

    return ingest_historical_weather, ingest_river_discharge


def _error_text(error: Exception) -> str:
    # fastapi.HTTPException carries the useful message in .detail
    return str(getattr(error, "detail", None) or error)


def ingestion_period(
    lookback_days: int,
    today: date | None = None,
) -> tuple[date, date]:
    """
    Return (start, end) for a cycle. End is yesterday in Philippine time,
    which can never be in the future for the data-lifecycle validation.
    """
    today = today or datetime.now(PH_TIMEZONE).date()
    end = today - timedelta(days=1)
    start = end - timedelta(days=lookback_days - 1)

    return start, end


def run_ingestion_cycle(
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    municipalities: Mapping[str, Mapping[str, float]] | None = None,
    ingest_weather: IngestFunction | None = None,
    ingest_discharge: IngestFunction | None = None,
    today: date | None = None,
    pause_seconds: float = PAUSE_BETWEEN_REQUESTS_SECONDS,
    sleep: Callable[[float], None] = time.sleep,
    should_stop: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    """Ingest the recent period for every municipality and both sources."""
    municipalities = MUNICIPALITIES if municipalities is None else municipalities

    if ingest_weather is None or ingest_discharge is None:
        default_weather, default_discharge = _default_ingest_functions()
        ingest_weather = ingest_weather or default_weather
        ingest_discharge = ingest_discharge or default_discharge

    start, end = ingestion_period(lookback_days, today)

    sources = (
        ("open_meteo_archive", ingest_weather),
        ("open_meteo_glofas", ingest_discharge),
    )

    results: list[dict[str, Any]] = []

    for name, point in municipalities.items():
        for source, ingest in sources:
            if should_stop():
                return _summarize(start, end, results, stopped_early=True)

            entry: dict[str, Any] = {
                "municipality": name,
                "source": source,
            }

            try:
                response = ingest(
                    latitude=point["latitude"],
                    longitude=point["longitude"],
                    start_date=start,
                    end_date=end,
                )
                entry["status"] = "success"
                entry["records_upserted"] = response.get("records_upserted", 0)

            except Exception as error:  # noqa: BLE001 - keep the cycle going
                entry["status"] = "error"
                entry["error"] = _error_text(error)
                logger.warning(
                    "Ingestion failed for %s (%s): %s",
                    name,
                    source,
                    entry["error"],
                )

            results.append(entry)
            sleep(pause_seconds)

    return _summarize(start, end, results)


def _summarize(
    start: date,
    end: date,
    results: list[dict[str, Any]],
    stopped_early: bool = False,
) -> dict[str, Any]:
    failed = [item for item in results if item["status"] == "error"]

    return {
        "period": {"start": start.isoformat(), "end": end.isoformat()},
        "attempted": len(results),
        "succeeded": len(results) - len(failed),
        "failed": len(failed),
        "stopped_early": stopped_early,
        "records_upserted": sum(
            item.get("records_upserted", 0) for item in results
        ),
        "errors": failed,
    }


# ---------------------------------------------------------------------
# BACKGROUND SCHEDULER
# ---------------------------------------------------------------------

def _utc_iso(moment: datetime | None = None) -> str:
    return (moment or datetime.now(timezone.utc)).isoformat(timespec="seconds")


class IngestionScheduler:
    """Runs ingestion cycles in a daemon thread at a fixed interval."""

    def __init__(
        self,
        enabled: bool = False,
        interval_hours: float = DEFAULT_INTERVAL_HOURS,
        lookback_days: int = DEFAULT_LOOKBACK_DAYS,
        cycle: Callable[..., dict] = run_ingestion_cycle,
        snapshot: Callable[[], dict] | None = None,
    ) -> None:
        self._snapshot = snapshot
        self.enabled = enabled
        self.interval_seconds = interval_hours * 3600
        self.lookback_days = lookback_days
        self._cycle = cycle

        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._state: dict[str, Any] = {
            "enabled": enabled,
            "running": False,
            "interval_hours": interval_hours,
            "lookback_days": lookback_days,
            "cycle_in_progress": False,
            "last_started_at": None,
            "last_finished_at": None,
            "last_summary": None,
            "forecast_snapshot_enabled": snapshot is not None,
            "last_forecast_snapshot": None,
            "next_run_at": None,
        }

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None):
        settings = load_settings(env)

        snapshot = None

        if settings["forecast_snapshot"]:
            from app.services.forecast_store import run_forecast_snapshot

            snapshot = run_forecast_snapshot

        return cls(
            enabled=settings["enabled"],
            interval_hours=settings["interval_hours"],
            lookback_days=settings["lookback_days"],
            snapshot=snapshot,
        )

    def status(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._state)

    def start(self) -> bool:
        """Start the background thread. Returns False when disabled."""
        if not self.enabled:
            return False

        if self._thread is not None and self._thread.is_alive():
            return True

        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop,
            name="agos-ingestion-scheduler",
            daemon=True,
        )
        self._set(running=True)
        self._thread.start()

        return True

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()

        if self._thread is not None:
            self._thread.join(timeout=timeout)

        self._set(running=False, next_run_at=None)

    def _set(self, **values: Any) -> None:
        with self._lock:
            self._state.update(values)

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._set(cycle_in_progress=True, last_started_at=_utc_iso())

            try:
                summary = self._cycle(
                    lookback_days=self.lookback_days,
                    should_stop=self._stop.is_set,
                )
            except Exception as error:  # noqa: BLE001 - never kill the thread
                logger.exception("Ingestion cycle crashed")
                summary = {"crashed": True, "error": _error_text(error)}

            if self._snapshot is not None and not self._stop.is_set():
                try:
                    snapshot_summary = self._snapshot()
                except Exception as error:  # noqa: BLE001
                    logger.exception("Forecast snapshot crashed")
                    snapshot_summary = {
                        "crashed": True,
                        "error": _error_text(error),
                    }
                self._set(last_forecast_snapshot=snapshot_summary)

            next_run = datetime.now(timezone.utc) + timedelta(
                seconds=self.interval_seconds
            )
            self._set(
                cycle_in_progress=False,
                last_finished_at=_utc_iso(),
                last_summary=summary,
                next_run_at=_utc_iso(next_run),
            )

            self._stop.wait(self.interval_seconds)


# Single shared instance used by the API (see app/main.py).
scheduler = IngestionScheduler.from_env()
