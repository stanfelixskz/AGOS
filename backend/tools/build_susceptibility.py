"""
Build AGOS static susceptibility layers for the flood-risk indicator.

Run from the backend folder, with the virtual environment active, AFTER
tools/build_terrain.py (the MGB samples are taken at terrain cells):

    python tools/build_susceptibility.py
    python tools/build_susceptibility.py --every 2 --pause 0.6

It does two things, once:
  1. downloads the OpenStreetMap coastline around Bataan (one Overpass
     request) to backend/data/coastline_osm.geojson;
  2. asks the DENR-MGB flood susceptibility map service for the rating at
     every n-th terrain cell (default: every 2nd row and column = 2 km),
     pausing between requests, and stores the answers in mgb_samples.

Safe to run again: the samples table is replaced in one transaction.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.services import susceptibility_service as ss  # noqa: E402
from app.services import terrain_service as ts  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--every", type=int, default=2, help="sample every n-th terrain row and column")
    parser.add_argument("--pause", type=float, default=0.6, help="seconds between MGB requests")
    parser.add_argument("--skip-coast", action="store_true")
    parser.add_argument("--skip-mgb", action="store_true")
    args = parser.parse_args()
    failed = False

    if not args.skip_coast:
        boundaries = ts.load_boundaries()
        xs = [x for polys in boundaries.values() for p in polys for x, _ in p[0]]
        ys = [y for polys in boundaries.values() for p in polys for _, y in p[0]]
        pad = 0.05
        try:
            lines = ss.fetch_coastline((min(ys) - pad, min(xs) - pad, max(ys) + pad, max(xs) + pad))
            ss.COAST_FILE.parent.mkdir(parents=True, exist_ok=True)
            ss.COAST_FILE.write_text(json.dumps(ts.lines_to_geojson(lines, ss.COAST_SOURCE)), encoding="utf-8")
            coastal = ss.coastal_towns(boundaries, lines)
            print(f"Coastline: {len(lines)} lines saved to {ss.COAST_FILE}")
            print("Coastal towns:", ", ".join(sorted(n for n, c in coastal.items() if c)) or "none")
            print("Inland towns:", ", ".join(sorted(n for n, c in coastal.items() if not c)) or "none")
        except Exception as error:  # noqa: BLE001
            failed = True
            print(f"Coastline download failed ({type(error).__name__}); coastal status stays unknown.")

    if not args.skip_mgb:
        def progress(done: int, total: int) -> None:
            if done % 25 == 0 or done == total:
                print(f"  MGB {done}/{total}", flush=True)

        summary = ss.build_mgb_samples(every=args.every, pause_s=args.pause, progress=progress)
        for key, value in summary.items():
            if key != "errors":
                print(f"{key}: {value}")
        if summary["errors"]:
            failed = True
            print("ERRORS (points left without a rating, nothing invented):")
            for error in summary["errors"]:
                print(" -", error)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
