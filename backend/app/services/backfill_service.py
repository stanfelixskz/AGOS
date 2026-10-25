"""
AGOS — historical backfill (plan item 3)

Fills the SQLite database with past daily data so Analytics has years of
history instead of a few days:

  open_meteo_archive  daily rain/temperature/wind, ERA5 reanalysis (1940+, gridded model data)
  open_meteo_glofas   daily modeled river discharge, GloFAS (from 1984, modeled, not a gauge)

It reuses the existing ingest functions (same tables, same validation, same
logging), one request per municipality + source + calendar year.

Rules
- Newest years first, so an interrupted run still leaves the most useful years.
- Resumable: a chunk already logged as a success in `ingest_runs` for exactly the
  same point and dates is skipped. The current year is never "complete" (it ends
  a few days before today), so it is simply fetched again on the next run.
- Paced requests; a per-minute HTTP 429 waits and retries; an hourly or daily
  limit stops the run cleanly (progress is saved; run again later).
- Nothing is invented. A failed chunk is reported and left missing.
- These are gridded model values, not rain-gauge or river-gauge readings.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from datetime import date, timedelta
from typing import Any, Callable, Iterable, Mapping

logger = logging.getLogger(__name__)

SOURCES = ("open_meteo_archive", "open_meteo_glofas")
FIRST_YEAR = {"open_meteo_archive": 1940, "open_meteo_glofas": 1984}
LATEST_LAG_DAYS = 7  # the archive publishes recent days with a delay

# Rough weighted-call cost per one-year request, from the examples on Open-Meteo's
# pricing page (2 weeks x 15 variables = 1.5 calls). An ESTIMATE, not measured.
EST_CALLS = {"open_meteo_archive": 15.6, "open_meteo_glofas": 2.6}

Chunk = tuple[str, str, date, date]  # (municipality, source, start, end)


def year_chunks(from_year: int, latest: date) -> list[tuple[date, date]]:
    """Calendar-year (start, end) pairs, newest first; the last year ends at `latest`."""
    chunks = []
    for year in range(latest.year, from_year - 1, -1):
        start = date(year, 1, 1)
        end = min(date(year, 12, 31), latest)
        if end >= start:
            chunks.append((start, end))
    return chunks


def plan(
    municipalities: Mapping[str, Mapping[str, float]],
    sources: Iterable[str],
    from_year: int,
    today: date,
    done: set[tuple[str, float, float, str, str]],
) -> list[Chunk]:
    """Chunks still to do, newest year first. `done` comes from completed_runs()."""
    latest = today - timedelta(days=LATEST_LAG_DAYS)
    todo: list[Chunk] = []
    for start, end in year_chunks(from_year, latest):
        for source in sources:
            if start.year < FIRST_YEAR[source]:
                continue
            for name, point in municipalities.items():
                key = (source, round(point["latitude"], 4), round(point["longitude"], 4),
                       start.isoformat(), end.isoformat())
                if key not in done:
                    todo.append((name, source, start, end))
    return todo


def completed_runs(connection: sqlite3.Connection) -> set[tuple[str, float, float, str, str]]:
    try:
        rows = connection.execute(
            "SELECT source, latitude, longitude, start_date, end_date FROM ingest_runs "
            "WHERE status = 'success' AND records_received > 0"
        ).fetchall()
    except sqlite3.OperationalError:  # table not created yet
        return set()
    return {(r[0], round(r[1], 4), round(r[2], 4), r[3], r[4]) for r in rows}


def estimate(todo: list[Chunk], pause_s: float) -> dict[str, Any]:
    calls = sum(EST_CALLS[source] for _, source, _, _ in todo)
    return {
        "requests": len(todo),
        "estimated_weighted_calls": round(calls),
        "estimated_minutes": round(len(todo) * (pause_s + 2) / 60),
        "note": "Estimates. Free limits: 600 calls/min, 5,000/hour, 10,000/day, shared with the "
                "hourly collection and any terrain builds.",
    }


def classify_error(text: str) -> str:
    """'minute' (wait and retry), 'limit' (hourly/daily: stop), or 'other'."""
    low = text.lower()
    limited = "429" in low or "too many" in low or "limit" in low
    if not limited:
        return "other"
    if "hourly" in low or "daily" in low or "monthly" in low:
        return "limit"
    return "minute"


def _error_text(error: Exception) -> str:
    return str(getattr(error, "detail", None) or error)[:300]


def run_backfill(
    todo: list[Chunk],
    municipalities: Mapping[str, Mapping[str, float]],
    ingest: Mapping[str, Callable[..., dict]],
    pause_s: float = 8.0,
    minute_wait_s: float = 65.0,
    retries: int = 2,
    max_requests: int | None = None,
    sleep: Callable[[float], None] = time.sleep,
    progress: Callable[[str], None] = lambda message: None,
) -> dict[str, Any]:
    """Run the chunks in order. Returns a summary; never raises for a failed chunk."""
    summary: dict[str, Any] = {
        "planned": len(todo), "succeeded": 0, "failed": 0, "records_upserted": 0,
        "stopped": None, "errors": [],
    }
    done_count = 0
    for name, source, start, end in todo:
        if max_requests is not None and done_count >= max_requests:
            summary["stopped"] = f"reached --max-requests {max_requests}"
            break
        point = municipalities[name]
        label = f"{name} {source.replace('open_meteo_', '')} {start.year}"
        result = None
        for attempt in range(retries + 1):
            try:
                result = ingest[source](
                    latitude=point["latitude"], longitude=point["longitude"],
                    start_date=start, end_date=end,
                )
                break
            except Exception as error:  # noqa: BLE001
                text = _error_text(error)
                kind = classify_error(text)
                if kind == "limit":
                    summary["stopped"] = f"Open-Meteo limit reached ({text}). Run again later; progress is saved."
                    summary["errors"].append(f"{label}: {text}")
                    progress(f"STOP {label}: {text}")
                    return summary
                if kind == "minute" and attempt < retries:
                    progress(f"  rate limited, waiting {minute_wait_s:.0f}s")
                    sleep(minute_wait_s)
                    continue
                summary["failed"] += 1
                summary["errors"].append(f"{label}: {text}")
                progress(f"FAIL {label}: {text}")
                break
        done_count += 1
        if result is not None:
            summary["succeeded"] += 1
            summary["records_upserted"] += int(result.get("records_upserted", 0))
            progress(f"ok   {label} ({result.get('records_upserted', 0)} records) [{done_count}/{len(todo)}]")
        sleep(pause_s)
    return summary


def coverage(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    """What the database holds, per source and variable (read-only)."""
    try:
        rows = connection.execute(
            "SELECT source, variable, MIN(observed_at), MAX(observed_at), COUNT(*), "
            "COUNT(DISTINCT latitude || ',' || longitude) FROM observations "
            "GROUP BY source, variable ORDER BY source, variable"
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    return [
        {"source": r[0], "variable": r[1], "first": r[2], "last": r[3], "records": r[4], "points": r[5]}
        for r in rows
    ]
