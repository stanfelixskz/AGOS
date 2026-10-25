"""
Which weather model is behind the AGOS rain record?

AGOS fetches daily rain from the Open-Meteo Historical Weather API with its
default model ("best_match"). Open-Meteo says best_match "combines IFS HRES,
ERA5 and ERA5-Land", and that data from 2017 onward uses newer 9 km models.
If the record switches model around 2017, older and newer years are not
measured the same way, which matters for ranks, return levels and trends.

This script asks, for one town point and one month in several years, for
best_match, ERA5 and ECMWF IFS side by side, and prints which one best_match
matches. It also checks how many of the last 7 days each model already has.
Read-only: it writes nothing. About 9 requests.

Run from backend/:  python tools/check_archive_models.py
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta

URL = "https://archive-api.open-meteo.com/v1/archive"
POINT = ("Balanga", 14.6769, 120.5361)
YEARS = [1995, 2005, 2015, 2016, 2017, 2018, 2020, 2024]
MODELS = ["best_match", "era5", "ecmwf_ifs"]


def fetch(start, end):
    query = {
        "latitude": POINT[1], "longitude": POINT[2],
        "start_date": start, "end_date": end,
        "daily": "precipitation_sum", "models": ",".join(MODELS),
        "timezone": "Asia/Manila",
    }
    try:
        with urllib.request.urlopen(URL + "?" + urllib.parse.urlencode(query), timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        return {"error": f"HTTP {error.code}: {error.read()[:200]!r}"}
    except Exception as error:  # report, never crash
        return {"error": str(error)[:200]}


def series(data, model):
    daily = data.get("daily") or {}
    return daily.get(f"precipitation_sum_{model}") or []


def main():
    print(f"Point: {POINT[0]} ({POINT[1]}, {POINT[2]}); month: August")
    for year in YEARS:
        data = fetch(f"{year}-08-01", f"{year}-08-31")
        if "error" in data:
            print(f"{year}: ERROR {data['error']}")
            continue
        sums, diffs = {}, {}
        best = series(data, "best_match")
        for model in MODELS:
            values = series(data, model)
            real = [v for v in values if v is not None]
            sums[model] = f"{sum(real):.0f} mm ({len(real)}/{len(values)} d)" if real else "no data"
            if model != "best_match" and real and best:
                pairs = [(a, b) for a, b in zip(best, values) if a is not None and b is not None]
                diffs[model] = sum(abs(a - b) for a, b in pairs) / len(pairs) if pairs else None
        match = [m for m, d in diffs.items() if d is not None and d < 0.05]
        print(f"{year}: best_match {sums['best_match']} | era5 {sums['era5']} | ecmwf_ifs {sums['ecmwf_ifs']} "
              f"-> best_match equals: {', '.join(match) if match else 'neither (mixed or different)'}")

    today = date.today()
    data = fetch((today - timedelta(days=7)).isoformat(), (today - timedelta(days=1)).isoformat())
    if "error" in data:
        print(f"last 7 days: ERROR {data['error']}")
        return
    for model in MODELS:
        values = series(data, model)
        print(f"last 7 days, {model}: {sum(v is not None for v in values)}/{len(values)} days have a value")


if __name__ == "__main__":
    main()
