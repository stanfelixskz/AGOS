"""
How big are the MGB flood susceptibility shapes over Bataan?

Second read-only check (after check_mgb_susceptibility.py). It asks the MGB map
server for the shapes that touch Bataan's bounding box: first only how many,
then the shapes themselves, simplified (about 20-30 m), to see their size.
Nothing is stored except one temporary file in backend/data/ (git-ignored) that
the next step can reuse. 3-4 requests. Paste the output back.

Run from backend/:  python tools/check_mgb_polygons.py
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

LAYER = ("https://controlmap.mgb.gov.ph/arcgis/rest/services/GeospatialDataInventory_Public/"
         "GDI_Detailed_Flood_Susceptibility_Public/MapServer/0/query")
BATAAN_BBOX = (120.24, 14.38, 120.66, 14.98)  # west, south, east, north (degrees), a little wider than Bataan
OUT = Path(__file__).resolve().parents[1] / "data" / "mgb_bataan_check.geojson"


def query(extra):
    params = {
        "geometry": ",".join(str(v) for v in BATAAN_BBOX),
        "geometryType": "esriGeometryEnvelope",
        "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects",
        **extra,
    }
    url = LAYER + "?" + urllib.parse.urlencode(params)
    start = time.time()
    try:
        with urllib.request.urlopen(url, timeout=180) as response:
            body = response.read()
        return body, time.time() - start, None
    except urllib.error.HTTPError as error:
        return None, time.time() - start, f"HTTP {error.code}: {error.read()[:200]!r}"
    except Exception as error:  # report, never crash
        return None, time.time() - start, str(error)[:200]


def main():
    body, secs, err = query({"returnCountOnly": "true", "f": "json"})
    print("1. shapes touching Bataan:", err or json.loads(body).get("count"), f"({secs:.1f} s)")

    body, secs, err = query({"outFields": "OBJECTID,FloodSusc", "returnGeometry": "false", "f": "json"})
    if err:
        print("2. classes: ERROR", err)
    else:
        feats = json.loads(body).get("features") or []
        print("2. shapes and classes:", [(f["attributes"].get("OBJECTID"), f["attributes"].get("FloodSusc")) for f in feats][:40])

    body, secs, err = query({
        "outFields": "OBJECTID,FloodSusc", "returnGeometry": "true", "outSR": 4326,
        "maxAllowableOffset": 0.0002, "geometryPrecision": 5, "f": "geojson",
    })
    if err:
        print("3. simplified shapes: ERROR", err, f"({secs:.1f} s)")
        return
    data = json.loads(body)
    feats = data.get("features") or []
    vertices = 0
    for f in feats:
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if geom.get("type") == "Polygon":
            vertices += sum(len(ring) for ring in coords)
        elif geom.get("type") == "MultiPolygon":
            vertices += sum(len(ring) for poly in coords for ring in poly)
    print(f"3. simplified shapes: {len(feats)} features, {vertices:,} points, {len(body) / 1e6:.1f} MB, {secs:.1f} s,"
          f" exceededTransferLimit={data.get('exceededTransferLimit') or data.get('properties', {}).get('exceededTransferLimit')}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(body)
    print(f"   saved to {OUT} (git-ignored, for the next step)")


if __name__ == "__main__":
    main()
