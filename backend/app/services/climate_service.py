"""
AGOS — rainfall climate statistics per municipality (plan item 4)

Built only from daily rain already stored in the AGOS database (Open-Meteo
archive, ERA5 reanalysis at one reference point per town). Standard library only.

What it computes, per town
- yearly: total rain, rain days, heavy-rain days, wettest day, wettest 3-day total
- monthly: average rain per calendar month over the full years
- trend: straight-line change in yearly total, with a plain "can we tell?" flag
- return levels: how much daily rain to expect once every N years, from a Gumbel
  fit to each full year's wettest day, with a 90% bootstrap range

Honest limits (also returned to the interface)
- Only years with (almost) every day present count as "full". The current year
  is partial and is shown but never used in the statistics.
- A short record (about 11 years) gives WIDE ranges. Return levels beyond about
  twice the record length are not given.
- ERA5 daily values are smoothed over a ~25 km grid cell, so they tend to be lower
  than rain-gauge extremes. These numbers describe the reanalysis, not the gauge.
- These are statistics of the past, not a forecast and not a flood probability.
"""

from __future__ import annotations

import math
import random
import sqlite3
import time
from datetime import date, datetime, timedelta
from typing import Any, Callable, Mapping
from zoneinfo import ZoneInfo

PH_TZ = ZoneInfo("Asia/Manila")
TOLERANCE_DEG = 0.0002
FULL_YEAR_MIN_DAYS = 360          # of 365/366 days present
MIN_YEARS_FOR_RETURN_LEVELS = 10
RETURN_PERIODS = (2, 5, 10, 20)
EXCEEDANCE_MM = (50, 100, 150)
RAIN_DAY_MM = 1.0
HEAVY_MM = (10, 50, 100)          # AGOS display thresholds for a day's total; not PAGASA categories
BOOTSTRAP = 500
EULER_GAMMA = 0.5772156649015329
CACHE_SECONDS = 600


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

ARCHIVE_SOURCE = "open_meteo_archive"
ERA5_SOURCE = "open_meteo_era5"
# The ERA5-only record is used once it holds at least this share of the default record's
# rain days, so a half-finished backfill never replaces a complete record.
ERA5_READY_SHARE = 0.9

RAIN_LABELS = {
    ERA5_SOURCE: "Open-Meteo Historical Weather API, ERA5 reanalysis only (one model for all years, about 25 km; modeled, not a rain gauge)",
    ARCHIVE_SOURCE: "Open-Meteo Historical Weather API, default model: ERA5 (about 25 km) up to 2016 and ECMWF IFS (9 km) from 2017 (modeled, not a rain gauge)",
}


def _rain_count(connection: sqlite3.Connection, source: str) -> int:
    return connection.execute(
        "SELECT COUNT(*) FROM observations WHERE variable = 'precipitation_sum' AND source = ?", (source,)
    ).fetchone()[0]


def rain_record(connection: sqlite3.Connection) -> dict[str, Any]:
    """Which stored rain record the statistics use, and whether it is one model throughout."""
    era5 = _rain_count(connection, ERA5_SOURCE)
    archive = _rain_count(connection, ARCHIVE_SOURCE)
    use_era5 = era5 > 0 and era5 >= ERA5_READY_SHARE * archive
    source = ERA5_SOURCE if use_era5 else ARCHIVE_SOURCE
    return {
        "source": source,
        "consistent": use_era5,
        "label": RAIN_LABELS[source],
        "era5_records": era5,
        "archive_records": archive,
        "note": None if use_era5 else (
            "Mixed record: the default archive model changes from ERA5 to ECMWF IFS in 2017, "
            "so ranks, return levels and trends mix two models. Load ERA5-only rain "
            "(backfill --sources era5) to fix this."
        ),
    }


def load_daily_rain(connection: sqlite3.Connection, point: Mapping[str, float], source: str = ARCHIVE_SOURCE) -> dict[str, float]:
    """date (YYYY-MM-DD) -> mm. Suspect values and missing days are left out, never zero."""
    rows = connection.execute(
        "SELECT observed_at, value FROM observations "
        "WHERE variable = 'precipitation_sum' AND source = ? "
        "AND quality_flag = 'valid' "
        "AND ABS(latitude - ?) < ? AND ABS(longitude - ?) < ?",
        (source, point["latitude"], TOLERANCE_DEG, point["longitude"], TOLERANCE_DEG),
    ).fetchall()
    return {str(r[0])[:10]: float(r[1]) for r in rows}


# --------------------------------------------------------------------------
# Yearly and monthly statistics
# --------------------------------------------------------------------------

