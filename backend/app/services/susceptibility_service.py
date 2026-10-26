"""
AGOS — static flood-susceptibility inputs per municipality.

Summarises layers that do not change with the weather, for the flood-risk
indicator (flood_risk_service):

  low_ground_share  share of the town's terrain cells that are low ground:
                    at or below LOW_LYING_M, or at or below LOW_NEAR_RIVER_M
                    and within NEAR_RIVER_M of a mapped waterway
                    (Copernicus DEM GLO-90 + OpenStreetMap, via terrain_service).
                    Distance alone is not used: small mountain streams put
                    most of every town near some waterway.
  mgb_high_share    share of sample points rated High or Very High flood
                    susceptibility on the DENR-MGB detailed map
  coastal           the town boundary is within COAST_BUFFER_M of the
                    OpenStreetMap coastline

Sample points come from tools/build_susceptibility.py (MGB queries are paced
and run once, then stored). Nothing is invented: a layer that has not been
built is reported as missing, and shares are only given when enough cells or
samples exist.
"""

from __future__ import annotations

import json
import math
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

from app.services import terrain_service as ts

MGB_LAYER_URL = (
    "https://controlmap.mgb.gov.ph/arcgis/rest/services/GeospatialDataInventory_Public/"
    "GDI_Detailed_Flood_Susceptibility_Public/MapServer/0/query"
)
MGB_SOURCE = "DENR-MGB Detailed Flood Susceptibility (public map service)"
MGB_RATINGS = {"VHF": "very_high", "HF": "high", "MF": "moderate", "LF": "low"}
COAST_SOURCE = "OpenStreetMap coastline via Overpass API (© OpenStreetMap contributors, ODbL)"
COAST_FILE = Path(__file__).resolve().parents[2] / "data" / "coastline_osm.geojson"

LOW_LYING_M = 5.0
LOW_NEAR_RIVER_M = 10.0
NEAR_RIVER_M = 300.0
COAST_BUFFER_M = 1000.0
MIN_CELLS = 5
MIN_SAMPLES = 3

SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS mgb_samples (
        id TEXT PRIMARY KEY,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        municipality TEXT NOT NULL,
        rating TEXT,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        sampled_at TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_mgb_municipality ON mgb_samples(municipality)",
)


def init_tables(connection: sqlite3.Connection) -> None:
    for statement in SCHEMA:
        connection.execute(statement)
    ts.init_tables(connection)


# ------------------------------------------------------------------ MGB
def fetch_mgb_rating(lat: float, lon: float, session: Any = None) -> str | None:
    """MGB rating code at a point (VHF/HF/MF/LF), or None when no polygon covers it."""
    import requests

    session = session or requests
    response = session.get(MGB_LAYER_URL, params={
        "f": "json", "geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "outFields": "FloodSusc", "returnGeometry": "false",
    }, headers={"User-Agent": ts.USER_AGENT}, timeout=40)
    response.raise_for_status()
    data = response.json()
    if "error" in data:
        raise RuntimeError(f"MGB service error: {data['error'].get('message', 'unknown')}")
    codes = [str((f.get("attributes") or {}).get("FloodSusc") or "").strip().upper() for f in data.get("features", [])]
    codes = [c for c in codes if c in MGB_RATINGS]
    if not codes:
        return None
    order = ["VHF", "HF", "MF", "LF"]  # overlapping polygons: keep the most susceptible
    return min(codes, key=order.index)


def sample_cells(cells: Sequence[dict], every: int = 2) -> list[dict]:
    """Every n-th row and column of the terrain grid (every=2 on a 1 km grid -> 2 km)."""
    picked = []
    for cell in cells:
        row, col = int(cell["id"][1:4]), int(cell["id"][5:8])
        if row % every == 0 and col % every == 0:
            picked.append(cell)
    return picked


