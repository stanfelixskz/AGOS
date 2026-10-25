"""
AGOS — static terrain layers (plan item 2: flood susceptibility stages 1-2)

Builds a regular grid over Bataan's land (cells whose centre lies inside the
PSGC 2023 municipal polygons that are kept in the repository) and stores, per
cell, what can be measured from public data:

  elevation_m            Copernicus DEM GLO-90 (90 m) via the Open-Meteo Elevation API
  slope_deg              from neighbouring cells' elevations (central differences)
  dist_river_m           straight-line distance to the nearest mapped waterway
  height_above_river_m   cell elevation minus the DEM elevation at the nearest
                         sampled point on a waterway (a rough HAND-style value)

Rules
- Nothing is invented. A value that cannot be measured is stored as NULL.
- Every row records its sources; the table `terrain_meta` records how it was built.
- Coarse by design (default 1 km cells, 90 m DEM). This is a screening layer,
  not a hazard map and not a flood forecast.
- Re-running replaces the whole table inside one transaction (idempotent).
- Waterways come from OpenStreetMap (© OpenStreetMap contributors, ODbL) or a
  local GeoJSON file; if none is given, the river columns stay NULL.
"""

from __future__ import annotations

import json
import logging
import math
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

logger = logging.getLogger(__name__)

BOUNDARY_FILE = (
    Path(__file__).resolve().parents[3] / "frontend" / "app" / "data" / "bataan-municipalities-psgc2023.geojson"
)

ELEVATION_URL = "https://api.open-meteo.com/v1/elevation"
ELEVATION_SOURCE = (
    "Open-Meteo Elevation API (Copernicus DEM GLO-90, 90 m; doi:10.5270/ESA-c5d3d65)"
)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_SOURCE = "OpenStreetMap waterways via Overpass API (© OpenStreetMap contributors, ODbL)"
USER_AGENT = "AGOS-student-research/1.0 (flood monitoring study, Bataan)"

BATCH_SIZE = 100          # Open-Meteo allows up to 100 coordinates per request
M_PER_DEG_LAT = 110_574.0
M_PER_DEG_LON_EQUATOR = 111_320.0

SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS terrain_cells (
        id TEXT PRIMARY KEY,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        municipality TEXT NOT NULL,
        spacing_km REAL NOT NULL,
        elevation_m REAL,
        slope_deg REAL,
        dist_river_m REAL,
        height_above_river_m REAL,
        elevation_source TEXT,
        river_source TEXT,
        built_at TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_terrain_municipality ON terrain_cells(municipality)",
    """
    CREATE TABLE IF NOT EXISTS terrain_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
)

Ring = list[tuple[float, float]]          # [(lon, lat), ...]
Polygon = list[Ring]                      # [outer, hole, hole, ...]


def init_tables(connection: sqlite3.Connection) -> None:
    for statement in SCHEMA:
        connection.execute(statement)


# --------------------------------------------------------------------------
# Boundaries and the grid
# --------------------------------------------------------------------------

def load_boundaries(path: Path | str = BOUNDARY_FILE) -> dict[str, list[Polygon]]:
    """Municipality name -> list of polygons, from the repository GeoJSON."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    result: dict[str, list[Polygon]] = {}
    for feature in data.get("features", []):
        props = feature.get("properties") or {}
        name = props.get("name") or props.get("adm3_en")
        geometry = feature.get("geometry") or {}
        if not name or geometry.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        result[name] = [[[(float(x), float(y)) for x, y in ring] for ring in polygon] for polygon in polygons]
    return result


def point_in_ring(lon: float, lat: float, ring: Sequence[tuple[float, float]]) -> bool:
    """Ray casting. Points exactly on an edge may fall either way."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def point_in_polygon(lon: float, lat: float, polygon: Polygon) -> bool:
    if not polygon or not point_in_ring(lon, lat, polygon[0]):
        return False
    return not any(point_in_ring(lon, lat, hole) for hole in polygon[1:])


def municipality_at(lon: float, lat: float, boundaries: dict[str, list[Polygon]]) -> str | None:
    for name, polygons in boundaries.items():
        if any(point_in_polygon(lon, lat, polygon) for polygon in polygons):
            return name
    return None


def make_grid(boundaries: dict[str, list[Polygon]], spacing_km: float = 1.0) -> list[dict[str, Any]]:
    """
    Regular lon/lat grid; keeps cells whose centre is inside a municipality.
    Cell ids are 'r<row>c<col>' counted from the south-west corner of the bounds.
    """
    if spacing_km <= 0:
        raise ValueError("spacing_km must be positive")
    rings = [ring for polygons in boundaries.values() for polygon in polygons for ring in polygon[:1]]
    if not rings:
        return []
    lons = [x for ring in rings for x, _ in ring]
    lats = [y for ring in rings for _, y in ring]
    min_lon, max_lon, min_lat, max_lat = min(lons), max(lons), min(lats), max(lats)
    mean_lat = (min_lat + max_lat) / 2
    d_lat = spacing_km * 1000 / M_PER_DEG_LAT
    d_lon = spacing_km * 1000 / (M_PER_DEG_LON_EQUATOR * math.cos(math.radians(mean_lat)))

    cells: list[dict[str, Any]] = []
    row = 0
    lat = min_lat + d_lat / 2
    while lat < max_lat:
        col = 0
        lon = min_lon + d_lon / 2
        while lon < max_lon:
            name = municipality_at(lon, lat, boundaries)
            if name:
                cells.append({
                    "id": f"r{row:03d}c{col:03d}",
                    "row": row,
                    "col": col,
                    "latitude": round(lat, 5),
                    "longitude": round(lon, 5),
                    "municipality": name,
                    "spacing_km": spacing_km,
                })
            lon += d_lon
            col += 1
        lat += d_lat
        row += 1
    return cells


# --------------------------------------------------------------------------
# Elevation
# --------------------------------------------------------------------------

def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _fetch_elevation_batch(lats: list[float], lons: list[float]) -> list[Any]:
    import requests

    response = requests.get(
        ELEVATION_URL,
        params={"latitude": ",".join(f"{v:.5f}" for v in lats), "longitude": ",".join(f"{v:.5f}" for v in lons)},
        headers={"User-Agent": USER_AGENT},
        timeout=30,
    )
    response.raise_for_status()
    values = response.json().get("elevation")
    if not isinstance(values, list) or len(values) != len(lats):
        raise ValueError("Elevation API returned an unexpected shape")
    return values


def _short(error: Exception) -> str:
    """Error text without the (very long) request URL."""
    text = str(error)
    return text.split(" for url:")[0][:200]


def fetch_elevations(
    points: Sequence[tuple[float, float]],
    fetch: Callable[[list[float], list[float]], list[Any]] | None = None,
    pause_s: float = 15.0,
    retries: int = 4,
    rate_limit_wait_s: float = 65.0,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[list[float | None], list[str]]:
    """
    Elevation for [(lat, lon), ...] in batches of 100.

    Open-Meteo counts every coordinate toward its free limits (about 600 per
    minute), so batches are paced `pause_s` apart and an HTTP 429 waits
    `rate_limit_wait_s` before retrying. A batch that still fails leaves its
    values as None (never 0) and is reported in the error list.
    """
    fetch = fetch or _fetch_elevation_batch
    values: list[float | None] = []
    errors: list[str] = []
    total = len(points)
    for start in range(0, total, BATCH_SIZE):
        chunk = points[start:start + BATCH_SIZE]
        lats = [p[0] for p in chunk]
        lons = [p[1] for p in chunk]
        result: list[Any] | None = None
        for attempt in range(retries + 1):
            try:
                result = fetch(lats, lons)
                break
            except Exception as error:  # noqa: BLE001
                if attempt == retries:
                    errors.append(f"points {start}-{start + len(chunk) - 1}: {_short(error)}")
                else:
                    limited = "429" in str(error) or "Too Many" in str(error)
                    sleep(rate_limit_wait_s if limited else 3 * (attempt + 1))
        values.extend([_number(v) for v in result] if result is not None else [None] * len(chunk))
        print(f"  elevation {min(start + BATCH_SIZE, total)}/{total}", flush=True)
        if pause_s and start + BATCH_SIZE < total:
            sleep(pause_s)
    return values, errors


# --------------------------------------------------------------------------
# Slope
# --------------------------------------------------------------------------

def compute_slopes(cells: list[dict[str, Any]]) -> None:
    """
    Fill cell['slope_deg'] from elevations of the 4 neighbouring land cells
    (central difference; one-sided at the coast). None when a cell has no
    elevation or no neighbour with elevation. Cells are `spacing_km` apart.
    """
    by_pos = {(c["row"], c["col"]): c.get("elevation_m") for c in cells}

    def at(row: int, col: int) -> float | None:
        return by_pos.get((row, col))

    for cell in cells:
        z = cell.get("elevation_m")
        cell["slope_deg"] = None
        if z is None:
            continue
        step = cell["spacing_km"] * 1000
        r, c = cell["row"], cell["col"]

        def gradient(minus: float | None, plus: float | None) -> float | None:
            if minus is not None and plus is not None:
                return (plus - minus) / (2 * step)
            if plus is not None:
                return (plus - z) / step
            if minus is not None:
                return (z - minus) / step
            return None

        dzdx = gradient(at(r, c - 1), at(r, c + 1))
        dzdy = gradient(at(r - 1, c), at(r + 1, c))
        if dzdx is None and dzdy is None:
            continue
        cell["slope_deg"] = round(math.degrees(math.atan(math.hypot(dzdx or 0.0, dzdy or 0.0))), 3)


# --------------------------------------------------------------------------
# Waterways
# --------------------------------------------------------------------------

Line = list[tuple[float, float]]  # [(lon, lat), ...]


def parse_overpass(data: dict[str, Any]) -> list[Line]:
    """Overpass JSON from a query using `out geom;` -> list of lines."""
    lines: list[Line] = []
    for element in data.get("elements", []):
        geometry = element.get("geometry")
        if element.get("type") == "way" and isinstance(geometry, list) and len(geometry) >= 2:
            line = [(float(p["lon"]), float(p["lat"])) for p in geometry if "lon" in p and "lat" in p]
            if len(line) >= 2:
                lines.append(line)
    return lines


def load_waterways_geojson(path: Path | str) -> list[Line]:
    """LineString / MultiLineString features from a local GeoJSON file."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    lines: list[Line] = []
    for feature in data.get("features", []):
        geometry = feature.get("geometry") or {}
        if geometry.get("type") == "LineString":
            parts = [geometry["coordinates"]]
        elif geometry.get("type") == "MultiLineString":
            parts = geometry["coordinates"]
        else:
            continue
        for part in parts:
            line = [(float(p[0]), float(p[1])) for p in part]
            if len(line) >= 2:
                lines.append(line)
    return lines


def lines_to_geojson(lines: Iterable[Line], source: str) -> dict[str, Any]:
    return {
        "type": "FeatureCollection",
        "metadata": {"source": source},
        "features": [
            {"type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": [list(p) for p in line]}}
            for line in lines
        ],
    }


