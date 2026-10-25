"""
AGOS — daily history per municipality from the AGOS SQLite database.

Reads only what the scheduler has already ingested (Open-Meteo archive
rainfall and GloFAS discharge at each municipality point). Days that were
never ingested are reported as missing, not as zero rain.
"""

from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo

PH_TZ = ZoneInfo("Asia/Manila")
TOLERANCE_DEG = 0.0002  # points are stored rounded to 4 decimals


def history(
    connection: sqlite3.Connection,
    municipalities: Mapping[str, Mapping[str, float]],
    start: date,
    end: date,
) -> dict[str, Any]:
    days = [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]
    towns = []

    for name, point in municipalities.items():
        rows = connection.execute(
            "SELECT observed_at, variable, value, quality_flag FROM observations "
            "WHERE variable IN ('precipitation_sum', 'river_discharge') "
            "AND observed_at >= ? AND observed_at <= ? "
            "AND ABS(latitude - ?) < ? AND ABS(longitude - ?) < ?",
            (start.isoformat(), end.isoformat(), point["latitude"], TOLERANCE_DEG,
             point["longitude"], TOLERANCE_DEG),
        ).fetchall()

        by_day: dict[str, dict[str, Any]] = {}
        for row in rows:
            day = str(row["observed_at"])[:10]
            by_day.setdefault(day, {})[row["variable"]] = row["value"]

        daily = [
            {
                "date": day,
                "precipitation_mm": by_day.get(day, {}).get("precipitation_sum"),
                "river_discharge_m3s": by_day.get(day, {}).get("river_discharge"),
            }
            for day in days
        ]
        rain = [d for d in daily if d["precipitation_mm"] is not None]
        flow = [d for d in daily if d["river_discharge_m3s"] is not None]
        wettest = max(rain, key=lambda d: d["precipitation_mm"]) if rain else None
        highest_flow = max(flow, key=lambda d: d["river_discharge_m3s"]) if flow else None

        towns.append({
            "name": name,
            "point": dict(point),
            "daily": daily,
            "rain_days_with_data": len(rain),
            "flow_days_with_data": len(flow),
            "total_rain_mm": round(sum(d["precipitation_mm"] for d in rain), 1) if rain else None,
            "wettest_day": wettest and {"date": wettest["date"], "precipitation_mm": wettest["precipitation_mm"]},
            "highest_flow_day": highest_flow and {"date": highest_flow["date"], "river_discharge_m3s": highest_flow["river_discharge_m3s"]},
            "days_with_10mm_or_more": sum(1 for d in rain if d["precipitation_mm"] >= 10),
        })

    return {
        "period": {"start": start.isoformat(), "end": end.isoformat(), "days": len(days)},
        "towns": towns,
        "any_data": any(t["rain_days_with_data"] or t["flow_days_with_data"] for t in towns),
        "sources": {
            "rain": "Open-Meteo Historical Weather API (reanalysis, modeled; not a rain gauge)",
            "flow": "Open-Meteo Flood API / GloFAS (simulated daily discharge)",
        },
        "notes": [
            "Only days already collected by the AGOS scheduler appear. Missing days are null, not zero.",
            "Each value is for one reference point per municipality, not the whole town.",
        ],
    }


def history_report(
    days: int = 30,
    municipalities: Mapping[str, Mapping[str, float]] | None = None,
    connect: Callable[[], sqlite3.Connection] | None = None,
    today: date | None = None,
) -> dict[str, Any]:
    if municipalities is None:
        from app.data.municipalities import MUNICIPALITIES

        municipalities = MUNICIPALITIES

    if connect is None:
        from agos_data_lifecycle import _connect as connect, _init_db

        _init_db()

    today = today or datetime.now(PH_TZ).date()
    end = today - timedelta(days=1)
    start = end - timedelta(days=days - 1)
    connection = connect()

    try:
        connection.row_factory = sqlite3.Row
        return history(connection, municipalities, start, end)
    finally:
        connection.close()
