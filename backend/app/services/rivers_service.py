"""
AGOS — rivers for the map and for each town's flood factors.

Source: OpenStreetMap waterways (river, stream, canal) fetched once from the Overpass API
by tools/fetch_rivers.py and kept in backend/data/waterways_osm_tagged.geojson (git-ignored).
The older waterways_osm.geojson, built for the terrain layers, keeps geometry only (no names,
no types), so it cannot say which line is a river or what it is called.

What this module does:
- loads the file (never invents lines: a missing or unreadable file answers available: false),
- simplifies every line for the browser (Douglas-Peucker, about 30 m),
- drops lines that never touch a Bataan municipality,
- per town: the sorted names of the named waterways that touch it and the mapped length in km.

Rivers are context only. They are not part of the warning sign and say nothing about
water level, flow or flood depth. OpenStreetMap is volunteer-mapped and may be incomplete.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from app.services import terrain_service as ts

BACKEND = Path(__file__).resolve().parents[2]
DATA_FILE = BACKEND / "data" / "waterways_osm_tagged.geojson"

SOURCE = "OpenStreetMap waterways (Overpass), © OpenStreetMap contributors, ODbL"
LICENSE = "Open Database Licence (ODbL) 1.0, https://www.openstreetmap.org/copyright"
TYPES = ("river", "stream", "canal")
TOLERANCE_M = 30.0
PIECE_M = 200.0  # a segment is assigned to towns in pieces this long
COORD_DECIMALS = 5  # about 1 m

Line = list[tuple[float, float]]  # [(lon, lat), ...]


# --------------------------------------------------------------------------
# Pure helpers
# --------------------------------------------------------------------------

def _metres(lat0: float) -> tuple[float, float]:
    return ts.M_PER_DEG_LON_EQUATOR * math.cos(math.radians(lat0)), ts.M_PER_DEG_LAT


def _point_segment_m(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    if dx == 0 and dy == 0:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def simplify_line(line: Sequence[tuple[float, float]], tolerance_m: float = TOLERANCE_M) -> Line:
    """Douglas-Peucker on a local metre grid. The two ends are always kept."""
    pts = [(float(x), float(y)) for x, y in line]
    n = len(pts)
    if n <= 2:
        return pts
    kx, ky = _metres(sum(p[1] for p in pts) / n)
    xy = [(p[0] * kx, p[1] * ky) for p in pts]
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        far, far_d = -1, tolerance_m
        for i in range(a + 1, b):
            d = _point_segment_m(xy[i], xy[a], xy[b])
            if d > far_d:
                far, far_d = i, d
        if far >= 0:
            keep[far] = True
            stack.append((a, far))
            stack.append((far, b))
    return [p for p, k in zip(pts, keep) if k]


def line_length_m(line: Sequence[tuple[float, float]]) -> float:
    if len(line) < 2:
        return 0.0
    kx, ky = _metres(sum(p[1] for p in line) / len(line))
    return sum(math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky) for a, b in zip(line, line[1:]))


def parse_overpass(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Ways from an Overpass `out geom tags` answer: [{name, waterway, tunnel, line}]."""
    out = []
    for element in payload.get("elements", []):
        tags = element.get("tags") or {}
        if element.get("type") != "way" or tags.get("waterway") not in TYPES:
            continue
        line = [(float(p["lon"]), float(p["lat"])) for p in element.get("geometry") or [] if "lon" in p and "lat" in p]
        if len(line) < 2:
            continue
        out.append({"name": (tags.get("name") or "").strip() or None, "waterway": tags["waterway"],
                    "tunnel": tags.get("tunnel"), "line": line})
    return out


def features_to_geojson(features: Sequence[Mapping[str, Any]], metadata: Mapping[str, Any]) -> dict[str, Any]:
    """The file kept on disk: every line with its name and waterway type."""
    items = []
    for f in features:
        props = {"waterway": f["waterway"]}
        if f.get("name"):
            props["name"] = f["name"]
        if f.get("tunnel"):
            props["tunnel"] = f["tunnel"]
        items.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "LineString", "coordinates": [list(p) for p in f["line"]]}})
    return {"type": "FeatureCollection", "metadata": dict(metadata), "features": items}


def is_underground(feature: Mapping[str, Any]) -> bool:
    """OpenStreetMap tunnel=culvert (or yes, etc.) means the water runs in a pipe: left off the map and the counts."""
    tunnel = feature.get("tunnel")
    return bool(tunnel) and str(tunnel).lower() != "no"


def read_features(data: Mapping[str, Any]) -> list[dict[str, Any]]:
    out = []
    for feature in data.get("features", []):
        geometry = feature.get("geometry") or {}
        props = feature.get("properties") or {}
        if geometry.get("type") != "LineString" or props.get("waterway") not in TYPES:
            continue
        line = [(float(x), float(y)) for x, y in geometry["coordinates"]]
        if len(line) >= 2:
            out.append({"name": props.get("name") or None, "waterway": props["waterway"],
                        "tunnel": props.get("tunnel") or None, "line": line})
    return out


class TownLocator:
    """Which municipality a point is in, with a bounding-box check first so it stays fast."""

    def __init__(self, boundaries: Mapping[str, list[ts.Polygon]]):
        self.items = []
        for name, polygons in boundaries.items():
            for polygon in polygons:
                ring = polygon[0]
                xs, ys = [p[0] for p in ring], [p[1] for p in ring]
                self.items.append((name, (min(xs), min(ys), max(xs), max(ys)), polygon))

    def at(self, lon: float, lat: float) -> str | None:
        for name, (x0, y0, x1, y1), polygon in self.items:
            if x0 <= lon <= x1 and y0 <= lat <= y1 and ts.point_in_polygon(lon, lat, polygon):
                return name
        return None


