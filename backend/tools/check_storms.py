"""
Do the listed Bataan floods happen when a tropical cyclone is near Bataan?

Read-only: prints a result, writes nothing.  Run from backend/:
    python tools/check_storms.py [path/to/ibtracs.WP.list.v04r01.csv]

Needs one data file that is NOT in the repo: the IBTrACS western Pacific "list" CSV (NOAA NCEI,
best-track data, 3-hourly positions). Download it once and keep it in backend/data/ (git-ignored),
default name  backend/data/ibtracs.WP.list.v04r01.csv  . If the file is missing the tool says so
and does nothing else; it never invents storm positions.

What is counted (same rules as tools/check_spring_tide.py): one count per listed flood event with a
stated or inferred start date and at least one town with evidence "flooded". For each event, the
nearest approach of any tracked cyclone to any of the 12 AGOS municipality points during the
window  [start - 2 days, start + 1 day]  (UTC dates) is found. That is compared with the same
number for ordinary days in the months when the listed floods happen, over the same years, so
the comparison accounts for storms and floods both being more common in the wet season.

Honest limits: about 30 events is small, so only a strong link could show; "no link found" means
"not detectable with this list", not "no effect". Best-track positions are after-the-fact
analyses. Habagat (monsoon) floods can be boosted by a storm far away, so several distances are
tried. Distance to a storm centre says nothing about rain amount. Rain is already in the sign.
"""

from __future__ import annotations

import csv
import json
import math
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
EVENTS = ROOT / "app" / "data" / "flood_events.json"
DEFAULT_TRACKS = ROOT / "data" / "ibtracs.WP.list.v04r01.csv"
RADII_KM = (300, 500, 800, 1000)
TROPICAL_STORM_KT = 34
DAYS_BEFORE = 2
DAYS_AFTER = 1
EARTH_RADIUS_KM = 6371.0088


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def bataan_points() -> list[tuple[float, float]]:
    from app.data.municipalities import MUNICIPALITIES

    return [(v["latitude"], v["longitude"]) for v in MUNICIPALITIES.values()]


def _number(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "", " ") else None
    except ValueError:
        return None


def read_tracks(path: Path) -> list[dict]:
    """IBTrACS list CSV -> [{sid, name, time (datetime), lat, lon, wind_kt|None}]. The second row holds units."""
    out = []
    with open(path, newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            time = row.get("ISO_TIME") or ""
            if time.strip() == "" or time.strip().lower() == " ":
                continue  # the units row
            try:
                when = datetime.strptime(time.strip(), "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
            lat, lon = _number(row.get("LAT")), _number(row.get("LON"))
            if lat is None or lon is None:
                continue
            wind = _number(row.get("WMO_WIND")) or _number(row.get("USA_WIND"))
            out.append({"sid": row.get("SID"), "name": (row.get("NAME") or "").strip(), "time": when,
                        "lat": lat, "lon": lon, "wind_kt": wind})
    return out


def daily_nearest(tracks: list[dict], points: list[tuple[float, float]], min_wind: float = 0) -> dict[date, tuple[float, str]]:
    """{day: (nearest distance km to any point, storm name)} using every position that day."""
    best: dict[date, tuple[float, str]] = {}
    for p in tracks:
        if min_wind and (p["wind_kt"] is None or p["wind_kt"] < min_wind):
            continue
        d = min(haversine_km(p["lat"], p["lon"], la, lo) for la, lo in points)
        day = p["time"].date()
        if day not in best or d < best[day][0]:
            best[day] = (d, p["name"] or p["sid"] or "unnamed")
    return best


def nearest_in_window(nearest: dict[date, tuple[float, str]], day: date,
                      before: int = DAYS_BEFORE, after: int = DAYS_AFTER) -> tuple[float, str] | None:
    found = [nearest[day + timedelta(days=k)] for k in range(-before, after + 1) if (day + timedelta(days=k)) in nearest]
    return min(found) if found else None


def flood_days(path: Path = EVENTS) -> list[date]:
    with open(path, encoding="utf-8") as handle:
        events = json.load(handle)["events"]
    out = set()
    for e in events:
        if not e.get("start_date") or e.get("date_basis") == "article_date":
            continue
        if not any(t.get("evidence") == "flooded" for t in e.get("towns", [])):
            continue
        out.add(date.fromisoformat(e["start_date"]))
    return sorted(out)


def season_days(days: list[date]) -> list[date]:
    """Every calendar day in the years and months the listed floods cover."""
    if not days:
        return []
    months = {d.month for d in days}
    first, last = min(d.year for d in days), max(d.year for d in days)
    cur, end = date(first, 1, 1), date(last, 12, 31)
    out = []
    while cur <= end:
        if cur.month in months:
            out.append(cur)
        cur += timedelta(days=1)
    return out


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


def analyse(days: list[date], nearest: dict[date, tuple[float, str]], radii=RADII_KM) -> dict:
    """For each radius: floods with a storm that near, the same share on ordinary season days, and a one-sided p-value."""
    base_days = season_days(days)
    base_near = [nearest_in_window(nearest, d) for d in base_days]
    event_near = [nearest_in_window(nearest, d) for d in days]
    rows = []
    for r in radii:
        k = sum(1 for x in event_near if x and x[0] <= r)
        n = len(days)
        expected = (sum(1 for x in base_near if x and x[0] <= r) / len(base_days)) if base_days else None
        low, high = wilson(k, n)
        rows.append({
            "radius_km": r, "events": n, "with_storm": k, "share": round(k / n, 2) if n else None,
            "share_range_95": (round(low, 2), round(high, 2)),
            "expected_share_if_no_link": round(expected, 2) if expected is not None else None,
            "p_value_one_sided": round(binom_upper_tail(k, n, expected), 3) if n and expected is not None else None,
        })
    return {"rows": rows, "season_days": len(base_days), "event_near": event_near}


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else DEFAULT_TRACKS
    if not path.exists():
        print(f"Storm track file not found: {path}\n"
              "Download the IBTrACS western Pacific list CSV (NOAA NCEI) and save it there, then run again.\n"
              "Nothing was calculated: AGOS does not invent storm positions.")
        return 2
    tracks = read_tracks(path)
    if not tracks:
        print(f"{path.name} has no readable track positions (expected the IBTrACS list CSV).")
        return 2
    points = bataan_points()
    days = flood_days()
    years = f"{tracks[0]['time'].year}-{tracks[-1]['time'].year}"
    print(f"Track file: {path.name} ({len(tracks)} positions, first/last years in file order: {years})")
    print(f"Listed flood events used: {len(days)}; comparison days: ordinary days in the same months and years")
    for label, min_wind in (("any tracked system", 0), (f"tropical storm strength or more (>= {TROPICAL_STORM_KT} kt)", TROPICAL_STORM_KT)):
        nearest = daily_nearest(tracks, points, min_wind)
        result = analyse(days, nearest)
        print(f"\n== {label}; nearest approach in [-{DAYS_BEFORE}, +{DAYS_AFTER}] days of the flood start ==")
        for r in result["rows"]:
            print(f"  within {r['radius_km']:>4} km: {r['with_storm']:>2} of {r['events']} floods = {r['share']:.0%} "
                  f"(95% range {r['share_range_95'][0]:.0%}-{r['share_range_95'][1]:.0%}); "
                  f"ordinary season days: {r['expected_share_if_no_link']:.0%}; p = {r['p_value_one_sided']}")
        if min_wind == 0:
            for d, near in zip(days, result["event_near"]):
                text = f"{near[0]:6.0f} km  {near[1]}" if near else "no tracked system in the window"
                print(f"    {d}  {text}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
