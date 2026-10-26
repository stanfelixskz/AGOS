"""
Build the per-barangay flood susceptibility file from the official DENR-MGB map.

    python tools/build_mgb_susceptibility.py                       # download from MGB (1 request)
    python tools/build_mgb_susceptibility.py --mgb-file data/mgb_bataan_check.geojson
    python tools/build_mgb_susceptibility.py --step-m 200          # sampling spacing (default 200 m)

Reads the MGB "Detailed Flood Susceptibility" shapes over Bataan (simplified to
about 20 m) and the 237 barangay shapes in frontend/app/data/, samples points
every --step-m metres inside each barangay, and writes
app/data/mgb_susceptibility_bataan.json (small: counts per class per barangay).
Takes a few minutes. Nothing is invented: unsampled barangays are listed as such.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services import susceptibility_service as ss  # noqa: E402

LAYER = ("https://controlmap.mgb.gov.ph/arcgis/rest/services/GeospatialDataInventory_Public/"
         "GDI_Detailed_Flood_Susceptibility_Public/MapServer/0/query")
BATAAN_BBOX = (120.24, 14.38, 120.66, 14.98)
BARANGAYS = ROOT.parent / "frontend" / "app" / "data" / "bataan-barangays-psgc2026q3.geojson"
SOURCE = ("DENR Mines and Geosciences Bureau, Detailed Flood Susceptibility "
          "(controlmap.mgb.gov.ph, GDI_Detailed_Flood_Susceptibility_Public MapServer layer 0, field FloodSusc); "
          "shapes downloaded {fetched} and simplified to about 20 m")


def download() -> dict:
    params = {
        "geometry": ",".join(str(v) for v in BATAAN_BBOX), "geometryType": "esriGeometryEnvelope", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "outFields": "OBJECTID,FloodSusc", "returnGeometry": "true",
        "outSR": 4326, "maxAllowableOffset": 0.0002, "geometryPrecision": 5, "f": "geojson",
    }
    with urllib.request.urlopen(LAYER + "?" + urllib.parse.urlencode(params), timeout=300) as response:
        return json.load(response)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mgb-file", help="use a saved MGB GeoJSON instead of downloading")
    parser.add_argument("--step-m", type=float, default=200.0)
    args = parser.parse_args()

    if args.mgb_file:
        path = Path(args.mgb_file)
        mgb = json.loads(path.read_text(encoding="utf-8"))
        fetched = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).date().isoformat()
    else:
        print("Downloading MGB shapes over Bataan ...", flush=True)
        mgb = download()
        fetched = datetime.now(timezone.utc).date().isoformat()
    if mgb.get("exceededTransferLimit") or (mgb.get("properties") or {}).get("exceededTransferLimit"):
        print("STOP: the MGB server cut the answer short (exceededTransferLimit). Nothing written.")
        return 1
    codes = sorted({(f.get("properties") or {}).get("FloodSusc") for f in mgb.get("features", [])})
    print(f"MGB shapes: {len(mgb.get('features', []))} ({', '.join(str(c) for c in codes)})", flush=True)

    barangays = json.loads(BARANGAYS.read_text(encoding="utf-8"))
    start = time.time()
    rows = ss.build(mgb, barangays, step_m=args.step_m)
    out = {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "step_m": args.step_m,
        "source": SOURCE.format(fetched=fetched),
        "barangays_source": barangays.get("source"),
        "classes": {"VHF": "very_high", "HF": "high", "MF": "moderate", "LF": "low", "none": "not_rated"},
        "barangays": rows,
    }
    ss.DATA_FILE.write_text(json.dumps(out, indent=1), encoding="utf-8")
    unsampled = [r["barangay"] for r in rows if not r["samples"]]
    print(f"Wrote {ss.DATA_FILE} ({len(rows)} barangays, {time.time() - start:.0f} s). "
          f"Unsampled (smaller than the grid): {len(unsampled)} {unsampled}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