def fetch_overpass_waterways(bbox: tuple[float, float, float, float], timeout_s: int = 180) -> list[Line]:
    """bbox = (south, west, north, east). One request; be gentle with the public server."""
    import requests

    south, west, north, east = bbox
    query = (
        "[out:json][timeout:120];"
        f'(way["waterway"~"^(river|stream|canal)$"]({south},{west},{north},{east}););'
        "out geom;"
    )
    response = requests.post(OVERPASS_URL, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=timeout_s)
    response.raise_for_status()
    return parse_overpass(response.json())


class _Projector:
    """Local equirectangular projection to metres (fine at Bataan's size)."""

    def __init__(self, lat0: float, lon0: float):
        self.lat0 = lat0
        self.lon0 = lon0
        self.kx = M_PER_DEG_LON_EQUATOR * math.cos(math.radians(lat0))

    def xy(self, lon: float, lat: float) -> tuple[float, float]:
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * M_PER_DEG_LAT)


def sample_river_points(lines: Sequence[Line], step_m: float = 1000.0, max_points: int = 600) -> list[tuple[float, float]]:
    """
    Points (lat, lon) along the waterways about `step_m` apart. If that would
    exceed `max_points`, the step is widened so the elevation requests stay few.
    """
    if not lines:
        return []
    proj = _Projector(lines[0][0][1], lines[0][0][0])
    total = 0.0
    for line in lines:
        for a, b in zip(line, line[1:]):
            ax, ay = proj.xy(*a)
            bx, by = proj.xy(*b)
            total += math.hypot(bx - ax, by - ay)
    step = max(step_m, total / max_points) if total else step_m

    points: list[tuple[float, float]] = []
    for line in lines:
        carry = 0.0
        points.append((line[0][1], line[0][0]))
        for a, b in zip(line, line[1:]):
            ax, ay = proj.xy(*a)
            bx, by = proj.xy(*b)
            length = math.hypot(bx - ax, by - ay)
            if length == 0:
                continue
            distance = step - carry
            while distance <= length:
                t = distance / length
                points.append((a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t))
                distance += step
            carry = (carry + length) % step
    return points


