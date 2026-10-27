"""
AGOS — spring tide from the moon, for the flood-factors panel.

Needs no tide data: spring tides (the biggest tide range) follow the new and full moon, whose
phase can be computed for any date. This is NOT a tide height or a high-tide time; AGOS has no
tide gauge or official tide table yet. The result is context only and is not part of the warning
sign, because the link between spring tide and the listed Bataan floods is weak and not proven
(see listed_flood_check, which is recalculated from the flood list each time).

Moon phase is the mean synodic phase (reference new moon 2000-01-06 18:14 UTC, month
29.530588853 days); it can be off by about half a day, small beside the 2-day window.
Actual spring tides come 1 to 2 days after new/full moon, so the window is centred on the moon
and widened rather than shifted. Same method as tools/check_spring_tide.py.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone
from typing import Any, Mapping, Sequence

SYNODIC = 29.530588853
NEW_MOON_2000 = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
WINDOW_DAYS = 2.0
SOURCE = "Moon phase computed by AGOS (mean synodic month); not a tide gauge or tide table"


def phase_days(day: date) -> float:
    """Days since the last mean new moon at noon UTC on `day` (0 to 29.53)."""
    noon = datetime(day.year, day.month, day.day, 12, tzinfo=timezone.utc)
    return ((noon - NEW_MOON_2000).total_seconds() / 86400.0) % SYNODIC


def days_from_syzygy(day: date) -> float:
    """Days to the nearest new or full moon (0 to about 7.4)."""
    half = SYNODIC / 2
    p = phase_days(day) % half
    return min(p, half - p)


def moon_kind(day: date) -> str:
    """'new' or 'full', whichever is nearer."""
    p = phase_days(day)
    half = SYNODIC / 2
    distance_new = min(p, SYNODIC - p)
    distance_full = abs(p - half)
    return "new" if distance_new <= distance_full else "full"


def near_share(window: float = WINDOW_DAYS) -> float:
    """Share of all days within `window` days of a new or full moon."""
    return min(1.0, 4 * window / SYNODIC)


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - m) / d, (c + m) / d)


def binom_upper_tail(k: int, n: int, p: float) -> float:
    return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(k, n + 1))


def day_info(day: date, window: float = WINDOW_DAYS) -> dict[str, Any]:
    distance = days_from_syzygy(day)
    return {
        "date": day.isoformat(),
        "spring": distance <= window,
        "days_from_moon": round(distance, 1),
        "moon": moon_kind(day),
    }


def listed_flood_check(events: Sequence[Mapping[str, Any]], window: float = WINDOW_DAYS) -> dict[str, Any]:
    """How many listed floods began within `window` days of a new/full moon, and what chance alone gives."""
    days = set()
    for e in events:
        if not e.get("start_date") or e.get("date_basis") == "article_date":
            continue
        if not any(t.get("evidence") == "flooded" for t in e.get("towns", [])):
            continue
        days.add(date.fromisoformat(e["start_date"]))
    n = len(days)
    k = sum(1 for d in days if days_from_syzygy(d) <= window)
    expected = near_share(window)
    low, high = wilson(k, n)
    return {
        "events": n,
        "near_spring": k,
        "share": round(k / n, 2) if n else None,
        "share_range_95": [round(low, 2), round(high, 2)],
        "expected_share_if_no_link": round(expected, 2),
        "p_value_one_sided": round(binom_upper_tail(k, n, expected), 3) if n else None,
    }


def build_tide(day: str, events: Sequence[Mapping[str, Any]], before: int = 2, after: int = 2) -> dict[str, Any]:
    """Spring-tide flags for the rain window (day - before .. day + after) and the listed-flood check."""
    centre = date.fromisoformat(day)
    days = [day_info(centre + timedelta(days=k)) for k in range(-before, after + 1)]
    return {
        "window_days": WINDOW_DAYS,
        "days": days,
        "spring_in_window": any(d["spring"] for d in days),
        "tested": listed_flood_check(events),
        "source": SOURCE,
        "part_of_sign": False,
    }