def yearly_stats(daily: Mapping[str, float]) -> list[dict[str, Any]]:
    by_year: dict[int, dict[str, float]] = {}
    for day, mm in daily.items():
        by_year.setdefault(int(day[:4]), {})[day] = mm

    years = []
    for year in sorted(by_year):
        days = by_year[year]
        wet_day, wet_mm = max(days.items(), key=lambda kv: kv[1])
        best3: tuple[str, float] | None = None
        for day in days:
            d0 = date.fromisoformat(day)
            window = [(d0 + timedelta(days=i)).isoformat() for i in range(3)]
            if all(w in days for w in window):
                total = sum(days[w] for w in window)
                if best3 is None or total > best3[1]:
                    best3 = (day, total)
        years.append({
            "year": year,
            "days_with_data": len(days),
            "complete": len(days) >= FULL_YEAR_MIN_DAYS,
            "total_mm": round(sum(days.values()), 1),
            "rain_days": sum(1 for v in days.values() if v >= RAIN_DAY_MM),
            "heavy_days": {str(t): sum(1 for v in days.values() if v >= t) for t in HEAVY_MM},
            "wettest_day": {"date": wet_day, "mm": round(wet_mm, 1)},
            "wettest_3day": best3 and {"start": best3[0], "mm": round(best3[1], 1)},
        })
    return years


def monthly_climate(daily: Mapping[str, float], full_years: list[int]) -> list[dict[str, Any]]:
    """Average per calendar month over full years only."""
    if not full_years:
        return []
    # group the days by (year, month) once, keeping their order (sums stay identical)
    groups: dict[str, list[float]] = {}
    for d, v in daily.items():
        groups.setdefault(d[:7], []).append(v)
    out = []
    for month in range(1, 13):
        totals, rain_days, heavy = [], [], []
        for year in full_years:
            values = groups.get(f"{year}-{month:02d}", [])
            totals.append(sum(values))
            rain_days.append(sum(1 for v in values if v >= RAIN_DAY_MM))
            heavy.append(sum(1 for v in values if v >= HEAVY_MM[0]))
        n = len(full_years)
        out.append({
            "month": month,
            "mean_total_mm": round(sum(totals) / n, 1),
            "mean_rain_days": round(sum(rain_days) / n, 1),
            "mean_days_10mm": round(sum(heavy) / n, 1),
        })
    average = sum(m["mean_total_mm"] for m in out) / 12
    for m in out:
        m["above_average"] = m["mean_total_mm"] > average
    return out


def trend(totals_by_year: Mapping[int, float]) -> dict[str, Any]:
    """Least-squares slope of yearly rain (mm per year) and whether it stands out from noise."""
    years = sorted(totals_by_year)
    n = len(years)
    if n < 5:
        return {"status": "insufficient_data", "years": n}
    xs = [float(y) for y in years]
    ys = [totals_by_year[y] for y in years]
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    residual = sum((y - (my + slope * (x - mx))) ** 2 for x, y in zip(xs, ys))
    se = math.sqrt(residual / (n - 2) / sxx) if n > 2 else float("inf")
    return {
        "status": "ok",
        "years": n,
        "slope_mm_per_year": round(slope, 1),
        "std_error": round(se, 1),
        "distinguishable_from_zero": bool(abs(slope) > 2 * se),
    }


# --------------------------------------------------------------------------
# Gumbel return levels
# --------------------------------------------------------------------------

def fit_gumbel(maxima: list[float]) -> tuple[float, float]:
    """Method of moments -> (location mu, scale beta)."""
    n = len(maxima)
    mean = sum(maxima) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in maxima) / (n - 1))
    beta = max(sd * math.sqrt(6) / math.pi, 1e-9)
    return mean - EULER_GAMMA * beta, beta


def return_level(mu: float, beta: float, years: float) -> float:
    """Daily rain (mm) expected to be reached or beaten about once every `years` years."""
    return mu - beta * math.log(-math.log(1 - 1 / years))


def annual_exceedance(mu: float, beta: float, mm: float) -> float:
    """Chance, in any one year, that the wettest day reaches `mm` or more."""
    return 1 - math.exp(-math.exp(-(mm - mu) / beta))


def _percentiles(values: list[float], low: float = 5, high: float = 95) -> tuple[float, float]:
    ordered = sorted(values)

    def at(p: float) -> float:
        k = (len(ordered) - 1) * p / 100
        lo, hi = math.floor(k), math.ceil(k)
        return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)

    return at(low), at(high)


