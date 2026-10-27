"""
When the rain is already unusual, are listed floods more likely if a tropical cyclone is near?

Read-only: prints a result, writes nothing.  Run from backend/ (needs the AGOS database and the
IBTrACS file, see tools/check_storms.py):
    python tools/check_storm_adds_to_rain.py [path/to/ibtracs.WP.list.v04r01.csv]

Why this test: tools/check_storms.py found floods with a storm nearby more often than ordinary
days do, but a storm nearby mostly means heavy rain, and rain is already the AGOS warning sign.
This asks the sharper question: among spells of unusual rain (the sign's Watch level or higher),
do the spells with a storm near end in a listed flood more often than the spells without one?

How:
 * A rain day is a day on which some town's 3-day rain (ending that day) is in the top 5% of
   that town's own stored record (the Watch level of the sign).
 * Rain days at most 2 days apart are merged into one spell, so one storm is counted once.
 * A spell "ends in a flood" if a listed flood (dated, a town flooded) began from 1 day before
   the spell starts to 2 days after it ends.
 * A storm is "near" if a tracked cyclone came within R km of any of the 12 town points from
   2 days before the spell starts to 1 day after it ends.
 * Spells are also split by how extreme the rain was (peak percentile under 99, or 99 and over),
   and the storm effect is pooled over both groups (Mantel-Haenszel), so heavier rain with a
   storm cannot fake a storm effect.
 * Only spells from 2011 on are used: the flood list is much thinner before.

Honest limits: about 25 listed floods is small, so only a strong effect could show; "no effect
found" means "not detectable with this list", not "no effect". The list misses small floods.
Rain is ERA5 (modeled), at one point per town. Several distances are tried on the same floods,
so one or two small p-values can be chance. This is a suggestion, never proof, and it does not
change the warning sign.
"""

from __future__ import annotations

import math
import sys
from bisect import bisect_left
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools import check_storms as cs  # noqa: E402

FROM_DATE = date(2011, 1, 1)
RAISED_PERCENTILE = 95.0  # the Watch level
STRONG_PERCENTILE = 99.0  # split between stronger and weaker rain spells
MERGE_GAP_DAYS = 2
FLOOD_BEFORE = 1
FLOOD_AFTER = 2
STORM_BEFORE = 2
STORM_AFTER = 1
RADII_KM = (300, 500, 800, 1000)


def percentile_in(value: float, sorted_values: list[float]) -> float | None:
    """Share (0-100) of the record strictly lower than `value` (same as the warning sign)."""
    if not sorted_values:
        return None
    return 100.0 * bisect_left(sorted_values, value) / len(sorted_values)


def raised_days(towns: dict[str, tuple[dict[str, float], list[float]]], threshold: float = RAISED_PERCENTILE) -> dict[date, float]:
    """{day: highest percentile among towns} for days when some town's 3-day rain is at or above `threshold`."""
    out: dict[date, float] = {}
    for rain3, sorted3 in towns.values():
        for day, value in rain3.items():
            p = percentile_in(value, sorted3)
            if p is not None and p >= threshold:
                d = date.fromisoformat(day)
                if p > out.get(d, 0.0):
                    out[d] = p
    return out


def spells(days: dict[date, float], gap: int = MERGE_GAP_DAYS) -> list[dict]:
    """Merge rain days at most `gap` days apart into spells: [{start, end, peak}]."""
    out: list[dict] = []
    for d in sorted(days):
        if out and (d - out[-1]["end"]).days <= gap + 1:
            out[-1]["end"] = d
            out[-1]["peak"] = max(out[-1]["peak"], days[d])
        else:
            out.append({"start": d, "end": d, "peak": days[d]})
    return out


def ends_in_flood(spell: dict, flood_days: list[date]) -> bool:
    low, high = spell["start"] - timedelta(days=FLOOD_BEFORE), spell["end"] + timedelta(days=FLOOD_AFTER)
    return any(low <= f <= high for f in flood_days)


def storm_distance(spell: dict, nearest: dict[date, tuple[float, str]]) -> tuple[float, str] | None:
    """Nearest approach of a tracked cyclone during the spell (from 2 days before to 1 day after)."""
    found = []
    d = spell["start"] - timedelta(days=STORM_BEFORE)
    last = spell["end"] + timedelta(days=STORM_AFTER)
    while d <= last:
        if d in nearest:
            found.append(nearest[d])
        d += timedelta(days=1)
    return min(found) if found else None


def wilson(k: int, n: int) -> tuple[float, float]:
    return cs.wilson(k, n)


def fisher_upper(a: int, b: int, c: int, d: int) -> float:
    """One-sided Fisher exact p for more floods among storm spells: P(X >= a). Rows: storm (a flood, b none), no storm (c, d)."""
    n1, n2, k = a + b, c + d, a + c
    total = math.comb(n1 + n2, k)
    return sum(math.comb(n1, i) * math.comb(n2, k - i) for i in range(a, min(n1, k) + 1)) / total