def summarize(
    features: Sequence[Mapping[str, Any]],
    boundaries: Mapping[str, list[ts.Polygon]],
    tolerance_m: float = TOLERANCE_M,
) -> dict[str, Any]:
    """Simplified lines that touch Bataan, plus names and mapped length per town."""
    locator = TownLocator(boundaries)
    names: dict[str, set[str]] = {town: set() for town in boundaries}
    metres: dict[str, float] = {town: 0.0 for town in boundaries}
    kept, before, after, underground = [], 0, 0, 0
    for f in features:
        if is_underground(f):
            underground += 1  # a culvert or tunnel is a pipe under a road or building, not a river you can see
            continue
        line = simplify_line(f["line"], tolerance_m)
        before += len(f["line"])
        touched: set[str] = set()
        for lon, lat in line:
            town = locator.at(lon, lat)
            if town:
                touched.add(town)
        for a, b in zip(line, line[1:]):
            # A long straight segment can cross a town border: judge it in pieces of at most PIECE_M.
            piece_m = line_length_m([a, b])
            pieces = max(1, math.ceil(piece_m / PIECE_M))
            for k in range(pieces):
                t = (k + 0.5) / pieces
                town = locator.at(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                if town:
                    touched.add(town)
                    metres[town] += piece_m / pieces
        if not touched:
            continue  # never touches a Bataan municipality
        after += len(line)
        if f.get("name"):
            for town in touched:
                names[town].add(f["name"])
        kept.append({"name": f.get("name"), "waterway": f["waterway"], "line": line})
    by_type: dict[str, int] = {}
    for f in kept:
        by_type[f["waterway"]] = by_type.get(f["waterway"], 0) + 1
    named = sum(1 for f in kept if f["name"])
    return {
        "lines": kept,
        "towns": [{"name": town, "rivers": sorted(names[town], key=str.casefold), "length_km": round(metres[town] / 1000, 1)}
                  for town in sorted(boundaries)],
        "stats": {
            "features": len(kept), "named": named, "named_share": round(named / len(kept), 3) if kept else 0.0,
            "by_type": by_type, "points_before": before, "points_after": after, "tolerance_m": tolerance_m,
            "outside_bataan_dropped": len(features) - len(kept) - underground,
            "underground_dropped": underground,
        },
    }


def lines_to_display_geojson(lines: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    items = []
    for f in lines:
        props = {"waterway": f["waterway"]}
        if f.get("name"):
            props["name"] = f["name"]
        coords = [[round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)] for x, y in f["line"]]
        items.append({"type": "Feature", "properties": props, "geometry": {"type": "LineString", "coordinates": coords}})
    return {"type": "FeatureCollection", "features": items}


def build_report(path: Path | str = DATA_FILE, boundaries: Mapping[str, list[ts.Polygon]] | None = None) -> dict[str, Any]:
    path = Path(path)
    if not path.exists():
        return {"available": False, "reason": f"{path.name} is missing; run tools/fetch_rivers.py (needs internet once)."}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        features = read_features(data)
    except (OSError, ValueError, KeyError, TypeError) as error:
        return {"available": False, "reason": f"{path.name} could not be read ({type(error).__name__})."}
    if not features:
        return {"available": False, "reason": f"{path.name} has no river, stream or canal lines."}
    result = summarize(features, boundaries if boundaries is not None else ts.load_boundaries())
    meta = data.get("metadata") or {}
    return {
        "available": True,
        "source": SOURCE,
        "license": LICENSE,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fetched_at": meta.get("fetched_at"),
        "osm_data_timestamp": meta.get("osm_data_timestamp"),
        "geojson": lines_to_display_geojson(result["lines"]),
        "towns": result["towns"],
        "stats": result["stats"],
        "notes": [
            "Context only: rivers are not part of the warning sign and say nothing about water level or flood depth.",
            "OpenStreetMap is mapped by volunteers and may be incomplete; only the share of lines that carry a name is listed by name.",
            f"Lines are simplified to about {int(TOLERANCE_M)} m for display; lengths are measured on the simplified lines.",
            "Culverts and tunnels (water in a pipe under a road or building) are left out, so the lines shown are open waterways only.",
            "Lines that never touch a Bataan municipality are left out; a line that crosses the border is shown whole.",
        ],
    }


_cache: dict[str, Any] = {"key": None, "value": None}


def rivers_report() -> dict[str, Any]:
    """Cached until the data file changes (building it walks every line once)."""
    try:
        stamp = DATA_FILE.stat().st_mtime_ns
    except OSError:
        stamp = None
    key = (str(DATA_FILE), stamp)
    if _cache["key"] != key:
        _cache.update(key=key, value=build_report(DATA_FILE))
    return _cache["value"]


def towns_for_factors(report: Mapping[str, Any] | None = None) -> dict[str, dict[str, Any]]:
    """{town: {"names": [...], "length_km": x}}; empty when the rivers data is not available."""
    report = report if report is not None else rivers_report()
    if not report or not report.get("available"):
        return {}
    return {t["name"]: {"names": t["rivers"], "length_km": t["length_km"]} for t in report["towns"]}

