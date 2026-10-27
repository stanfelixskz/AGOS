"""
AGOS — how often spells of unusual rain ended in a listed flood (past frequency, with ranges).

This is NOT a forecast and NOT the chance of flooding today. It counts what happened before:
  * A rain day is a day on which some town's 3-day rain (ending that day) is in the top 5% of
    that town's own stored record (the Watch level of the warning sign).
  * Rain days at most 2 days apart are merged into one spell, so one storm counts once.
  * A spell's level is its highest percentile: watch (95+), warning (98+), high_warning (99+).
    Each row counts spells "at this level or higher", the way the sign's levels are meant.
  * A spell "ended in a flood" if a listed flood (dated, a town flooded) began from 1 day before
    the spell started to 2 days after it ended.
  * Only spells from 2011 on are used: the flood list is much thinner before.
Each rate comes with a 95% range (Wilson) and a confidence label that only reflects how many
past spells there are and how wide the range is. Confidence is never "high": the flood list
misses small floods (so every rate is a lower bound) and the rain is modeled, not gauged.

Storm distance and spring tide are left out on purpose: tested on the same floods
(tools/check_storms.py, tools/check_storm_adds_to_rain.py, tide_service) they did not help.
Same method as tools/check_storm_adds_to_rain.py. Province-wide: a spell counts when at least one
town reached the level, so a single town's own chance is not computed (too few cases).
"""

from __future__ import annotations

import math
from bisect import bisect_left
from datetime import date, timedelta
from typing import Any, Mapping, Sequence

from app.services import flood_watch_service as fw

FROM_DATE = date(2011, 1, 1)
RAISED_PERCENTILE = fw.LEVELS[-1][1]  # the Watch level (95)
MERGE_GAP_DAYS = 2
FLOOD_BEFORE = 1
FLOOD_AFTER = 2
MIN_SPELLS = 10  # below this no rate is shown
MEDIUM_SPELLS = 30
MEDIUM_MAX_WIDTH = 0.30
LEVEL_ORDER = ("watch", "warning", "high_warning")  # least to most unusual
MIN_PERCENTILE = {name: minimum for name, minimum in fw.LEVELS}
SOURCE = ("AGOS count from the stored ERA5 rain record (modeled, not a rain gauge) and the AGOS flood list "
          "(news and official reports; small floods are missing)")


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - m) / d, (c + m) / d)


def rolling3(daily: Mapping[str, float | None]) -> dict[str, float]:
    """End date -> 3-day total, only where all three days are present."""
    out: dict[str, float] = {}
    for day in daily:
        end = date.fromisoformat(day)
        window = [(end - timedelta(days=k)).isoformat() for k in (2, 1, 0)]
        values = [daily.get(d) for d in window]
        if all(v is not None for v in values):
            out[day] = float(sum(values))
    return out


def raised_days(towns: Mapping[str, tuple[Mapping[str, float], Sequence[float]]], threshold: float = RAISED_PERCENTILE) -> dict[date, float]:
    """{day: highest percentile among towns} on days when some town's 3-day rain is at or above `threshold`."""
    out: dict[date, float] = {}
    for rain3, sorted3 in towns.values():
        if not sorted3:
            continue
        for day, value in rain3.items():
            p = 100.0 * bisect_left(sorted3, value) / len(sorted3)
            if p >= threshold:
                d = date.fromisoformat(day)
                if p > out.get(d, 0.0):
                    out[d] = p
    return out


def spells(days: Mapping[date, float], gap: int = MERGE_GAP_DAYS) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for d in sorted(days):
        if out and (d - out[-1]["end"]).days <= gap + 1:
            out[-1]["end"] = d
            out[-1]["peak"] = max(out[-1]["peak"], days[d])
        else:
            out.append({"start": d, "end": d, "peak": days[d]})
    return out


def flood_start_days(events: Sequence[Mapping[str, Any]]) -> list[date]:
    """Start days of listed floods that have a stated or inferred date and at least one flooded town."""
    out = set()
    for e in events:
        if not e.get("start_date") or e.get("date_basis") == "article_date":
            continue
        if not any(t.get("evidence") == "flooded" for t in e.get("towns", [])):
            continue
        out.add(date.fromisoformat(e["start_date"]))
    return sorted(out)


def ended_in_flood(spell: Mapping[str, Any], floods: Sequence[date]) -> bool:
    low, high = spell["start"] - timedelta(days=FLOOD_BEFORE), spell["end"] + timedelta(days=FLOOD_AFTER)
    return any(low <= f <= high for f in floods)


def confidence(n: int, k: int) -> tuple[str, list[str]]:
    """('none' | 'low' | 'medium', reason codes). Never 'high': see the module note."""
    reasons = ["list_incomplete", "modeled_rain"]
    if n < MIN_SPELLS:
        return "none", ["few_spells"] + reasons
    low, high = wilson(k, n)
    if n >= MEDIUM_SPELLS and (high - low) <= MEDIUM_MAX_WIDTH:
        return "medium", reasons
    if n < MEDIUM_SPELLS:
        reasons = ["few_spells"] + reasons
    if (high - low) > MEDIUM_MAX_WIDTH:
        reasons = ["wide_range"] + reasons
    return "low", reasons


def level_rows(spell_list: Sequence[Mapping[str, Any]], floods: Sequence[date]) -> list[dict[str, Any]]:
    """One row per sign level: spells that reached that level or higher, and how many ended in a flood."""
    flagged = [(s["peak"], ended_in_flood(s, floods)) for s in spell_list]
    rows = []
    for level in LEVEL_ORDER:
        minimum = MIN_PERCENTILE[level]
        n = sum(1 for peak, _ in flagged if peak >= minimum)
        k = sum(1 for peak, flood in flagged if peak >= minimum and flood)
        label, reasons = confidence(n, k)
        low, high = wilson(k, n)
        rows.append({
            "level": level, "spells": n, "floods": k,
            "rate": round(k / n, 3) if label != "none" else None,
            "range_95": [round(low, 3), round(high, 3)] if label != "none" else None,
            "confidence": label, "reasons": reasons,
        })
    return rows


def chance_from_records(records: Mapping[str, Any], events: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    """The table for the whole province, from the stored rain record and the flood list; None without a record."""
    towns = {}
    last = None
    for name, rec in records.get("towns", {}).items():
        daily = rec.get("daily") or {}
        rain3 = rolling3(daily)
        if rain3:
            towns[name] = (rain3, sorted(rain3.values()))
            top = max(rain3)
            last = top if last is None or top > last else last
    if not towns or last is None:
        return None
    end_limit = date.fromisoformat(last) - timedelta(days=FLOOD_AFTER)  # a flood may still be coming for later spells
    all_spells = [s for s in spells(raised_days(towns)) if s["start"] >= FROM_DATE and s["end"] <= end_limit]
    floods = [f for f in flood_start_days(events) if f >= FROM_DATE]
    return {
        "from": FROM_DATE.isoformat(),
        "to": end_limit.isoformat(),
        "spells_total": len(all_spells),
        "floods_used": len(floods),
        "levels": level_rows(all_spells, floods),
        "source": SOURCE,
        "rain_record": (records.get("record") or {}).get("label"),
        "not_a_forecast": True,
    }


def for_level(chance: Mapping[str, Any] | None, level: str) -> dict[str, Any] | None:
    """The row of the table for one sign level, or None for ordinary / no data."""
    if not chance:
        return None
    return next((dict(r) for r in chance["levels"] if r["level"] == level), None)