def build_mgb_samples(
    every: int = 2,
    pause_s: float = 0.6,
    fetch: Callable[[float, float], str | None] = fetch_mgb_rating,
    connect: Callable[[], sqlite3.Connection] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """Query MGB at a subset of terrain cells and store the ratings (replaces the table)."""
    connect = connect or ts._default_connect
    connection = connect()
    try:
        init_tables(connection)
        cells = [dict(r) for r in connection.execute("SELECT id, latitude, longitude, municipality FROM terrain_cells")]
    finally:
        connection.close()
    if not cells:
        return {"samples": 0, "errors": ["The terrain table is empty: run tools/build_terrain.py first."]}

    picked = sample_cells(cells, every)
    sampled_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows, errors = [], []
    for index, cell in enumerate(picked):
        try:
            rating = fetch(cell["latitude"], cell["longitude"])
            status = "rated" if rating else "not_mapped"
        except Exception as error:  # noqa: BLE001 - one failed point must not stop the build
            rating, status = None, "error"
            if len(errors) < 10:
                errors.append(f"{cell['id']}: {type(error).__name__}")
        rows.append((cell["id"], cell["latitude"], cell["longitude"], cell["municipality"], rating, status, MGB_SOURCE, sampled_at))
        if progress:
            progress(index + 1, len(picked))
        sleep(pause_s)

    connection = connect()
    try:
        init_tables(connection)
        with connection:
            connection.execute("DELETE FROM mgb_samples")
            connection.executemany("INSERT INTO mgb_samples VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
    finally:
        connection.close()
    counts = {s: sum(1 for r in rows if r[5] == s) for s in ("rated", "not_mapped", "error")}
    return {"samples": len(rows), **counts, "errors": errors}


# ------------------------------------------------------------------ coastline
def fetch_coastline(bbox: tuple[float, float, float, float], timeout_s: int = 180) -> list[list[tuple[float, float]]]:
    import requests

    south, west, north, east = bbox
    query = f'[out:json][timeout:120];(way["natural"="coastline"]({south},{west},{north},{east}););out geom;'
    response = requests.post(ts.OVERPASS_URL, data={"data": query}, headers={"User-Agent": ts.USER_AGENT}, timeout=timeout_s)
    response.raise_for_status()
    return ts.parse_overpass(response.json())


def load_coastline(path: Path = COAST_FILE) -> list[list[tuple[float, float]]] | None:
    if not path.exists():
        return None
    return ts.load_waterways_geojson(path)


def coastal_towns(boundaries: dict, coastline: Sequence[Sequence[tuple[float, float]]], buffer_m: float = COAST_BUFFER_M) -> dict[str, bool]:
    """A town is coastal when any vertex of its outline is within buffer_m of a coastline vertex."""
    lat0 = sum(y for polys in boundaries.values() for p in polys for _, y in p[0][:1]) / max(1, len(boundaries))
    kx = ts.M_PER_DEG_LON_EQUATOR * math.cos(math.radians(lat0))
    ky = ts.M_PER_DEG_LAT
    # Points every ~250 m along each coastline segment, so long straight segments are not missed.
    coast = []
    for line in coastline:
        for (x1, y1), (x2, y2) in zip(line, line[1:]):
            ax, ay, bx_, by_ = x1 * kx, y1 * ky, x2 * kx, y2 * ky
            steps = max(1, int(math.hypot(bx_ - ax, by_ - ay) // 250))
            coast.extend((ax + (bx_ - ax) * k / steps, ay + (by_ - ay) * k / steps) for k in range(steps + 1))
    cell = buffer_m
    buckets: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for x, y in coast:
        buckets.setdefault((int(x // cell), int(y // cell)), []).append((x, y))
    def outline_points(ring):
        """Points every ~250 m along a town outline (outline vertices can be far apart)."""
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            ax, ay, bx_, by_ = x1 * kx, y1 * ky, x2 * kx, y2 * ky
            steps = max(1, int(math.hypot(bx_ - ax, by_ - ay) // 250))
            for k in range(steps + 1):
                yield ax + (bx_ - ax) * k / steps, ay + (by_ - ay) * k / steps

    result = {}
    for name, polygons in boundaries.items():
        hit = False
        for polygon in polygons:
            for x, y in outline_points(polygon[0]):
                bx, by = int(x // cell), int(y // cell)
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        for cx, cy in buckets.get((bx + dx, by + dy), ()):
                            if (cx - x) ** 2 + (cy - y) ** 2 <= buffer_m ** 2:
                                hit = True
                                break
                        if hit:
                            break
                    if hit:
                        break
                if hit:
                    break
            if hit:
                break
        result[name] = hit
    return result


# ------------------------------------------------------------------ summary
def _share(values: list[bool]) -> float | None:
    return round(sum(values) / len(values), 3) if values else None


def town_summaries(connect: Callable[[], sqlite3.Connection] | None = None, boundaries: dict | None = None) -> dict[str, Any]:
    """Per-town static shares from the stored layers. Missing layers stay None, with a note."""
    connect = connect or ts._default_connect
    connection = connect()
    try:
        init_tables(connection)
        cells = [dict(r) for r in connection.execute(
            "SELECT municipality, elevation_m, dist_river_m FROM terrain_cells")]
        samples = [dict(r) for r in connection.execute(
            "SELECT municipality, rating, status FROM mgb_samples")]
        built = connection.execute("SELECT value FROM terrain_meta WHERE key = 'built_at'").fetchone()
        sampled = connection.execute("SELECT MAX(sampled_at) FROM mgb_samples").fetchone()
    finally:
        connection.close()

    coastline = load_coastline()
    coastal = coastal_towns(boundaries or ts.load_boundaries(), coastline) if coastline else {}

    towns: dict[str, dict[str, Any]] = {}
    names = {c["municipality"] for c in cells} | {s["municipality"] for s in samples} | set(coastal)
    for name in names:
        own = [c for c in cells if c["municipality"] == name]
        measured = [c for c in own if c["elevation_m"] is not None]
        low_ground = [
            c["elevation_m"] <= LOW_LYING_M
            or (c["elevation_m"] <= LOW_NEAR_RIVER_M and c["dist_river_m"] is not None and c["dist_river_m"] <= NEAR_RIVER_M)
            for c in measured
        ]
        rated = [s for s in samples if s["municipality"] == name and s["status"] in ("rated", "not_mapped")]
        towns[name] = {
            "cells": len(own),
            "low_ground_share": _share(low_ground) if len(low_ground) >= MIN_CELLS else None,
            "mgb_samples": len(rated),
            "mgb_high_share": _share([s["rating"] in ("HF", "VHF") for s in rated]) if len(rated) >= MIN_SAMPLES else None,
            "coastal": coastal.get(name) if coastline else None,
        }
    return {
        "towns": towns,
        "terrain_built_at": built[0] if built else None,
        "mgb_sampled_at": sampled[0] if sampled and sampled[0] else None,
        "coastline_available": coastline is not None,
        "sources": {
            "terrain": ts.ELEVATION_SOURCE, "rivers": ts.OVERPASS_SOURCE, "mgb": MGB_SOURCE, "coast": COAST_SOURCE,
        },
        "rules": {"low_lying_m": LOW_LYING_M, "low_near_river_m": LOW_NEAR_RIVER_M, "near_river_m": NEAR_RIVER_M, "coast_buffer_m": COAST_BUFFER_M},
    }
