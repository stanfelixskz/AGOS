"""
Fit the flood chance model from the AGOS database and save it to backend/data/chance_model.json.

Run from backend/ (about a minute; re-run when more rain days or floods are added):
    python tools/build_chance_model.py

Reads the stored rain record, the flood list and the DENR-MGB flood susceptibility; writes only the
git-ignored backend/data/chance_model.json. See app/services/flood_chance_model_service.py for what the
model is and why only wet ground and flood-prone ground are in it.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import flood_chance_model_service as cm  # noqa: E402


def gather():
    from app.data.municipalities import MUNICIPALITIES
    from app.services import evidence_service as ev
    from app.services import flood_events_service, flood_factors_service, susceptibility_service

    records = flood_factors_service.load_records()
    events = flood_events_service.events_report(connect=ev._default_connect, municipalities=MUNICIPALITIES)["events"]
    report = susceptibility_service.susceptibility_report()
    ground = {}
    if report.get("available"):
        for row in report.get("towns", []):
            shares = row.get("shares") or {}
            ground[row["name"]] = round(shares.get("high", 0.0) + shares.get("very_high", 0.0), 4)
    return records, events, ground


def main() -> int:
    try:
        records, events, ground = gather()
    except Exception as error:  # noqa: BLE001 - say why and stop, never guess
        print(f"Could not read the AGOS data ({type(error).__name__}: {error}). Nothing was saved.")
        return 2
    if not ground:
        print("The flood-prone ground map is not available. Nothing was saved.")
        return 2
    model = cm.train(records, events, ground)
    if model is None:
        print(f"Not enough data to fit (needs at least {cm.MIN_FLOOD_CASES} flood town-cases since {cm.FROM_DATE}). Nothing was saved.")
        return 2
    path = cm.save(model)
    print(f"Saved {path}")
    print(f"Rows {model['rows']}, flood town-cases {model['flood_cases']}, {model['from']} to {model['to']}")
    for b in model["bands"]:
        print(f"  {b['band']:<7} {b['rows']:>5} held-out rows, followed by a listed flood within {model['horizon_days']} days: "
              f"{b['rate']:.1%} (95% range {b['range_95'][0]:.1%} to {b['range_95'][1]:.1%}), {b['flood_cases']} flood cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
