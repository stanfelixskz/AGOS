"""
AGOS — past Bataan flood events (plan item 3, flood labels)

The list lives in the repository as `app/data/flood_events.json` (reviewable,
with every source link). This module validates it and mirrors it into SQLite so
analytics can join events with daily rain and river flow:

  flood_events          one row per event (dates, how the date is known, cause)
  flood_event_towns     one row per town named in the sources, with the evidence type
  flood_event_sources   one row per source page
  flood_events_meta     file hash and import time

Rules
- The JSON file is the source of truth. The tables are rebuilt from it in one
  transaction whenever the file changes (detected by its SHA-256), so they can
  never drift from what is in the repository.
- Nothing is computed into the data except `confidence`, which follows a fixed,
  documented rule (see `confidence()`), so it cannot be hand-tuned per event.
- Missing values stay missing. An event without a date has NULL dates and
  `confidence = "low"`; it is shown, but analytics should skip it.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

DATA_FILE = Path(__file__).resolve().parents[1] / "data" / "flood_events.json"

DATE_BASIS = ("stated", "inferred", "article_date", "not_stated")
EVIDENCE = ("flooded", "road", "evacuation", "death", "affected")
KINDS = ("flood", "debris_flow")

SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS flood_events (
        id TEXT PRIMARY KEY,
        start_date TEXT,
        end_date TEXT,
        period TEXT,
        date_basis TEXT NOT NULL,
        date_note TEXT,
        kind TEXT NOT NULL,
        cause TEXT,
        storm TEXT,
        habagat INTEGER NOT NULL,
        province_calamity INTEGER NOT NULL,
        impact TEXT,
        deaths INTEGER,
        confidence TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS flood_event_towns (
        event_id TEXT NOT NULL REFERENCES flood_events(id),
        municipality TEXT NOT NULL,
        evidence TEXT NOT NULL,
        barangays TEXT,
        note TEXT,
        PRIMARY KEY (event_id, municipality)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS flood_event_sources (
        event_id TEXT NOT NULL REFERENCES flood_events(id),
        publisher TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        published TEXT,
        note TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_flood_event_towns_town ON flood_event_towns(municipality)",
    """
    CREATE TABLE IF NOT EXISTS flood_events_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )
    """,
)


# --------------------------------------------------------------------------
# File
# --------------------------------------------------------------------------

def read_file(path: Path | str = DATA_FILE) -> tuple[dict[str, Any], str]:
    raw = Path(path).read_bytes()
    return json.loads(raw.decode("utf-8")), hashlib.sha256(raw).hexdigest()


def _is_date(value: Any) -> bool:
    try:
        date.fromisoformat(value)
        return True
    except (TypeError, ValueError):
        return False


def validate(data: Mapping[str, Any], municipalities: Mapping[str, Any]) -> list[str]:
    """Every problem found, as plain sentences. Empty list = valid."""
    errors: list[str] = []
    events = data.get("events")
    if not isinstance(events, list) or not events:
        return ["The file has no 'events' list."]
    seen: set[str] = set()
    for i, event in enumerate(events):
        eid = event.get("id") or f"#{i}"
        if eid in seen:
            errors.append(f"{eid}: duplicate id")
        seen.add(eid)
        basis = event.get("date_basis")
        if basis not in DATE_BASIS:
            errors.append(f"{eid}: date_basis must be one of {DATE_BASIS}")
        start, end = event.get("start_date"), event.get("end_date")
        if basis == "not_stated":
            if start or end:
                errors.append(f"{eid}: dates given although date_basis is not_stated")
        else:
            if not (_is_date(start) and _is_date(end)):
                errors.append(f"{eid}: start_date and end_date must be YYYY-MM-DD")
            elif end < start:
                errors.append(f"{eid}: end_date is before start_date")
        if event.get("kind") not in KINDS:
            errors.append(f"{eid}: kind must be one of {KINDS}")
        towns = event.get("towns") or []
        if not towns:
            errors.append(f"{eid}: no towns")
        names = [t.get("municipality") for t in towns]
        if len(names) != len(set(names)):
            errors.append(f"{eid}: a town is listed twice")
        for town in towns:
            if town.get("municipality") not in municipalities:
                errors.append(f"{eid}: unknown municipality {town.get('municipality')!r}")
            if town.get("evidence") not in EVIDENCE:
                errors.append(f"{eid}: evidence for {town.get('municipality')} must be one of {EVIDENCE}")
        sources = event.get("sources") or []
        if not sources:
            errors.append(f"{eid}: no sources")
        for source in sources:
            if not str(source.get("url", "")).startswith("https://"):
                errors.append(f"{eid}: source url must start with https://")
            if source.get("published") is not None and not _is_date(source["published"]):
                errors.append(f"{eid}: source published date must be YYYY-MM-DD or null")
        deaths = event.get("deaths")
        if deaths is not None and (not isinstance(deaths, int) or deaths < 0):
            errors.append(f"{eid}: deaths must be a non-negative integer or null")
    return errors


def confidence(event: Mapping[str, Any]) -> str:
    """
    Fixed rule, applied to every event the same way:
      high   - date stated or inferred from a weekday, and at least one town named as flooded
      medium - only the article date is known, or no town is named as flooded
      low    - no date
    """
    if event.get("date_basis") == "not_stated" or not event.get("start_date"):
        return "low"
    flooded = any(t.get("evidence") == "flooded" for t in event.get("towns") or [])
    if event.get("date_basis") in ("stated", "inferred") and flooded:
        return "high"
    return "medium"


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------

def init_tables(connection: sqlite3.Connection) -> None:
    for statement in SCHEMA:
        connection.execute(statement)


def import_events(connection: sqlite3.Connection, data: Mapping[str, Any], file_hash: str, now: datetime | None = None) -> int:
    """Replace all event rows with the file's content, in one transaction."""
    init_tables(connection)
    stamp = (now or datetime.now(timezone.utc)).isoformat(timespec="seconds")
    events = data["events"]
    with connection:
        connection.execute("DELETE FROM flood_event_sources")
        connection.execute("DELETE FROM flood_event_towns")
        connection.execute("DELETE FROM flood_events")
        for e in events:
            connection.execute(
                """INSERT INTO flood_events (id, start_date, end_date, period, date_basis, date_note, kind, cause,
                   storm, habagat, province_calamity, impact, deaths, confidence)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (e["id"], e.get("start_date"), e.get("end_date"), e.get("period"), e["date_basis"], e.get("date_note"),
                 e["kind"], e.get("cause"), e.get("storm"), int(bool(e.get("habagat"))),
                 int(bool(e.get("province_calamity"))), e.get("impact"), e.get("deaths"), confidence(e)),
            )
            connection.executemany(
                "INSERT INTO flood_event_towns (event_id, municipality, evidence, barangays, note) VALUES (?, ?, ?, ?, ?)",
                [(e["id"], t["municipality"], t["evidence"], json.dumps(t.get("barangays") or [], ensure_ascii=False), t.get("note"))
                 for t in e["towns"]],
            )
            connection.executemany(
                "INSERT INTO flood_event_sources (event_id, publisher, title, url, published, note) VALUES (?, ?, ?, ?, ?, ?)",
                [(e["id"], s["publisher"], s["title"], s["url"], s.get("published"), s.get("note")) for s in e["sources"]],
            )
        connection.executemany(
            "INSERT INTO flood_events_meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [("file_sha256", file_hash), ("imported_at", stamp), ("events", str(len(events)))],
        )
    return len(events)


def stored_hash(connection: sqlite3.Connection) -> str | None:
    init_tables(connection)
    row = connection.execute("SELECT value FROM flood_events_meta WHERE key = 'file_sha256'").fetchone()
    return row[0] if row else None


def town_counts(events: list[Mapping[str, Any]], municipalities: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Per town: events where it is named as flooded, any mention, and dated flooded events."""
    out = []
    for name in municipalities:
        flooded = [e for e in events if any(t["municipality"] == name and t["evidence"] == "flooded" for t in e["towns"])]
        mentioned = [e for e in events if any(t["municipality"] == name for t in e["towns"])]
        out.append({
            "municipality": name,
            "flooded": len(flooded),
            "flooded_dated": sum(1 for e in flooded if e.get("start_date")),
            "any_mention": len(mentioned),
        })
    return out


def _default_connect() -> sqlite3.Connection:
    from agos_data_lifecycle import _connect  # lazy: needs FastAPI

    return _connect()


def _default_municipalities() -> Mapping[str, Any]:
    from app.data.municipalities import MUNICIPALITIES

    return MUNICIPALITIES


def ensure_imported(
    connect: Callable[[], sqlite3.Connection] | None = None,
    path: Path | str = DATA_FILE,
    municipalities: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate the file and (re)import it if it changed. Raises ValueError if invalid."""
    municipalities = municipalities or _default_municipalities()
    data, file_hash = read_file(path)
    errors = validate(data, municipalities)
    if errors:
        raise ValueError("flood_events.json is invalid: " + "; ".join(errors[:10]))
    connection = (connect or _default_connect)()
    try:
        imported = stored_hash(connection) != file_hash
        if imported:
            import_events(connection, data, file_hash)
    finally:
        connection.close()
    return {"imported": imported, "events": len(data["events"]), "file_sha256": file_hash}


def events_report(
    connect: Callable[[], sqlite3.Connection] | None = None,
    path: Path | str = DATA_FILE,
    municipalities: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Everything the interface needs, read back from SQLite after syncing with the file."""
    municipalities = municipalities or _default_municipalities()
    sync = ensure_imported(connect, path, municipalities)
    data, _ = read_file(path)
    connection = (connect or _default_connect)()
    try:
        connection.row_factory = sqlite3.Row
        events = [dict(r) for r in connection.execute(
            "SELECT * FROM flood_events ORDER BY COALESCE(start_date, period) DESC")]
        towns: dict[str, list[dict[str, Any]]] = {}
        for r in connection.execute("SELECT * FROM flood_event_towns ORDER BY municipality"):
            row = dict(r)
            row["barangays"] = json.loads(row["barangays"] or "[]")
            towns.setdefault(row.pop("event_id"), []).append(row)
        sources: dict[str, list[dict[str, Any]]] = {}
        for r in connection.execute("SELECT * FROM flood_event_sources"):
            row = dict(r)
            sources.setdefault(row.pop("event_id"), []).append(row)
        meta = dict(connection.execute("SELECT key, value FROM flood_events_meta").fetchall())
    finally:
        connection.close()
    for e in events:
        e["habagat"] = bool(e["habagat"])
        e["province_calamity"] = bool(e["province_calamity"])
        e["towns"] = towns.get(e["id"], [])
        e["sources"] = sources.get(e["id"], [])
    by_conf = {level: sum(1 for e in events if e["confidence"] == level) for level in ("high", "medium", "low")}
    return {
        "name": data.get("name"),
        "compiled": data.get("compiled"),
        "imported_at": meta.get("imported_at"),
        "count": len(events),
        "by_confidence": by_conf,
        "towns": town_counts(events, municipalities),
        "events": events,
        "method": data.get("method"),
        "limits": data.get("limits", []),
        "leads_not_used": data.get("leads_not_used", []),
        "checked_no_bataan_flood": data.get("checked_no_bataan_flood", []),
        "synced_now": sync["imported"],
    }
