"""
Check whether Open-Meteo's Marine API gives usable sea-level (tide) data for the Bataan coast.
Read-only: prints what came back, writes nothing. Run from backend/:  python tools/check_marine.py
Sea level here is modeled (global ocean model), not a tide gauge.
"""

import json
import urllib.error
import urllib.parse
import urllib.request

POINTS = {"Manila Bay side (Orion)": (14.62, 120.58)}
RANGES = [("recent", {"past_days": 3, "forecast_days": 1})] + [
    (str(y), {"start_date": f"{y}-08-01", "end_date": f"{y}-08-03"}) for y in range(2026, 2009, -1)
]


def fetch(lat, lon, extra):
    query = {"latitude": lat, "longitude": lon, "hourly": "sea_level_height_msl", **extra}
    url = "https://marine-api.open-meteo.com/v1/marine?" + urllib.parse.urlencode(query)
    try:
        with urllib.request.urlopen(url, timeout=40) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        return {"error": f"HTTP {error.code}: {error.read()[:200]!r}"}
    except Exception as error:  # report, never crash
        return {"error": str(error)[:200]}


def main():
    for name, (lat, lon) in POINTS.items():
        for label, extra in RANGES:
            data = fetch(lat, lon, extra)
            values = (data.get("hourly") or {}).get("sea_level_height_msl") or []
            real = [v for v in values if v is not None]
            if "error" in data or not real:
                print(f"{name} | {label}: NO DATA ({data.get('error') or data.get('reason') or 'all values empty'})")
            else:
                print(f"{name} | {label}: {len(real)}/{len(values)} hourly values, min {min(real):.2f} m, max {max(real):.2f} m")


if __name__ == "__main__":
    main()
