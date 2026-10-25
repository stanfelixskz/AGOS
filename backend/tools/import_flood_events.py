"""
Check and load the past flood events list into the AGOS database.

Run from the backend folder, venv active:

    python tools/import_flood_events.py --check    # validate the file, show counts, write nothing
    python tools/import_flood_events.py            # validate and (re)load into SQLite

The list itself is backend/app/data/flood_events.json. The /api/flood-events
endpoint also reloads it automatically whenever the file changes.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.data.municipalities import MUNICIPALITIES  # noqa: E402
from app.services import flood_events_service as fe  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    data, file_hash = fe.read_file()
    errors = fe.validate(data, MUNICIPALITIES)
    if errors:
        print("INVALID:")
        for error in errors:
            print(" -", error)
        return 1
    events = data["events"]
    levels = [fe.confidence(e) for e in events]
    print(f"{len(events)} events, valid. Confidence: "
          + ", ".join(f"{lv} {levels.count(lv)}" for lv in ("high", "medium", "low")))
    print(f"{'town':<13}{'flooded':>8}{'dated':>7}{'any':>6}")
    for row in fe.town_counts(events, MUNICIPALITIES):
        print(f"{row['municipality']:<13}{row['flooded']:>8}{row['flooded_dated']:>7}{row['any_mention']:>6}")
    if args.check:
        return 0
    result = fe.ensure_imported()
    print("Loaded into SQLite." if result["imported"] else "Already up to date in SQLite.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
