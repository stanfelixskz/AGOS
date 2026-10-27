"""
Fetch Bataan's rivers, streams and canals from OpenStreetMap (Overpass API), keeping their
names and types, and save them to backend/data/waterways_osm_tagged.geojson (git-ignored).

Run from backend/, venv active:

    python tools/fetch_rivers.py                    # one Overpass request (retries a few times)
    python tools/fetch_rivers.py --from-json FILE   # convert an Overpass answer already saved (no network)
    python tools/fetch_rivers.py --check            # read the saved file and print what the API would show

The public Overpass server is shared: this makes one request, and only retries (40 s apart) when
it answers with a gateway error. Data: (c) OpenStreetMap contributors, ODbL.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.services import rivers_service as rs  # noqa: E402
from app.services import terrain_service as ts  # noqa: E402

BBOX = (14.42, 120.236, 14.937, 120.627)  # south, west, north, east: a little wider than Bataan
QUERY = '[out:json][timeout:120];(way["waterway"~"^(river|stream|canal)$"]({s},{w},{n},{e}););out geom tags;'
RETRIES = 3
PAUSE_S = 40


def fetch(bbox=BBOX) -> dict:
    import requests

    south, west, north, east = bbox
    query = QUERY.format(s=south, w=west, n=north, e=east)
    for attempt in range(1, RETRIES + 1):
        response = requests.post(ts.OVERPASS_URL, data={"data": query}, headers={"User-Agent": ts.USER_AGENT}, timeout=180)
        print(f"attempt {attempt}: HTTP {response.status_code}")
        if response.status_code == 200:
            return response.json()
        if response.status_code not in (429, 502, 503, 504) or attempt == RETRIES:
            response.raise_for_status()
        time.sleep(PAUSE_S)
    raise RuntimeError("Overpass did not answer")


def save(payload: dict) -> Path:
    features = rs.parse_overpass(payload)
    metadata = {
        "source": rs.SOURCE,
        "license": rs.LICENSE,
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "osm_data_timestamp": (payload.get("osm3s") or {}).get("timestamp_osm_base"),
        "bbox_south_west_north_east": list(BBOX),
    }
    rs.DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    rs.DATA_FILE.write_text(json.dumps(rs.features_to_geojson(features, metadata)), encoding="utf-8")
    named = sum(1 for f in features if f["name"])
    print(f"saved {len(features)} lines ({named} with a name) to {rs.DATA_FILE}")
    return rs.DATA_FILE


def check() -> int:
    report = rs.build_report()
    if not report["available"]:
        print("NOT AVAILABLE:", report["reason"])
        return 1
    stats = report["stats"]
    print(f"data from OpenStreetMap as of {report['osm_data_timestamp']} (fetched {report['fetched_at']})")
    print(f"lines kept {stats['features']} (dropped outside Bataan: {stats['outside_bataan_dropped']}), "
          f"named {stats['named']} ({stats['named_share']:.0%}), by type {stats['by_type']}")
    print(f"points {stats['points_before']:,} -> {stats['points_after']:,} at {stats['tolerance_m']:.0f} m")
    print(f"{'town':<13}{'km':>7}  named waterways")
    for town in report["towns"]:
        print(f"{town['name']:<13}{town['length_km']:>7.1f}  {', '.join(town['rivers']) or '-'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from-json", help="an Overpass answer saved earlier")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check()
    payload = json.loads(Path(args.from_json).read_text(encoding="utf-8")) if args.from_json else fetch()
    save(payload)
    return check()


if __name__ == "__main__":
    raise SystemExit(main())
