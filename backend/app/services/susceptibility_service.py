"""
AGOS — flood susceptibility by area, from the official DENR-MGB map.

Source: DENR Mines and Geosciences Bureau, "Detailed Flood Susceptibility"
(GeospatialDataInventory_Public / GDI_Detailed_Flood_Susceptibility_Public
MapServer, layer 0, field FloodSusc: VHF Very High, HF High, MF Moderate, LF Low).
The service offers Map, Query and Data. AGOS downloads the shapes over Bataan
once (simplified to about 20 m) and measures, for each barangay, which share of
its land falls in each class, by sampling points on a regular grid (200 m).

Build:  python tools/build_mgb_susceptibility.py   (writes app/data/mgb_susceptibility_bataan.json)
Serve:  GET /api/susceptibility

What it is and is not
- Official susceptibility classes: where flooding is possible in general, mapped by MGB.
  Not a forecast, not flood depth, not "will flood today".
- "Not rated": land with no MGB class (mostly uplands and forest; MGB rates
  flood-prone lowland). Not the same as "safe".
- Grid sampling: small barangays get few samples, so their shares are rough;
  barangays smaller than the grid spacing may get no sample at all (reported).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Iterable, Mapping

CLASSES = ("very_high", "high", "moderate", "low")
MGB_CODES = {"VHF": "very_high", "HF": "high", "MF": "moderate", "LF": "low"}
DATA_FILE = Path(__file__).resolve().parents[1] / "data" / "mgb_susceptibility_bataan.json"
MIN_SAMPLES_FOR_RANK = 5  # about 0.2 km2 at 200 m spacing

Polygon = tuple[tuple[float, float, float, float], list[list[list[float]]]]  # (bbox, rings)


# --------------------------------------------------------------------------
# Geometry (pure Python, no dependencies)
# --------------------------------------------------------------------------

def inside_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    """Ray casting: is (x, y) inside the closed ring?"""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def polygons(geometry: Mapping[str, Any], clip: tuple[float, float, float, float] | None = None) -> list[Polygon]:
    """GeoJSON Polygon/MultiPolygon -> [(bbox, rings)], optionally keeping only parts near `clip` (w, s, e, n)."""
    coords = geometry["coordinates"]
    parts = coords if geometry["type"] == "MultiPolygon" else [coords]
    out: list[Polygon] = []
    for rings in parts:
        xs = [p[0] for p in rings[0]]
        ys = [p[1] for p in rings[0]]
        box = (min(xs), min(ys), max(xs), max(ys))
        if clip and (box[2] < clip[0] or box[0] > clip[2] or box[3] < clip[1] or box[1] > clip[3]):
            continue
        out.append((box, rings))
    return out


def contains(x: float, y: float, polys: Iterable[Polygon]) -> bool:
    for box, rings in polys:
        if box[0] <= x <= box[2] and box[1] <= y <= box[3] and inside_ring(x, y, rings[0]) \
                and not any(inside_ring(x, y, hole) for hole in rings[1:]):
            return True
    return False


def sample_points(polys: list[Polygon], step_m: float) -> list[tuple[float, float]]:
    """Grid points (step_m apart) that fall inside the polygons."""
    if not polys:
        return []
    west = min(b[0] for b, _ in polys)
    south = min(b[1] for b, _ in polys)
    east = max(b[2] for b, _ in polys)
    north = max(b[3] for b, _ in polys)
    dlat = step_m / 111_320
    dlon = step_m / (111_320 * math.cos(math.radians((south + north) / 2)))
    points = []
    y = south + dlat / 2
    while y < north:
        x = west + dlon / 2
        while x < east:
            if contains(x, y, polys):
                points.append((x, y))
            x += dlon
        y += dlat
    return points


def class_counts(points: list[tuple[float, float]], classes: list[tuple[str, list[Polygon]]]) -> dict[str, int]:
    """How many points fall in each class (first match wins), the rest are 'not_rated'."""
    counts = {c: 0 for c in CLASSES}
    counts["not_rated"] = 0
    for x, y in points:
        hit = next((name for name, polys in classes if contains(x, y, polys)), "not_rated")
        counts[hit] += 1
    return counts


def build(mgb_geojson: Mapping[str, Any], barangays_geojson: Mapping[str, Any], step_m: float = 200.0,
          clip: tuple[float, float, float, float] = (120.2, 14.35, 120.7, 15.0)) -> list[dict[str, Any]]:
    """Per-barangay sample counts by MGB class."""
    classes = []
    for feature in mgb_geojson["features"]:
        code = (feature.get("properties") or {}).get("FloodSusc")
        if code in MGB_CODES and feature.get("geometry"):
            classes.append((MGB_CODES[code], polygons(feature["geometry"], clip)))
    rows = []
    for feature in barangays_geojson["features"]:
        props = feature["properties"]
        points = sample_points(polygons(feature["geometry"]), step_m)
        rows.append({
            "psgc": props["psgc"], "barangay": props["name"], "municipality": props["municipality"],
            "samples": len(points), **class_counts(points, classes),
        })
    return rows


# --------------------------------------------------------------------------
# Summaries for the interface
# --------------------------------------------------------------------------

def shares(row: Mapping[str, Any]) -> dict[str, float] | None:
    n = row.get("samples") or 0
    if not n:
        return None
    return {k: round(row[k] / n, 4) for k in (*CLASSES, "not_rated")}


def spearman(a: Mapping[str, float], b: Mapping[str, float]) -> float | None:
    keys = [k for k in a if k in b]
    if len(keys) < 3:
        return None

    def ranks(values: dict[str, float]) -> dict[str, float]:
        order = sorted(values, key=lambda k: values[k])
        out: dict[str, float] = {}
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
                j += 1
            for k in order[i:j + 1]:
                out[k] = (i + j) / 2 + 1
            i = j + 1
        return out

    ra, rb = ranks({k: a[k] for k in keys}), ranks({k: b[k] for k in keys})
    ma, mb = sum(ra.values()) / len(keys), sum(rb.values()) / len(keys)
    cov = sum((ra[k] - ma) * (rb[k] - mb) for k in keys)
    va = sum((ra[k] - ma) ** 2 for k in keys)
    vb = sum((rb[k] - mb) ** 2 for k in keys)
    return round(cov / math.sqrt(va * vb), 2) if va and vb else None


def summarize(data: Mapping[str, Any], flood_counts: Mapping[str, int] | None = None, top_n: int = 8) -> dict[str, Any]:
    rows = data["barangays"]
    towns: dict[str, dict[str, Any]] = {}
    for row in rows:
        t = towns.setdefault(row["municipality"], {"samples": 0, **{k: 0 for k in (*CLASSES, "not_rated")}, "barangays": []})
        t["samples"] += row["samples"]
        for k in (*CLASSES, "not_rated"):
            t[k] += row[k]
        t["barangays"].append(row)
    out_towns = []
    for name, t in towns.items():
        ranked = [r for r in t["barangays"] if r["samples"] >= MIN_SAMPLES_FOR_RANK]
        ranked.sort(key=lambda r: (-(r["high"] + r["very_high"]) / r["samples"], -r["samples"]))
        out_towns.append({
            "name": name,
            "samples": t["samples"],
            "area_km2_sampled": round(t["samples"] * (data["step_m"] / 1000) ** 2, 1),
            "shares": shares(t),
            "barangays_total": len(t["barangays"]),
            "barangays_unsampled": [r["barangay"] for r in t["barangays"] if not r["samples"]],
            "top_barangays": [{"name": r["barangay"], "psgc": r["psgc"], "samples": r["samples"], "shares": shares(r)} for r in ranked[:top_n]],
            "listed_floods": (flood_counts or {}).get(name),
        })
    out_towns.sort(key=lambda x: -((x["shares"] or {}).get("high", 0) + (x["shares"] or {}).get("very_high", 0)))
    check = None
    if flood_counts:
        high = {x["name"]: x["shares"]["high"] + x["shares"]["very_high"] for x in out_towns if x["shares"]}
        check = {"spearman_high_share_vs_listed_floods": spearman(high, dict(flood_counts)), "towns": len(high)}
    return {
        "towns": out_towns,
        "classes_present": [c for c in CLASSES if any(r[c] for r in rows)],
        "step_m": data["step_m"],
        "built_at": data.get("built_at"),
        "check": check,
        "sources": {
            "susceptibility": data.get("source"),
            "barangays": data.get("barangays_source"),
        },
        "notes": [
            "Official DENR-MGB flood susceptibility classes: where flooding is possible in general. Not a forecast and not flood depth.",
            "'Not rated' is land MGB did not classify (mostly uplands and forest); it does not mean safe.",
            f"Shares come from points every {data['step_m']:.0f} m inside each barangay; small barangays are rough or unsampled.",
        ],
    }


def load(path: Path = DATA_FILE) -> dict[str, Any]:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def susceptibility_report() -> dict[str, Any]:
    if not DATA_FILE.exists():
        return {"available": False, "reason": "app/data/mgb_susceptibility_bataan.json is missing; run tools/build_mgb_susceptibility.py"}
    counts = None
    try:  # the agreement check with the AGOS flood list is optional; the map data stands alone
        from app.data.municipalities import MUNICIPALITIES
        from app.services import flood_events_service

        events = flood_events_service.read_file()[0]["events"]
        counts = {r["municipality"]: r["flooded"] for r in flood_events_service.town_counts(events, MUNICIPALITIES)}
    except Exception:  # noqa: BLE001
        counts = None
    return {"available": True, **summarize(load(), counts)}
