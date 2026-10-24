"""
AGOS — forecast skill and bias (how good is the Open-Meteo rain forecast
for Bataan?)

Compares STORED day-ahead forecasts (forecast_values) with the rainfall that
was actually estimated for the same day (observations, Open-Meteo archive
reanalysis at the same point).

Honesty rules
- "Observed" is Open-Meteo archive reanalysis, not a rain gauge. Say so.
- A day is used only if the forecast covers all 24 hours of that day.
- The day-ahead forecast is the latest snapshot issued before that day began.
- The raw forecast is never replaced. A bias-adjusted value is offered only
  when enough rainy days exist (MIN_RAIN_DAYS); otherwise it says why not.
- Rain/no-rain uses a threshold in mm per day (default 1 mm). Thresholds are
  AGOS choices, not PAGASA categories.
"""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo

PH_TZ = ZoneInfo("Asia/Manila")
RAIN_THRESHOLD_MM = 1.0
MIN_DAYS = 14
MIN_RAIN_DAYS = 10
POINT_TOLERANCE_DEG = 0.01


def daily_forecast_totals(
    connection: sqlite3.Connection,
    municipality: str,
    start: date,
    end: date,
) -> dict[date, dict[str, Any]]:
    """
    Day-ahead forecast total (mm) per local day in [start, end].
    Skips days where the chosen snapshot lacks any of the 24 hourly values.
    """
    result: dict[date, dict[str, Any]] = {}

    for offset in range((end - start).days + 1):
        day = start + timedelta(days=offset)
        day_start = datetime(day.year, day.month, day.day, tzinfo=PH_TZ)

        run = connection.execute(
            "SELECT id, issued_at FROM forecast_runs WHERE municipality = ? "
            "AND issued_at <= ? ORDER BY issued_at DESC LIMIT 1",
            (municipality, day_start.isoformat(timespec="seconds")),
        ).fetchone()

        if run is None:
            continue

        first = day_start.isoformat(timespec="seconds")
        last = (day_start + timedelta(hours=23)).isoformat(timespec="seconds")
        values = connection.execute(
            "SELECT value FROM forecast_values WHERE run_id = ? "
            "AND variable = 'precipitation' AND valid_at >= ? AND valid_at <= ?",
            (run["id"], first, last),
        ).fetchall()

        if len(values) != 24 or any(row["value"] is None for row in values):
            continue

        result[day] = {
            "forecast_mm": sum(row["value"] for row in values),
            "issued_at": run["issued_at"],
        }

    return result


def daily_observed_totals(
    connection: sqlite3.Connection,
    point: Mapping[str, float],
    start: date,
    end: date,
) -> dict[date, float]:
    rows = connection.execute(
        "SELECT observed_at, value FROM observations "
        "WHERE source = 'open_meteo_archive' AND variable = 'precipitation_sum' "
        "AND observed_at >= ? AND observed_at <= ? "
        "AND ABS(latitude - ?) < ? AND ABS(longitude - ?) < ?",
        (
            start.isoformat(),
            end.isoformat(),
            point["latitude"],
            POINT_TOLERANCE_DEG,
            point["longitude"],
            POINT_TOLERANCE_DEG,
        ),
    ).fetchall()

    return {date.fromisoformat(row["observed_at"][:10]): row["value"] for row in rows}


def score_pairs(
    pairs: list[tuple[float, float]],
    threshold_mm: float = RAIN_THRESHOLD_MM,
) -> dict[str, Any]:
    """pairs = [(forecast_mm, observed_mm)]. Pure function, easy to test."""
    n = len(pairs)

    if n == 0:
        return {"days": 0, "status": "no_data"}

    hits = sum(1 for f, o in pairs if f >= threshold_mm and o >= threshold_mm)
    misses = sum(1 for f, o in pairs if f < threshold_mm and o >= threshold_mm)
    false_alarms = sum(1 for f, o in pairs if f >= threshold_mm and o < threshold_mm)
    correct_negatives = n - hits - misses - false_alarms
    rain_days = hits + misses
    forecast_total = sum(f for f, _ in pairs)
    observed_total = sum(o for _, o in pairs)

    score: dict[str, Any] = {
        "days": n,
        "rain_days_observed": rain_days,
        "rain_threshold_mm": threshold_mm,
        "hits": hits,
        "misses": misses,
        "false_alarms": false_alarms,
        "correct_negatives": correct_negatives,
        "rain_no_rain_correct_percent": round(100 * (hits + correct_negatives) / n, 1),
        "rain_detected_percent": (
            round(100 * hits / rain_days, 1) if rain_days else None
        ),
        "mean_absolute_error_mm": round(sum(abs(f - o) for f, o in pairs) / n, 2),
        "mean_error_mm": round((forecast_total - observed_total) / n, 2),
        "forecast_total_mm": round(forecast_total, 1),
        "observed_total_mm": round(observed_total, 1),
        "bias_ratio": (
            round(forecast_total / observed_total, 3) if observed_total > 0 else None
        ),
    }

    if n < MIN_DAYS or rain_days < MIN_RAIN_DAYS or score["bias_ratio"] is None:
        score["status"] = "insufficient_data"
        score["adjustment_factor"] = None
        score["note"] = (
            f"Need at least {MIN_DAYS} compared days with {MIN_RAIN_DAYS} rainy "
            "days before a bias adjustment is offered."
        )
    else:
        score["status"] = "ok"
        # Multiply a raw forecast by this to remove the average over/under-forecast.
        score["adjustment_factor"] = round(1 / score["bias_ratio"], 3)
        score["note"] = (
            "Average bias only; it does not fix timing errors or single heavy events."
        )

    return score


def municipality_skill(
    connection: sqlite3.Connection,
    municipality: str,
    point: Mapping[str, float],
    start: date,
    end: date,
    threshold_mm: float = RAIN_THRESHOLD_MM,
) -> dict[str, Any]:
    forecasts = daily_forecast_totals(connection, municipality, start, end)
    observed = daily_observed_totals(connection, point, start, end)
    pairs = [
        (forecasts[day]["forecast_mm"], observed[day])
        for day in sorted(forecasts)
        if day in observed
    ]
    result = score_pairs(pairs, threshold_mm)
    result["municipality"] = municipality
    result["period"] = {"start": start.isoformat(), "end": end.isoformat()}

    return result


def skill_report(
    days: int = 30,
    municipalities: Mapping[str, Mapping[str, float]] | None = None,
    connect: Callable[[], sqlite3.Connection] | None = None,
    today: date | None = None,
) -> dict[str, Any]:
    if municipalities is None:
        from app.data.municipalities import MUNICIPALITIES

        municipalities = MUNICIPALITIES

    if connect is None:
        from agos_data_lifecycle import _connect as connect  # lazy: needs FastAPI

    today = today or datetime.now(PH_TZ).date()
    end = today - timedelta(days=1)
    start = end - timedelta(days=days - 1)

    from app.services.forecast_store import init_tables

    connection = connect()

    try:
        init_tables(connection)
        rows = [
            municipality_skill(connection, name, point, start, end)
            for name, point in municipalities.items()
        ]
    finally:
        connection.close()

    return {
        "title": "Open-Meteo rain forecast vs observed, Bataan",
        "period": {"start": start.isoformat(), "end": end.isoformat()},
        "forecast_definition": (
            "Day-ahead: the latest AGOS-stored snapshot issued before the day began, "
            "summed over the 24 hours of that day."
        ),
        "observed_definition": (
            "Open-Meteo archive reanalysis daily rainfall at the municipality point "
            "(modeled, not a rain gauge)."
        ),
        "municipalities": rows,
    }
