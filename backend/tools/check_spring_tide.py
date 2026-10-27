"""
Do the listed Bataan floods cluster around spring tides (new or full moon)?

Read-only: prints a result, writes nothing. Run from backend/:  python tools/check_spring_tide.py

Needs no tide data: spring tides follow the moon, whose phase can be computed for any date.
Moon phase here is the mean synodic phase (reference new moon 2000-01-06 18:14 UTC, month
29.530588853 days). It can be off by up to about half a day, which is small beside the
+-2 day window used. Actual spring tides come 1 to 2 days after new/full moon, so the window
is centred on new/full moon and widened rather than shifted.

What is counted: one count per listed flood event with a stated or inferred start date and
at least one town with evidence "flooded" (events dated only from an article date are left out,
like in the evidence analytics). Many towns in one storm count once.

Honest limits: about 30 events is small, so only a strong link could show; "no link found"
means "not detectable with this list", not "no effect". Floods that came with a typhoon or
habagat rain were driven mainly by rain.
"""

from __future__ import annotations

import json
import math
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVENTS = ROOT / "app" / "data" / "flood_events.json"
SYNODIC = 29.530588853
NEW_MOON_2000 = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
WINDOW_DAYS = 2.0


def phase_days(day: date) -> float:
    """Days since the last mean new moon at noon UTC on `day` (0 to 29.53)."""
    noon = datetime(day.year, day.month, day.day, 12, tzinfo=timezone.utc)
    return ((noon - NEW_MOON_2000).total_seconds() / 86400.0) % SYNODIC


def days_from_syzygy(day: date) -> float:
    """Days to the nearest new or full moon (0 to about 7.4)."""
    p = phase_days(day)
    half = SYNODIC / 2
    return min(p % half, half - (p % half))


def near_share(window: float = WINDOW_DAYS) -> float:
    """Share of all days that fall within `window` days of a new or full moon."""
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
    """P(X >= k) for X ~ Binomial(n, p)."""
    return sum(math.comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(k, n + 1))


def flood_days(path: Path = EVENTS) -> list[date]:
    with open(path, encoding="utf-8") as handle:
        events = json.load(handle)["events"]
    out = []
    for e in events:
        if not e.get("start_date") or e.get("date_basis") == "article_date":
            continue
        if not any(t.get("evidence") == "flooded" for t in e.get("towns", [])):
            continue
        out.append(date.fromisoformat(e["start_date"]))
    return sorted(set(out))


def analyse(days: list[date], window: float = WINDOW_DAYS) -> dict:
    near = [d for d in days if days_from_syzygy(d) <= window]
    n, k = len(days), len(near)
    expected = near_share(window)
    low, high = wilson(k, n)
    return {
        "events": n, "near_spring": k, "share": (k / n) if n else None,
        "share_range_95": (round(low, 2), round(high, 2)),
        "expected_share_if_no_link": round(expected, 2),
        "p_value_one_sided": round(binom_upper_tail(k, n, expected), 3) if n else None,
    }


def main() -> int:
    days = flood_days()
    result = analyse(days)
    print(f"Listed flood events used: {result['events']} (dated, town flooded, not article-date only)")
    print(f"Within {WINDOW_DAYS:g} days of new/full moon: {result['near_spring']} "
          f"= {result['share']:.0%} (95% range {result['share_range_95'][0]:.0%} to {result['share_range_95'][1]:.0%})")
    print(f"Expected if the moon made no difference: {result['expected_share_if_no_link']:.0%}")
    print(f"One-sided p-value (more floods near spring tide than chance): {result['p_value_one_sided']}")
    for d in days:
        print(f"  {d}  {days_from_syzygy(d):4.1f} days from new/full moon")
    return 0


if __name__ == "__main__":
    sys.exit(main())