def return_levels(annual_maxima: list[float], seed: int = 20261025) -> dict[str, Any]:
    n = len(annual_maxima)
    if n < MIN_YEARS_FOR_RETURN_LEVELS:
        return {"status": "insufficient_data", "n_years": n, "needed": MIN_YEARS_FOR_RETURN_LEVELS}
    if max(annual_maxima) - min(annual_maxima) < 1e-6:
        return {"status": "no_variation", "n_years": n}
    mu, beta = fit_gumbel(annual_maxima)
    periods = [t for t in RETURN_PERIODS if t <= 2 * n]
    rng = random.Random(seed)
    boot_levels: dict[int, list[float]] = {t: [] for t in periods}
    boot_prob: dict[int, list[float]] = {mm: [] for mm in EXCEEDANCE_MM}
    for _ in range(BOOTSTRAP):
        sample = [rng.choice(annual_maxima) for _ in range(n)]
        if max(sample) - min(sample) < 1e-6:
            continue
        bmu, bbeta = fit_gumbel(sample)
        for t in periods:
            boot_levels[t].append(return_level(bmu, bbeta, t))
        for mm in EXCEEDANCE_MM:
            boot_prob[mm].append(annual_exceedance(bmu, bbeta, mm))
    if not boot_levels[periods[0]]:
        return {"status": "no_variation", "n_years": n}
    levels = []
    for t in periods:
        low, high = _percentiles(boot_levels[t])
        levels.append({"years": t, "mm": round(return_level(mu, beta, t), 1), "low": round(low, 1), "high": round(high, 1)})
    exceed = []
    for mm in EXCEEDANCE_MM:
        low, high = _percentiles(boot_prob[mm])
        exceed.append({"mm": mm, "probability": round(annual_exceedance(mu, beta, mm), 3), "low": round(low, 3), "high": round(high, 3)})
    return {
        "status": "ok",
        "n_years": n,
        "method": "Gumbel (method of moments) fitted to each full year's wettest day; range = 5th to 95th percentile of 500 bootstrap refits",
        "levels": levels,
        "exceedance": exceed,
        "fit": {"location": round(mu, 2), "scale": round(beta, 2)},
        "observed_max_mm": round(max(annual_maxima), 1),
    }


# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------

def town_report(name: str, point: Mapping[str, float], daily: Mapping[str, float]) -> dict[str, Any]:
    years = yearly_stats(daily)
    full = [y for y in years if y["complete"]]
    full_years = [y["year"] for y in full]
    return {
        "name": name,
        "point": dict(point),
        "years": years,
        "full_years": len(full),
        "monthly": monthly_climate(daily, full_years),
        "trend": trend({y["year"]: y["total_mm"] for y in full}),
        "return_levels": return_levels([y["wettest_day"]["mm"] for y in full]),
    }


def climate(connection: sqlite3.Connection, municipalities: Mapping[str, Mapping[str, float]]) -> dict[str, Any]:
    record = rain_record(connection)
    towns = [town_report(name, point, load_daily_rain(connection, point, record["source"])) for name, point in municipalities.items()]
    firsts = [t["years"][0]["year"] for t in towns if t["years"]]
    lasts = [t["years"][-1]["year"] for t in towns if t["years"]]
    return {
        "any_data": bool(firsts),
        "first_year": min(firsts) if firsts else None,
        "last_year": max(lasts) if lasts else None,
        "towns": towns,
        "thresholds": {"rain_day_mm": RAIN_DAY_MM, "heavy_day_mm": list(HEAVY_MM), "full_year_min_days": FULL_YEAR_MIN_DAYS},
        "rain_record": record,
        "sources": {"rain": record["label"]},
        "notes": [
            "Only full years (at least 360 days of data) are used in trends, monthly averages and return levels. The current year is partial and shown only for reference.",
            "A short record gives wide ranges. Return levels are shown only up to twice the number of years available.",
            "ERA5 daily values are smoothed over a grid cell of about 25 km, so they usually sit below rain-gauge extremes."
            if record["consistent"] else record["note"],
            "These are statistics of the past at one reference point per town. They are not a forecast and not a flood probability.",
            "The 10, 50 and 100 mm day thresholds are AGOS display thresholds, not PAGASA categories.",
        ],
    }


_cache: dict[str, Any] = {"at": 0.0, "key": None, "value": None}


def climate_report(
    municipalities: Mapping[str, Mapping[str, float]] | None = None,
    connect: Callable[[], sqlite3.Connection] | None = None,
    now: Callable[[], float] = time.time,
) -> dict[str, Any]:
    if municipalities is None:
        from app.data.municipalities import MUNICIPALITIES

        municipalities = MUNICIPALITIES
    if connect is None:
        from agos_data_lifecycle import _connect as connect, _init_db

        _init_db()
    key = datetime.now(PH_TZ).date().isoformat()
    if _cache["value"] is not None and _cache["key"] == key and now() - _cache["at"] < CACHE_SECONDS:
        return _cache["value"]
    connection = connect()
    try:
        value = climate(connection, municipalities)
    finally:
        connection.close()
    _cache.update(at=now(), key=key, value=value)
    return value
