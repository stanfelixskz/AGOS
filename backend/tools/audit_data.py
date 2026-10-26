"""
Live data audit for AGOS: checks that every page shows consistent, sane
numbers computed from today's real data. Run from the backend folder with
the backend running (default http://127.0.0.1:8000):

    python tools/audit_data.py
    python tools/audit_data.py http://127.0.0.1:8000

Prints one line per check and a summary; exit code 1 if any check fails.
"""

from __future__ import annotations

import math
import sys
import time

import requests

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
TOWNS = ["Abucay", "Bagac", "Balanga", "Dinalupihan", "Hermosa", "Limay", "Mariveles", "Morong", "Orani", "Orion", "Pilar", "Samal"]
failures: list[str] = []
checks = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global checks
    checks += 1
    if not ok:
        failures.append(f"{label}: {detail}")
        print(f"  FAIL  {label} {detail}")


def get(path: str, timeout: int = 180):
    started = time.time()
    response = requests.get(BASE + path, timeout=timeout)
    took = time.time() - started
    check(response.status_code == 200, f"GET {path}", f"HTTP {response.status_code}")
    print(f"  {response.status_code}  {path}  ({took:.1f} s)")
    return response.json() if response.status_code == 200 else None


def finite(value) -> bool:
    return value is None or (isinstance(value, (int, float)) and math.isfinite(value))


def close(a, b, tol=0.15) -> bool:
    if a is None or b is None:
        return a is b
    return abs(a - b) <= tol + 0.01 * max(abs(a), abs(b))


print(f"AGOS data audit against {BASE}\n")
overview = get("/api/overview?hours=48")
risk = get("/api/flood-risk")
history = get("/api/flood-risk/history")

print("\nPer-town checks")
for name in TOWNS:
    town = next((m for m in (overview or {}).get("municipalities", []) if m["name"] == name), None)
    check(town is not None, f"{name} in overview")
    if town is None:
        continue
    w24 = town["windows"]["next_24h"]
    ens = (town.get("ensemble") or {}).get("next_24h") or {}
    check(overview.get("method") == "consensus", f"{name} overview method", str(overview.get("method")))
    check(finite(w24["total_mm"]) and (w24["total_mm"] or 0) >= 0, f"{name} 24 h total is a valid number", str(w24["total_mm"]))
    if ens.get("low") is not None:
        check(ens["low"] - 0.05 <= (w24["total_mm"] or 0) <= ens["high"] + 0.05, f"{name} 24 h total inside the model range",
              f"{w24['total_mm']} not in {ens['low']}-{ens['high']}")
    check(w24["peak_mm_h"] is None or w24["total_mm"] is None or w24["peak_mm_h"] <= w24["total_mm"] + 0.05 or ens.get("models", 0) >= 3,
          f"{name} peak hour not above the day total")
    for p in town["series"]:
        if p.get("probability_percent") is not None:
            check(0 <= p["probability_percent"] <= 100, f"{name} chance 0-100", str(p["probability_percent"]))
        if p.get("low_mm") is not None and p.get("precipitation_mm") is not None:
            check(p["low_mm"] - 0.01 <= p["precipitation_mm"] <= p["high_mm"] + 0.01, f"{name} hourly value inside range", p["time"])
        if p.get("temperature_c") is not None:
            check(10 <= p["temperature_c"] <= 42, f"{name} temperature plausible", str(p["temperature_c"]))

    detail = get(f"/api/municipalities/{name}")
    if detail and detail["rain"]["status"] == "ok":
        check(close(detail["rain"]["data"]["windows"]["next_24h"]["total_mm"], w24["total_mm"]),
              f"{name} town page = overview (24 h)", f"{detail['rain']['data']['windows']['next_24h']['total_mm']} vs {w24['total_mm']}")
    if detail and detail["current_weather"]["status"] == "ok":
        cw = detail["current_weather"]["data"]
        check(cw.get("method") == "consensus", f"{name} current weather from consensus", str(cw.get("method")))
        check(cw.get("condition") is not None, f"{name} current condition present")

    analysis = get(f"/api/analysis/{name}")
    if analysis:
        a24 = analysis["steps"]["describe"]["next_24h"]["precipitation"].get("sum")
        check(close(a24, w24["total_mm"], tol=0.6), f"{name} analysis = overview (24 h)", f"{a24} vs {w24['total_mm']}")
        bad = [r for r in analysis["steps"]["clean"]["reports"] if r["valid_percent"] < 90]
        check(not bad, f"{name} cleaned data at least 90% valid", ", ".join(r["variable"] for r in bad))

    rt = next((t for t in (risk or {}).get("municipalities", []) if t["municipality"] == name), None)
    if rt:
        f = {x["id"]: x for x in rt["factors"]}
        if f["total_24h"]["value"] is not None and w24["total_mm"] is not None:
            check(f["total_24h"]["value"] + 0.05 >= w24["total_mm"], f"{name} cautious risk rain >= best guess",
                  f"{f['total_24h']['value']} < {w24['total_mm']}")
        if rt["score"] is not None:
            check(rt["score"] == sum(x["points"] for x in rt["factors"]), f"{name} risk score = sum of factor points")

print("\nFlood-risk history checks")
if history:
    for town in history["municipalities"]:
        for d in town["days"]:
            if d["score"] is not None:
                if d["score"] != sum(f["points"] for f in d["factors"]):
                    check(False, f"{town['municipality']} {d['date']} score = sum of factors")
                    break
    ev = history.get("evaluation_summary", {})
    print(f"  reported town-floods: {ev.get('town_events')} · moderate or above {ev.get('moderate_or_above')} · high or above {ev.get('high_or_above')}")
    check(ev.get("town_events", 0) > 0, "reported floods loaded")

print(f"\n{checks} checks, {len(failures)} failed")
for line in failures:
    print("  -", line)
sys.exit(1 if failures else 0)
