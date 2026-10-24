
"""
AGOS — Community Flood Reports API
Complete replacement for backend/app/routes/reports.py

Features:
- Submit community flood reports with optional photos
- Record municipality, barangay, address, GPS coordinates,
  severity, water depth, report date, and contact number
- Persist reports in community_reports.json
- Atomically save report data
- List reports and retrieve individual reports and photos
- Use a reentrant lock to prevent nested-lock deadlocks

Community reports are unverified until independently reviewed.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import uuid

from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse


router = APIRouter(
    prefix="/reports",
    tags=["Community Flood Reports"],
)


# =========================================================
# STORAGE CONFIGURATION
# =========================================================

# parents[0] = routes
# parents[1] = app
# parents[2] = backend

BACKEND_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BACKEND_DIR / "data"
REPORTS_FILE = DATA_DIR / "community_reports.json"
PHOTOS_DIR = DATA_DIR / "community_report_photos"

DATA_DIR.mkdir(parents=True, exist_ok=True)
PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

# RLock allows the same thread to acquire the lock recursively.
_storage_lock = RLock()

MAX_PHOTO_SIZE = 8 * 1024 * 1024  # 8 MB

ALLOWED_PHOTO_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}

ALLOWED_SEVERITIES = {
    "low",
    "moderate",
    "high",
    "critical",
}

PHOTO_NAME_PATTERN = re.compile(
    r"AGOS-\d{8}-[A-F0-9]{8}\.(jpg|png|webp)"
)


# =========================================================
# STORAGE HELPERS
# =========================================================

def _read_reports() -> list[dict[str, Any]]:
    """Read community reports from JSON storage."""

    with _storage_lock:
        if not REPORTS_FILE.exists():
            return []

        try:
            with REPORTS_FILE.open("r", encoding="utf-8") as file:
                data = json.load(file)

        except (json.JSONDecodeError, OSError) as exc:
            raise HTTPException(
                status_code=500,
                detail=(
                    "Community report storage could not be read. "
                    "Check backend/data/community_reports.json."
                ),
            ) from exc

        if not isinstance(data, list):
            raise HTTPException(
                status_code=500,
                detail="Community report storage has an invalid format.",
            )

        if not all(isinstance(item, dict) for item in data):
            raise HTTPException(
                status_code=500,
                detail="Community report storage contains invalid entries.",
            )

        return data


def _write_reports(reports: list[dict[str, Any]]) -> None:
    """Atomically save reports to JSON storage."""

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=DATA_DIR,
            prefix="community_reports_",
            suffix=".tmp",
            delete=False,
        ) as file:
            json.dump(
                reports,
                file,
                indent=2,
                ensure_ascii=False,
            )
            file.flush()
            os.fsync(file.fileno())
            temporary_path = Path(file.name)

        os.replace(temporary_path, REPORTS_FILE)

    except OSError as exc:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass

        raise HTTPException(
            status_code=500,
            detail="Could not save the community flood report.",
        ) from exc


def _find_report(report_id: str) -> dict[str, Any] | None:
    """Find a report by its unique ID."""

    for report in _read_reports():
        if report.get("report_id") == report_id:
            return report

    return None


# Never returned by the public API: internal file names and the reporter's
# contact number (personal data, kept only for follow-up by reviewers).
PRIVATE_REPORT_FIELDS = {"photo_filename", "contact_number"}


def _public_report(report: dict[str, Any]) -> dict[str, Any]:
    """Remove internal and personal fields before returning a report."""

    public = {
        key: value
        for key, value in report.items()
        if key not in PRIVATE_REPORT_FIELDS
    }
    public["has_contact"] = bool(report.get("contact_number"))
    return public


def _validate_coordinate(
    value: float | None,
    minimum: float,
    maximum: float,
    field_name: str,
) -> float | None:
    """Validate a latitude or longitude."""

    if value is None:
        return None

    if not minimum <= value <= maximum:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{field_name} must be between "
                f"{minimum} and {maximum}."
            ),
        )

    return value


def _remove_photo(filename: str | None) -> None:
    """Best-effort cleanup of a photo when report saving fails."""

    if not filename:
        return

    try:
        (PHOTOS_DIR / filename).unlink(missing_ok=True)
    except OSError:
        pass


# =========================================================
# PHOTO HANDLING
# =========================================================

async def _save_photo(
    photo: UploadFile | None,
    report_id: str,
) -> str | None:
    """Validate and save an optional JPEG, PNG, or WebP photo."""

    if photo is None or not photo.filename:
        return None

    content_type = (photo.content_type or "").lower().strip()

    if content_type not in ALLOWED_PHOTO_TYPES:
        raise HTTPException(
            status_code=415,
            detail="Unsupported photo format. Upload JPEG, PNG, or WebP.",
        )

    extension = ALLOWED_PHOTO_TYPES[content_type]

    contents = await photo.read(MAX_PHOTO_SIZE + 1)

    if not contents:
        return None

    if len(contents) > MAX_PHOTO_SIZE:
        raise HTTPException(
            status_code=413,
            detail="Photo exceeds the 8 MB upload limit.",
        )

    # Check file signatures instead of trusting MIME type alone.
    valid_signature = {
        ".jpg": contents.startswith(b"\xff\xd8\xff"),
        ".png": contents.startswith(b"\x89PNG\r\n\x1a\n"),
        ".webp": (
            len(contents) >= 12
            and contents[:4] == b"RIFF"
            and contents[8:12] == b"WEBP"
        ),
    }

    if not valid_signature.get(extension, False):
        raise HTTPException(
            status_code=415,
            detail="The uploaded file does not match its image format.",
        )

    filename = f"{report_id}{extension}"
    photo_path = PHOTOS_DIR / filename

    try:
        PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
        photo_path.write_bytes(contents)

    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail="Could not save the uploaded photo.",
        ) from exc

    return filename


# =========================================================
# CREATE COMMUNITY FLOOD REPORT
# =========================================================

@router.post("/community", status_code=201)
async def create_community_report(
    municipality: str = Form(...),
    barangay: str = Form(...),
    location: str = Form(...),
    severity: str = Form(...),
    description: str = Form(...),
    report_type: str = Form("Flooding"),
    water_level_cm: float | None = Form(None),
    latitude: float | None = Form(None),
    longitude: float | None = Form(None),
    reported_at: str | None = Form(None),
    contact_number: str | None = Form(None),
    accuracy_confirmed: bool = Form(False),
    photo: UploadFile | None = File(None),
) -> dict[str, Any]:
    """
    Accept a community-submitted flood observation.

    Submission does not independently verify the reported conditions.
    """

    municipality = municipality.strip()
    barangay = barangay.strip()
    location = location.strip()
    description = description.strip()
    severity = severity.strip().lower()
    report_type = report_type.strip() or "Flooding"

    if not municipality:
        raise HTTPException(
            status_code=422,
            detail="Municipality is required.",
        )

    if not barangay:
        raise HTTPException(
            status_code=422,
            detail="Barangay is required.",
        )

    if not location:
        raise HTTPException(
            status_code=422,
            detail="Please provide the report address or location.",
        )

    if not description:
        raise HTTPException(
            status_code=422,
            detail="Please describe the reported flood conditions.",
        )

    if severity not in ALLOWED_SEVERITIES:
        raise HTTPException(
            status_code=422,
            detail="Severity must be low, moderate, high, or critical.",
        )

    if water_level_cm is not None and water_level_cm < 0:
        raise HTTPException(
            status_code=422,
            detail="Water depth cannot be negative.",
        )

    latitude = _validate_coordinate(
        latitude, -90, 90, "Latitude"
    )
    longitude = _validate_coordinate(
        longitude, -180, 180, "Longitude"
    )

    if (latitude is None) != (longitude is None):
        raise HTTPException(
            status_code=422,
            detail="Latitude and longitude must be supplied together.",
        )

    if not accuracy_confirmed:
        raise HTTPException(
            status_code=422,
            detail=(
                "Please confirm that the report is accurate "
                "to the best of your knowledge."
            ),
        )

    now = datetime.now(timezone.utc)

    if reported_at:
        try:
            parsed_time = datetime.fromisoformat(
                reported_at.strip().replace("Z", "+00:00")
            )

            if parsed_time.tzinfo is None:
                parsed_time = parsed_time.replace(tzinfo=timezone.utc)

            reported_at_value = parsed_time.astimezone(
                timezone.utc
            ).isoformat()

        except ValueError as exc:
            raise HTTPException(
                status_code=422,
                detail="reported_at must be a valid ISO date/time.",
            ) from exc
    else:
        reported_at_value = now.isoformat()

    report_id = (
        f"AGOS-{now.strftime('%Y%m%d')}-"
        f"{uuid.uuid4().hex[:8].upper()}"
    )

    photo_filename: str | None = None

    try:
        # Validate and store an optional image first.
        photo_filename = await _save_photo(photo, report_id)

        report: dict[str, Any] = {
            "report_id": report_id,
            "reported_at": reported_at_value,
            "submitted_at": now.isoformat(),
            "municipality": municipality,
            "barangay": barangay,
            "location": location,
            "report_type": report_type,
            "severity": severity,
            "water_level_cm": water_level_cm,
            "description": description,
            "latitude": latitude,
            "longitude": longitude,
            "contact_number": (
                contact_number.strip()
                if contact_number and contact_number.strip()
                else None
            ),
            "accuracy_confirmed": True,
            "photo_url": (
                f"/reports/{report_id}/photo"
                if photo_filename
                else None
            ),
            "photo_filename": photo_filename,
            "source": "community",
            "verification_status": "pending",
            "status": "submitted",
        }

        # Keep reading, modifying, and writing within one lock.
        # RLock prevents deadlock when _read_reports acquires it again.
        with _storage_lock:
            reports = _read_reports()
            reports.insert(0, report)
            _write_reports(reports)

    except Exception:
        # Do not leave an orphan photo if report persistence fails.
        _remove_photo(photo_filename)
        raise

    finally:
        if photo is not None:
            await photo.close()

    return {
        "status": "success",
        "message": (
            "Your flood report was submitted successfully. "
            "It has not yet been independently verified."
        ),
        "report": _public_report(report),
    }


# =========================================================
# LIST COMMUNITY REPORTS
# =========================================================

@router.get("")
def list_community_reports() -> dict[str, Any]:
    """Return community submissions, newest first."""

    reports = _read_reports()

    return {
        "status": "success",
        "count": len(reports),
        "reports": [_public_report(report) for report in reports],
    }


# =========================================================
# GET ONE COMMUNITY REPORT
# =========================================================

@router.get("/{report_id}")
def get_community_report(report_id: str) -> dict[str, Any]:
    """Retrieve a single community report."""

    report = _find_report(report_id)

    if report is None:
        raise HTTPException(
            status_code=404,
            detail="Community flood report not found.",
        )

    return {
        "status": "success",
        "report": _public_report(report),
    }


# =========================================================
# GET COMMUNITY REPORT PHOTO
# =========================================================

@router.get("/{report_id}/photo")
def get_community_report_photo(report_id: str) -> FileResponse:
    """Serve the photo attached to a community report."""

    report = _find_report(report_id)

    if report is None:
        raise HTTPException(
            status_code=404,
            detail="Community flood report not found.",
        )

    filename = report.get("photo_filename")

    if not isinstance(filename, str) or not PHOTO_NAME_PATTERN.fullmatch(
        filename
    ):
        raise HTTPException(
            status_code=404,
            detail="This report does not have an uploaded photo.",
        )

    photo_path = PHOTOS_DIR / filename

    if not photo_path.is_file():
        raise HTTPException(
            status_code=404,
            detail="The report photo could not be found.",
        )

    media_types = {
        ".jpg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }

    return FileResponse(
        path=photo_path,
        media_type=media_types[photo_path.suffix.lower()],
        filename=photo_path.name,
    )
