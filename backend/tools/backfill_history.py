"""
Backfill past daily weather and modeled river discharge into the AGOS database.

Run from the backend folder, venv active. Backend can stay running.

    python tools/backfill_history.py --dry-run              # plan + estimate, no requests
    python tools/backfill_history.py --status               # what the database holds now
    python tools/backfill_history.py --from-year 2015       # a smaller first run
    python tools/backfill_history.py --from-year 1990       # full plan (1990 up to last week)
    python tools/backfill_history.py --sources archive      # rain/weather only
    python tools/backfill_history.py --max-requests 100     # stop after 100 requests

Safe to run again and again: finished chunks are skipped, nothing is duplicated.
Newest years are fetched first. If Open-Meteo's hourly/daily limit is reached it
stops and says so; run it again later.
"""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.data.municipalities import MUNICIPALITIES  # noqa: E402
from app.services import backfill_service as bf  # noqa: E402

SOURCE_NAMES = {"archive": "open_meteo_archive", "glofas": "open_meteo_glofas"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from-year", type=int, default=1990)
    parser.add_argument("--sources", default="archive,glofas", help="archive, glofas, or both (comma separated)")
    parser.add_argument("--pause", type=float, default=8.0, help="seconds between requests")
    parser.add_argument("--max-requests", type=int)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()

    from agos_data_lifecycle import _connect, _init_db, ingest_historical_weather, ingest_river_discharge

    _init_db()
    connection = _connect()
    try:
        if args.status:
            rows = bf.coverage(connection)
            if not rows:
                print("The database holds no observations yet.")
            for r in rows:
                print(f"{r['source']:<20}{r['variable']:<22}{r['first']} -> {r['last']}  "
                      f"{r['records']} records, {r['points']} points")
            return 0

        try:
            sources = [SOURCE_NAMES[s.strip()] for s in args.sources.split(",") if s.strip()]
        except KeyError as error:
            parser.error(f"unknown source {error}; use archive and/or glofas")
        todo = bf.plan(MUNICIPALITIES, sources, args.from_year, date.today(), bf.completed_runs(connection))
    finally:
        connection.close()

    info = bf.estimate(todo, args.pause)
    print(f"Still to do: {info['requests']} requests (~{info['estimated_minutes']} min, "
          f"~{info['estimated_weighted_calls']} weighted calls, estimated).")
    print(info["note"])
    if args.dry_run or not todo:
        if not todo:
            print("Nothing to do: everything in that range is already stored.")
        return 0

    summary = bf.run_backfill(
        todo, MUNICIPALITIES,
        {"open_meteo_archive": ingest_historical_weather, "open_meteo_glofas": ingest_river_discharge},
        pause_s=args.pause, max_requests=args.max_requests, progress=lambda m: print(m, flush=True),
    )
    print(f"\nsucceeded {summary['succeeded']}, failed {summary['failed']}, "
          f"records upserted {summary['records_upserted']}")
    if summary["stopped"]:
        print("STOPPED:", summary["stopped"])
    for error in summary["errors"]:
        print(" -", error)
    return 1 if (summary["failed"] or summary["stopped"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