class _SegmentIndex:
    """Nearest-distance queries to many line segments, using 2 km buckets."""

    BUCKET = 2000.0

    def __init__(self, lines: Sequence[Line], proj: _Projector):
        self.proj = proj
        self.buckets: dict[tuple[int, int], list[tuple[float, float, float, float]]] = {}
        for line in lines:
            for a, b in zip(line, line[1:]):
                ax, ay = proj.xy(*a)
                bx, by = proj.xy(*b)
                for key in self._keys(min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)):
                    self.buckets.setdefault(key, []).append((ax, ay, bx, by))

    def _keys(self, x0: float, y0: float, x1: float, y1: float):
        for i in range(int(x0 // self.BUCKET), int(x1 // self.BUCKET) + 1):
            for j in range(int(y0 // self.BUCKET), int(y1 // self.BUCKET) + 1):
                yield (i, j)

    @staticmethod
    def _distance(px: float, py: float, seg: tuple[float, float, float, float]) -> float:
        ax, ay, bx, by = seg
        dx, dy = bx - ax, by - ay
        length_sq = dx * dx + dy * dy
        t = 0.0 if length_sq == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

    def nearest(self, lon: float, lat: float, max_rings: int = 40) -> float | None:
        px, py = self.proj.xy(lon, lat)
        ci, cj = int(px // self.BUCKET), int(py // self.BUCKET)
        best: float | None = None
        for ring in range(max_rings + 1):
            if best is not None and best <= (ring - 1) * self.BUCKET:
                break
            for i in range(ci - ring, ci + ring + 1):
                for j in range(cj - ring, cj + ring + 1):
                    if max(abs(i - ci), abs(j - cj)) != ring:
                        continue
                    for seg in self.buckets.get((i, j), ()):
                        d = self._distance(px, py, seg)
                        if best is None or d < best:
                            best = d
        return best


def apply_river_metrics(
    cells: list[dict[str, Any]],
    lines: Sequence[Line],
    river_points: Sequence[tuple[float, float]],
    river_elevations: Sequence[float | None],
) -> None:
    """
    Fill dist_river_m (to the nearest waterway line) and height_above_river_m
    (cell elevation minus the DEM elevation at the nearest sampled waterway
    point). The second one is a rough HAND-style number: the DEM is 90 m and
    waterway elevations are themselves DEM values. Not clipped: it can be < 0.
    """
    for cell in cells:
        cell["dist_river_m"] = None
        cell["height_above_river_m"] = None
    if not lines or not cells:
        return
    proj = _Projector(cells[0]["latitude"], cells[0]["longitude"])
    index = _SegmentIndex(lines, proj)
    samples = [
        (*proj.xy(lon, lat), z) for (lat, lon), z in zip(river_points, river_elevations) if z is not None
    ]
    for cell in cells:
        d = index.nearest(cell["longitude"], cell["latitude"])
        cell["dist_river_m"] = None if d is None else round(d, 1)
        z = cell.get("elevation_m")
        if z is None or not samples:
            continue
        x, y = proj.xy(cell["longitude"], cell["latitude"])
        nearest = min(samples, key=lambda s: (s[0] - x) ** 2 + (s[1] - y) ** 2)
        cell["height_above_river_m"] = round(z - nearest[2], 1)


# --------------------------------------------------------------------------
# Build and read
# --------------------------------------------------------------------------

def _default_connect() -> sqlite3.Connection:
    from agos_data_lifecycle import _connect  # lazy: needs FastAPI

    return _connect()


def build_terrain(
    spacing_km: float = 1.0,
    waterways: Sequence[Line] | None = None,
    river_source: str | None = None,
    boundaries: dict[str, list[Polygon]] | None = None,
    fetch_elevation: Callable[[Sequence[tuple[float, float]]], tuple[list[float | None], list[str]]] | None = None,
    connect: Callable[[], sqlite3.Connection] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """
    Build (or rebuild) the terrain table. Returns a summary including every
    error. Elevation failures leave NULLs; they never stop the build.
    """
    boundaries = boundaries if boundaries is not None else load_boundaries()
    fetch_elevation = fetch_elevation or fetch_elevations
    connect = connect or _default_connect
    built_at = (now or datetime.now(timezone.utc)).isoformat(timespec="seconds")

    cells = make_grid(boundaries, spacing_km)
    summary: dict[str, Any] = {
        "built_at": built_at, "spacing_km": spacing_km, "cells": len(cells),
        "with_elevation": 0, "with_slope": 0, "with_river": 0, "with_height_above_river": 0,
        "river_lines": len(waterways or []), "errors": [],
    }
    if not cells:
        summary["errors"].append("No grid cells: the boundary file has no polygons.")
        return summary

    values, errors = fetch_elevation([(c["latitude"], c["longitude"]) for c in cells])
    summary["errors"].extend(errors)
    for cell, z in zip(cells, values):
        cell["elevation_m"] = z
    compute_slopes(cells)

    river_points: list[tuple[float, float]] = []
    river_elevations: list[float | None] = []
    if waterways:
        river_points = sample_river_points(waterways)
        river_elevations, river_errors = fetch_elevation(river_points)
        summary["errors"].extend(f"waterway samples: {e}" for e in river_errors)
    apply_river_metrics(cells, waterways or [], river_points, river_elevations)

    summary["with_elevation"] = sum(c["elevation_m"] is not None for c in cells)
    summary["with_slope"] = sum(c["slope_deg"] is not None for c in cells)
    summary["with_river"] = sum(c["dist_river_m"] is not None for c in cells)
    summary["with_height_above_river"] = sum(c["height_above_river_m"] is not None for c in cells)
    summary["river_samples"] = len(river_points)

    connection = connect()
    try:
        init_tables(connection)
        with connection:  # one transaction: all or nothing
            connection.execute("DELETE FROM terrain_cells")
            connection.executemany(
                """INSERT INTO terrain_cells
                   (id, latitude, longitude, municipality, spacing_km, elevation_m, slope_deg,
                    dist_river_m, height_above_river_m, elevation_source, river_source, built_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [
                    (
                        c["id"], c["latitude"], c["longitude"], c["municipality"], c["spacing_km"],
                        c["elevation_m"], c["slope_deg"], c["dist_river_m"], c["height_above_river_m"],
                        ELEVATION_SOURCE if c["elevation_m"] is not None else None,
                        (river_source or "waterways supplied by the user") if c["dist_river_m"] is not None else None,
                        built_at,
                    )
                    for c in cells
                ],
            )
            meta = {
                "built_at": built_at,
                "spacing_km": str(spacing_km),
                "elevation_source": ELEVATION_SOURCE,
                "river_source": (river_source or "waterways supplied by the user") if waterways else "none (river columns are empty)",
                "summary": json.dumps({k: v for k, v in summary.items() if k != "errors"}),
                "errors": json.dumps(summary["errors"]),
                "limits": "Coarse screening layer: 90 m DEM, cells of spacing_km. Not a hazard map, not a flood forecast.",
            }
            connection.executemany(
                "INSERT INTO terrain_meta (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                [(k, v, built_at) for k, v in meta.items()],
            )
    finally:
        connection.close()
    return summary


def terrain_summary(connect: Callable[[], sqlite3.Connection] | None = None) -> dict[str, Any]:
    """What is stored, for /system/status. Never raises for an empty table."""
    connect = connect or _default_connect
    connection = connect()
    try:
        init_tables(connection)
        total = connection.execute("SELECT COUNT(*) FROM terrain_cells").fetchone()[0]
        if not total:
            return {"status": "not_built", "cells": 0}
        row = connection.execute(
            """SELECT COUNT(elevation_m), COUNT(slope_deg), COUNT(dist_river_m), COUNT(height_above_river_m),
                      MIN(elevation_m), MAX(elevation_m), MIN(built_at), MAX(spacing_km)
               FROM terrain_cells"""
        ).fetchone()
        meta = dict(connection.execute("SELECT key, value FROM terrain_meta").fetchall())
        return {
            "status": "ok",
            "cells": total,
            "with_elevation": row[0], "with_slope": row[1], "with_river": row[2], "with_height_above_river": row[3],
            "elevation_range_m": [row[4], row[5]],
            "built_at": row[6],
            "spacing_km": row[7],
            "elevation_source": meta.get("elevation_source"),
            "river_source": meta.get("river_source"),
        }
    finally:
        connection.close()