def mantel_haenszel(tables: list[tuple[int, int, int, int]]) -> dict:
    """Pooled odds ratio and Cochran-Mantel-Haenszel test over 2x2 tables (a flood+storm, b none+storm, c flood+no storm, d none+no storm)."""
    num = den = 0.0
    s_diff = s_var = 0.0
    for a, b, c, d in tables:
        n = a + b + c + d
        if n == 0:
            continue
        num += a * d / n
        den += b * c / n
        n1, n2, m1 = a + b, c + d, a + c
        if n > 1:
            expected = n1 * m1 / n
            var = n1 * n2 * m1 * (n - m1) / (n * n * (n - 1))
            s_diff += a - expected
            s_var += var
    odds = (num / den) if den > 0 else None
    p_two = math.erfc(math.sqrt((s_diff ** 2 / s_var) / 2)) if s_var > 0 else None
    return {
        "odds_ratio": round(odds, 2) if odds is not None else None,
        "p_two_sided": round(p_two, 3) if p_two is not None else None,
        "more_floods_with_storm": s_diff > 0,
    }


def analyse(spell_list: list[dict], flood_days: list[date], nearest: dict[date, tuple[float, str]], radii=RADII_KM) -> list[dict]:
    flags = [(ends_in_flood(s, flood_days), storm_distance(s, nearest), s["peak"]) for s in spell_list]
    rows = []
    for r in radii:
        def cell(strong: bool | None):
            a = b = c = d = 0
            for flood, near, peak in flags:
                if strong is not None and (peak >= STRONG_PERCENTILE) != strong:
                    continue
                storm = near is not None and near[0] <= r
                if storm and flood:
                    a += 1
                elif storm:
                    b += 1
                elif flood:
                    c += 1
                else:
                    d += 1
            return a, b, c, d

        a, b, c, d = cell(None)
        strata = [cell(False), cell(True)]
        rows.append({
            "radius_km": r, "spells": a + b + c + d,
            "storm_spells": a + b, "storm_floods": a, "storm_rate": round(a / (a + b), 2) if a + b else None,
            "storm_range_95": tuple(round(x, 2) for x in wilson(a, a + b)),
            "no_storm_spells": c + d, "no_storm_floods": c, "no_storm_rate": round(c / (c + d), 2) if c + d else None,
            "no_storm_range_95": tuple(round(x, 2) for x in wilson(c, c + d)),
            "fisher_p_one_sided": round(fisher_upper(a, b, c, d), 3),
            "adjusted_for_rain_strength": mantel_haenszel(strata),
        })
    return rows


def load_town_rain() -> tuple[dict[str, tuple[dict[str, float], list[float]]], dict]:
    """{town: (3-day totals by end date, sorted 3-day totals)} from the AGOS database, and the record label."""
    from app.data.municipalities import MUNICIPALITIES
    from app.services import evidence_service as ev
    from app.services.climate_service import load_daily_rain, rain_record

    connection = ev._default_connect()
    try:
        record = rain_record(connection)
        towns = {}
        for name, point in MUNICIPALITIES.items():
            rain = load_daily_rain(connection, point, record["source"])
            rain3 = ev.rolling_sums(rain, 3)
            towns[name] = (rain3, sorted(rain3.values()))
    finally:
        connection.close()
    return towns, record


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else cs.DEFAULT_TRACKS
    if not path.exists():
        print(f"Storm track file not found: {path}\nSee tools/check_storms.py for where to get it. Nothing was calculated.")
        return 2
    try:
        towns, record = load_town_rain()
    except Exception as error:  # noqa: BLE001 - say why and stop, never guess
        print(f"Could not read the stored rain record ({type(error).__name__}: {error}). Nothing was calculated.")
        return 2
    if not any(rain3 for rain3, _ in towns.values()):
        print("The AGOS database has no stored rain record. Nothing was calculated.")
        return 2
    tracks = cs.read_tracks(path)
    if not tracks:
        print(f"{path.name} has no readable track positions. Nothing was calculated.")
        return 2
    points = cs.bataan_points()
    floods = [d for d in cs.flood_days() if d >= FROM_DATE]
    last_rain = max(date.fromisoformat(day) for rain3, _ in towns.values() for day in rain3)
    all_spells = [s for s in spells(raised_days(towns)) if s["start"] >= FROM_DATE and s["end"] <= last_rain - timedelta(days=FLOOD_AFTER)]
    in_flood = sum(1 for s in all_spells if ends_in_flood(s, floods))
    print(f"Rain record: {record.get('label')}")
    print(f"Spells of unusual rain (some town's 3-day rain in its top 5%) from {FROM_DATE} to {last_rain}: {len(all_spells)}")
    print(f"Listed floods from {FROM_DATE}: {len(floods)}; spells that end in a listed flood: {in_flood}")
    unmatched = [f for f in floods if not any(ends_in_flood(s, [f]) for s in all_spells)]
    print(f"Listed floods with no unusual-rain spell around them: {len(unmatched)} {[d.isoformat() for d in unmatched]}")
    for label, min_wind in (("any tracked system", 0), (f"tropical storm strength or more (>= {cs.TROPICAL_STORM_KT} kt)", cs.TROPICAL_STORM_KT)):
        nearest = cs.daily_nearest(tracks, points, min_wind)
        print(f"\n== {label}: spells with a storm near vs without, share ending in a listed flood ==")
        for r in analyse(all_spells, floods, nearest):
            adj = r["adjusted_for_rain_strength"]
            print(f"  within {r['radius_km']:>4} km: with storm {r['storm_floods']}/{r['storm_spells']} = {r['storm_rate']} "
                  f"(95% {r['storm_range_95']}); without {r['no_storm_floods']}/{r['no_storm_spells']} = {r['no_storm_rate']} "
                  f"(95% {r['no_storm_range_95']}); Fisher p = {r['fisher_p_one_sided']}; "
                  f"adjusted for rain strength: odds ratio {adj['odds_ratio']}, p = {adj['p_two_sided']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
