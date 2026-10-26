"""
Can AGOS read the DENR-MGB flood susceptibility map as numbers?

The map page already shows the MGB "Detailed Flood Susceptibility" map as picture
tiles. To summarise it per town and barangay, AGOS must ask the MGB map server
"which class is this point?". This script checks, read-only, whether that works:

1. service information (description, copyright / terms text, capabilities, layers)
2. the fields of each layer
3. "identify" at a few test points (lowland town centres, a mountain, the sea)
4. a "query" at one point, as a second method

It writes nothing to the database. About 12 requests. Paste the whole output back.
Run from backend/:  python tools/check_mgb_susceptibility.py
"""

import json
import urllib.error
import urllib.parse
import urllib.request

SERVICE = ("https://controlmap.mgb.gov.ph/arcgis/rest/services/GeospatialDataInventory_Public/"
           "GDI_Detailed_Flood_Susceptibility_Public/MapServer")

# Town points are the AGOS reference points (app/data/municipalities.py); the last two are contrasts.
POINTS = [
    ("Hermosa town point", 14.8319, 120.5087),
    ("Balanga town point", 14.6760, 120.5363),
    ("Orani town point", 14.8006, 120.5378),
    ("Mt. Natib slope (expect low or none)", 14.7150, 120.4000),
    ("Manila Bay water (expect none)", 14.6000, 120.6300),
]


def get(path, params=None):
    url = SERVICE + path + "?" + urllib.parse.urlencode({**(params or {}), "f": "json"})
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        return {"error": f"HTTP {error.code}: {error.read()[:200]!r}"}
    except Exception as error:  # report, never crash
        return {"error": str(error)[:200]}


def short(value, n=300):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= n else text[:n] + " ..."


def main():
    print("== 1. Service ==")
    info = get("")
    if "error" in info:
        print("ERROR", info["error"])
        return
    for key in ("serviceDescription", "description", "copyrightText", "capabilities", "supportedQueryFormats",
                "singleFusedMapCache", "spatialReference", "currentVersion"):
        if info.get(key) not in (None, ""):
            print(f"{key}: {short(info[key])}")
    layers = info.get("layers") or []
    print("layers:", short([(lyr.get("id"), lyr.get("name")) for lyr in layers], 600))

    print("\n== 2. Layer fields ==")
    for lyr in layers[:6]:
        detail = get(f"/{lyr['id']}")
        if "error" in detail:
            print(f"layer {lyr['id']}: ERROR {detail['error']}")
            continue
        fields = [(f.get("name"), f.get("alias")) for f in detail.get("fields") or []]
        print(f"layer {lyr['id']} '{detail.get('name')}' type={detail.get('type')} geometry={detail.get('geometryType')} "
              f"capabilities={detail.get('capabilities')}")
        print("   fields:", short(fields, 500))
        if detail.get("drawingInfo", {}).get("renderer", {}).get("uniqueValueInfos"):
            values = [(u.get("value"), u.get("label")) for u in detail["drawingInfo"]["renderer"]["uniqueValueInfos"]]
            print("   classes:", short(values, 400))

    print("\n== 3. Identify at test points ==")
    for name, lat, lon in POINTS:
        result = get("/identify", {
            "geometry": json.dumps({"x": lon, "y": lat}),
            "geometryType": "esriGeometryPoint",
            "sr": 4326,
            "layers": "all",
            "tolerance": 0,
            "mapExtent": f"{lon - 0.01},{lat - 0.01},{lon + 0.01},{lat + 0.01}",
            "imageDisplay": "100,100,96",
            "returnGeometry": "false",
        })
        if "error" in result:
            print(f"{name}: ERROR {result['error']}")
            continue
        hits = result.get("results") or []
        if not hits:
            print(f"{name}: no class at this point")
        for hit in hits[:3]:
            print(f"{name}: layer '{hit.get('layerName')}' -> {short(hit.get('attributes'), 250)}")

    print("\n== 4. Query (second method) at the Hermosa point ==")
    name, lat, lon = POINTS[0]
    for lyr in layers[:3]:
        result = get(f"/{lyr['id']}/query", {
            "geometry": f"{lon},{lat}",
            "geometryType": "esriGeometryPoint",
            "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "*",
            "returnGeometry": "false",
        })
        if "error" in result:
            print(f"layer {lyr['id']}: ERROR {result['error']}")
        else:
            features = result.get("features") or []
            print(f"layer {lyr['id']}: {len(features)} feature(s) {short([f.get('attributes') for f in features[:2]], 300)}")


if __name__ == "__main__":
    main()
