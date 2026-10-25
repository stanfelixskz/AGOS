"""
Build AGOS static terrain cells (elevation, slope, river distance).

Run from the backend folder, with the virtual environment active:

    python tools/build_terrain.py --check
    python tools/build_terrain.py --spacing-km 1 --overpass
    python tools/build_terrain.py --waterways path/to/rivers.geojson

--check    only tests that the Open-Meteo Elevation API and Overpass answer;
           writes nothing.
--overpass download river/stream/canal lines from OpenStreetMap (one request)
           and save them to backend/data/waterways_osm.geojson for reuse.
--waterways use a local LineString GeoJSON instead of the internet.
Without either, elevation and slope are built and the river columns stay empty.

Safe to run again: the terrain table is replaced in one transaction.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.services import terrain_service as ts  # noqa: E402


def check() -> int:
    ok = True
    try:
        values = ts._fetch_elevation_batch([14.68], [120.54])
        print(f"Elevation API: OK (Balanga area test point = {values[0]} m)")
    except Exception as error:  # noqa: BLE001
        ok = False
        print(f"Elevation API: FAILED - {error}")
    try:
        lines = ts.fetch_overpass_waterways((14.66, 120.52, 14.70, 120.56), timeout_s=90)
        print(f"Overpass API: OK ({len(lines)} waterway lines in a small test box)")
    except Exception as error:  # noqa: BLE001
        ok = False
        print(f"Overpass API: FAILED - {error}")
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--spacing-km", type=float, default=1.0)
    parser.add_argument("--overpass", action="store_true")
    parser.add_argument("--waterways", type=Path)
    args = parser.parse_args()

    if args.check:
        return check()

    lines, source = None, None
    cache = BACKEND / "data" / "waterways_osm.geojson"
    if args.waterways:
        lines = ts.load_waterways_geojson(args.waterways)
        source = f"local file {args.waterways.name}"
    elif args.overpass:
        boundaries = ts.load_boundaries()
        xs = [x for polys in boundaries.values() for p in polys for x, _ in p[0]]
        ys = [y for polys in boundaries.values() for p in polys for _, y in p[0]]
        lines = ts.fetch_overpass_waterways((min(ys), min(xs), max(ys), max(xs)))
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(ts.lines_to_geojson(lines, ts.OVERPASS_SOURCE)), encoding="utf-8")
        source = ts.OVERPASS_SOURCE
        print(f"Saved {len(lines)} waterway lines to {cache}")

    summary = ts.build_terrain(spacing_km=args.spacing_km, waterways=lines, river_source=source)
    for key, value in summary.items():
        if key != "errors":
            print(f"{key}: {value}")
    if summary["errors"]:
        print("ERRORS (values left empty, nothing invented):")
        for error in summary["errors"]:
            print(" -", error)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
