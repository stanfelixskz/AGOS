from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt


AGOS_ROOT = Path(__file__).resolve().parents[3]


PROCESSED_ROOT = (
    AGOS_ROOT
    / "sentinel1_before_after"
    / "sentinel2_bataan"
    / "processed"
)


EVIDENCE_METADATA = (
    PROCESSED_ROOT
    / "indices"
    / "combined"
    / "combined_evidence_metadata.json"
)


VALIDATION_GEOJSON = (
    AGOS_ROOT
    / "frontend"
    / "data"
    / "flood_evidence_results.geojson"
)


CANDIDATE_ZONES_GEOJSON = (
    PROCESSED_ROOT
    / "indices"
    / "combined"
    / "zones"
    / "AGOS_flood_candidate_zones.geojson"
)


CANDIDATE_ZONES_CSV = (
    PROCESSED_ROOT
    / "indices"
    / "combined"
    / "zones"
    / "AGOS_flood_candidate_zones.csv"
)


REPORTS_DIR = (
    AGOS_ROOT
    / "backend"
    / "data"
    / "reports"
)


SUPPORTED_AREAS = {
    "bataan": "Bataan",
    "province of bataan": "Bataan",
}


SUPPORTED_ASSESSMENT_TYPES = {
    "flood evidence assessment": "Flood Evidence Assessment",
    "flood evidence": "Flood Evidence Assessment",
}


class ReportServiceError(Exception):
    """Expected AGOS report-service error."""


# ============================================================
# BASIC HELPERS
# ============================================================

def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_area(value: str) -> str:
    key = " ".join(value.strip().lower().split())

    if key not in SUPPORTED_AREAS:
        raise ReportServiceError(
            "The current imported evidence dataset is province-wide for Bataan. "
            "Municipality-specific assessment is not available yet."
        )

    return SUPPORTED_AREAS[key]


def _normalize_assessment_type(value: str) -> str:
    key = " ".join(value.strip().lower().split())

    if key not in SUPPORTED_ASSESSMENT_TYPES:
        raise ReportServiceError(
            "Unsupported assessment type. The current report pipeline supports "
            "Flood Evidence Assessment."
        )

    return SUPPORTED_ASSESSMENT_TYPES[key]


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise ReportServiceError(
            f"Required file is missing: {path}"
        )

    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)

    except json.JSONDecodeError as exc:
        raise ReportServiceError(
            f"Invalid JSON file: {path}"
        ) from exc

    if not isinstance(value, dict):
        raise ReportServiceError(
            f"Expected a JSON object: {path}"
        )

    return value


def _safe_number(value: Any, fallback: float = 0.0) -> float:
    try:
        number = float(value)

    except (TypeError, ValueError):
        return fallback

    return number


def _first_value(
    properties: dict[str, Any],
    keys: list[str],
    fallback: Any = None,
) -> Any:

    for key in keys:

        value = properties.get(key)

        if value is not None and value != "":
            return value

    return fallback


# ============================================================
# SOURCE DATE
# ============================================================

def _extract_source_date(
    metadata: dict[str, Any]
) -> str | None:

    inputs = metadata.get("inputs", {})

    for key in (
        "sentinel1_sar_change",
        "sentinel1_sar_classified",
        "sentinel2_ndwi",
        "sentinel2_mndwi",
        "sentinel2_ndvi",
        "sentinel2_ndmi",
    ):

        name = Path(
            str(inputs.get(key, ""))
        ).name

        match = re.search(
            r"(20\d{6})",
            name,
        )

        if match:

            raw = match.group(1)

            return (
                f"{raw[:4]}-"
                f"{raw[4:6]}-"
                f"{raw[6:8]}"
            )

    return None


# ============================================================
# VALIDATION
# ============================================================

def _validation_summary(
    geojson: dict[str, Any]
) -> dict[str, Any]:

    features = geojson.get(
        "features",
        []
    )

    if not isinstance(features, list):
        features = []

    by_classification: dict[str, int] = {}
    by_confidence: dict[str, int] = {}

    cases: list[dict[str, Any]] = []

    for feature in features:

        if not isinstance(feature, dict):
            continue

        properties = feature.get(
            "properties",
            {}
        )

        if not isinstance(properties, dict):
            properties = {}

        classification = str(
            properties.get("classification")
            or properties.get("case_label")
            or "UNKNOWN"
        )

        confidence = str(
            properties.get("confidence")
            or properties.get("confidence_level")
            or "UNKNOWN"
        )

        by_classification[classification] = (
            by_classification.get(
                classification,
                0
            ) + 1
        )

        by_confidence[confidence] = (
            by_confidence.get(
                confidence,
                0
            ) + 1
        )

        case_id = (
            properties.get("candidate_id")
            or properties.get("cluster_id")
            or properties.get("id")
            or properties.get("case_id")
        )

        area_hectares = (
            properties.get("area_hectares")
            if properties.get("area_hectares") is not None
            else properties.get("area_ha")
        )

        cases.append(
            {
                "id": case_id,
                "classification": classification,
                "confidence": confidence,
                "area_hectares": area_hectares,
            }
        )

    return {
        "case_count": len(cases),
        "by_classification": by_classification,
        "by_confidence": by_confidence,
        "cases": cases,
    }


# ============================================================
# CANDIDATE ZONES
# ============================================================

def _read_candidate_zones() -> list[dict[str, Any]]:

    if not CANDIDATE_ZONES_GEOJSON.exists():
        raise ReportServiceError(
            "Flood candidate zone GeoJSON is missing. "
            "Run build_flood_land_water_zones.py first."
        )

    geojson = _read_json(
        CANDIDATE_ZONES_GEOJSON
    )

    features = geojson.get(
        "features",
        []
    )

    if not isinstance(features, list):
        raise ReportServiceError(
            "Candidate zone GeoJSON contains no valid feature list."
        )

    zones: list[dict[str, Any]] = []

    for index, feature in enumerate(features, start=1):

        if not isinstance(feature, dict):
            continue

        properties = feature.get(
            "properties",
            {}
        )

        if not isinstance(properties, dict):
            properties = {}

        classification = str(
            _first_value(
                properties,
                [
                    "classification",
                    "class_name",
                    "zone_class",
                ],
                "UNKNOWN",
            )
        )

        area_ha = _safe_number(
            _first_value(
                properties,
                [
                    "area_hectares",
                    "area_ha",
                    "area",
                ],
                0,
            )
        )

        pixel_count = int(
            round(
                _safe_number(
                    _first_value(
                        properties,
                        [
                            "pixel_count",
                            "pixels",
                            "count",
                        ],
                        0,
                    )
                )
            )
        )

        mean_score = _safe_number(
            _first_value(
                properties,
                [
                    "mean_evidence_score",
                    "mean_score",
                    "evidence_score_mean",
                ],
                0,
            )
        )

        max_score = _safe_number(
            _first_value(
                properties,
                [
                    "max_evidence_score",
                    "max_score",
                    "evidence_score_max",
                ],
                0,
            )
        )

        mean_sar_change = _safe_number(
            _first_value(
                properties,
                [
                    "mean_sar_change",
                    "sar_change_mean",
                ],
                0,
            )
        )

        median_sar_change = _safe_number(
            _first_value(
                properties,
                [
                    "median_sar_change",
                    "sar_change_median",
                ],
                0,
            )
        )

        strong_fraction = _safe_number(
            _first_value(
                properties,
                [
                    "strong_flood_fraction",
                    "strong_fraction",
                ],
                0,
            )
        )

        zones.append(
            {
                "zone_id": str(
                    _first_value(
                        properties,
                        [
                            "zone_id",
                            "candidate_id",
                            "id",
                        ],
                        index,
                    )
                ),

                "classification": classification,

                "area_hectares": round(
                    area_ha,
                    2,
                ),

                "pixel_count": pixel_count,

                "mean_evidence_score": round(
                    mean_score,
                    4,
                ),

                "max_evidence_score": round(
                    max_score,
                    4,
                ),

                "mean_sar_change": round(
                    mean_sar_change,
                    4,
                ),

                "median_sar_change": round(
                    median_sar_change,
                    4,
                ),

                "strong_flood_fraction": round(
                    strong_fraction,
                    4,
                ),
            }
        )

    return zones


def _candidate_zone_summary(
    zones: list[dict[str, Any]]
) -> dict[str, Any]:

    classification_counts: Counter[str] = Counter()
    classification_area: dict[str, float] = {}

    total_area = 0.0

    for zone in zones:

        classification = str(
            zone["classification"]
        )

        area = _safe_number(
            zone["area_hectares"]
        )

        classification_counts[
            classification
        ] += 1

        classification_area[
            classification
        ] = (
            classification_area.get(
                classification,
                0.0
            ) + area
        )

        total_area += area

    return {
        "zone_count": len(zones),

        "candidate_area_hectares": round(
            total_area,
            2,
        ),

        "by_classification": {
            key: int(value)
            for key, value in classification_counts.items()
        },

        "area_by_classification_hectares": {
            key: round(value, 2)
            for key, value in classification_area.items()
        },

        "minimum_zone_area_hectares": (
            round(
                min(
                    (
                        zone["area_hectares"]
                        for zone in zones
                    ),
                    default=0,
                ),
                2,
            )
        ),

        "maximum_zone_area_hectares": (
            round(
                max(
                    (
                        zone["area_hectares"]
                        for zone in zones
                    ),
                    default=0,
                ),
                2,
            )
        ),

        "mean_zone_area_hectares": (
            round(
                (
                    sum(
                        zone["area_hectares"]
                        for zone in zones
                    )
                    / len(zones)
                ),
                2,
            )
            if zones
            else 0.0
        ),
    }


# ============================================================
# MATPLOTLIB FIGURES
# ============================================================

def _create_assessment_figures(
    report_id: str,
    zones: list[dict[str, Any]],
    legacy_statistics: dict[str, Any],
) -> dict[str, str]:

    figure_dir = (
        REPORTS_DIR
        / report_id
        / "figures"
    )

    figure_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    outputs: dict[str, str] = {}

    # --------------------------------------------------------
    # 1. Candidate area by classification
    # --------------------------------------------------------

    summary = _candidate_zone_summary(
        zones
    )

    area_data = (
        summary[
            "area_by_classification_hectares"
        ]
    )

    preferred_order = [
        "FLOOD_CANDIDATE",
        "STRONG_FLOOD_CANDIDATE",
    ]

    labels = [
        label
        for label in preferred_order
        if label in area_data
    ]

    # Include any additional classes without inventing them.
    labels.extend(
        label
        for label in area_data
        if label not in labels
    )

    values = [
        area_data[label]
        for label in labels
    ]

    fig, ax = plt.subplots(
        figsize=(9, 5.5)
    )

    if labels:

        display_labels = [
            label.replace(
                "_",
                " "
            ).title()
            for label in labels
        ]

        ax.bar(
            display_labels,
            values,
        )

        ax.set_ylabel(
            "Area (hectares)"
        )

        ax.set_title(
            "AGOS Flood Candidate Zone Area"
        )

        ax.grid(
            axis="y",
            alpha=0.25,
        )

        for index, value in enumerate(values):

            ax.text(
                index,
                value,
                f"{value:,.1f}",
                ha="center",
                va="bottom",
            )

    else:

        ax.text(
            0.5,
            0.5,
            "No candidate zones available",
            ha="center",
            va="center",
            transform=ax.transAxes,
        )

        ax.set_axis_off()

    fig.tight_layout()

    path = (
        figure_dir
        / "candidate_zone_area.png"
    )

    fig.savefig(
        path,
        dpi=160,
        bbox_inches="tight",
    )

    plt.close(fig)

    outputs["candidate_zone_area"] = str(path)

    # --------------------------------------------------------
    # 2. Zone-size distribution
    # --------------------------------------------------------

    zone_areas = [
        zone["area_hectares"]
        for zone in zones
        if _safe_number(
            zone["area_hectares"]
        ) > 0
    ]

    fig, ax = plt.subplots(
        figsize=(9, 5.5)
    )

    if zone_areas:

        ax.hist(
            zone_areas,
            bins=min(
                20,
                max(
                    5,
                    len(zone_areas)
                )
            ),
        )

        ax.set_xlabel(
            "Zone area (hectares)"
        )

        ax.set_ylabel(
            "Number of zones"
        )

        ax.set_title(
            "AGOS Candidate Zone Size Distribution"
        )

        ax.grid(
            axis="y",
            alpha=0.25,
        )

    else:

        ax.text(
            0.5,
            0.5,
            "No candidate zones available",
            ha="center",
            va="center",
            transform=ax.transAxes,
        )

        ax.set_axis_off()

    fig.tight_layout()

    path = (
        figure_dir
        / "candidate_zone_size_distribution.png"
    )

    fig.savefig(
        path,
        dpi=160,
        bbox_inches="tight",
    )

    plt.close(fig)

    outputs[
        "candidate_zone_size_distribution"
    ] = str(path)

    # --------------------------------------------------------
    # 3. Legacy evidence composition
    # --------------------------------------------------------

    evidence_labels = [
        "Water evidence",
        "Flood evidence",
    ]

    evidence_values = [
        _safe_number(
            legacy_statistics.get(
                "water_evidence_area_hectares",
                0,
            )
        ),
        _safe_number(
            legacy_statistics.get(
                "flood_evidence_area_hectares",
                0,
            )
        ),
    ]

    fig, ax = plt.subplots(
        figsize=(9, 5.5)
    )

    ax.bar(
        evidence_labels,
        evidence_values,
    )

    ax.set_ylabel(
        "Area (hectares)"
    )

    ax.set_title(
        "AGOS Legacy Evidence Areas"
    )

    ax.grid(
        axis="y",
        alpha=0.25,
    )

    for index, value in enumerate(
        evidence_values
    ):

        ax.text(
            index,
            value,
            f"{value:,.1f}",
            ha="center",
            va="bottom",
        )

    fig.tight_layout()

    path = (
        figure_dir
        / "legacy_evidence_area.png"
    )

    fig.savefig(
        path,
        dpi=160,
        bbox_inches="tight",
    )

    plt.close(fig)

    outputs[
        "legacy_evidence_area"
    ] = str(path)

    return outputs


# ============================================================
# REPORT BUILD
# ============================================================

def _build_report(
    requested_date: str,
    area: str,
    assessment_type: str,
) -> dict[str, Any]:

    metadata = _read_json(
        EVIDENCE_METADATA
    )

    geojson = _read_json(
        VALIDATION_GEOJSON
    )

    zones = _read_candidate_zones()

    evidence_model = metadata.get(
        "evidence_model",
        {}
    )

    rules = metadata.get(
        "rules",
        {}
    )

    statistics = metadata.get(
        "statistics",
        {}
    )

    warning = metadata.get(
        "warning"
    ) or (
        "This is an evidence-support product, "
        "not a validated official flood classification."
    )

    valid_pixels = int(
        statistics.get(
            "valid_combined_pixels",
            0
        )
    )

    flood_pixels = int(
        statistics.get(
            "flood_evidence_pixels",
            0
        )
    )

    water_pixels = int(
        statistics.get(
            "water_evidence_pixels",
            0
        )
    )

    optical_pixels = int(
        statistics.get(
            "optical_water_pixels",
            0
        )
    )

    sar_pixels = int(
        statistics.get(
            "sar_strong_change_pixels",
            0
        )
    )

    flood_area_hectares = round(
        flood_pixels * 0.01,
        2
    )

    water_area_hectares = round(
        water_pixels * 0.01,
        2
    )

    flood_percentage = (
        round(
            (flood_pixels / valid_pixels) * 100,
            4
        )
        if valid_pixels
        else 0.0
    )

    report_id = (
        "AGOS-"
        + datetime.now(
            timezone.utc
        ).strftime(
            "%Y%m%dT%H%M%SZ"
        )
    )

    legacy_statistics = {
        "valid_combined_pixels": valid_pixels,
        "optical_water_pixels": optical_pixels,
        "sar_strong_change_pixels": sar_pixels,
        "water_evidence_pixels": water_pixels,
        "flood_evidence_pixels": flood_pixels,
        "flood_evidence_percentage_of_valid_pixels": flood_percentage,
        "flood_evidence_area_hectares": flood_area_hectares,
        "water_evidence_area_hectares": water_area_hectares,
    }

    candidate_summary = _candidate_zone_summary(
        zones
    )

    figure_paths = _create_assessment_figures(
        report_id,
        zones,
        legacy_statistics,
    )

    report = {
        "report_id": report_id,

        "created_at": _utc_now(),

        "assessment_date": requested_date,

        "area": area,

        "assessment_type": assessment_type,

        "status": "completed",

        "data_scope": {
            "geographic_scope": "Province of Bataan",

            "requested_area_supported": (
                area == "Bataan"
            ),

            "source_data_date": (
                _extract_source_date(
                    metadata
                )
            ),

            "source_data_type": [
                "Sentinel-1 SAR change",
                "Sentinel-2 optical indices",
            ],
        },

        "evidence_model": {
            "sar_change_weight": (
                evidence_model.get(
                    "sar_change_weight"
                )
            ),

            "optical_water_weight": (
                evidence_model.get(
                    "optical_water_weight"
                )
            ),

            "vegetation_weight": (
                evidence_model.get(
                    "vegetation_weight"
                )
            ),

            "moisture_weight": (
                evidence_model.get(
                    "moisture_weight"
                )
            ),

            "flood_threshold": (
                evidence_model.get(
                    "flood_threshold"
                )
            ),
        },

        "rules": rules,

        "statistics": legacy_statistics,

        "candidate_zones": candidate_summary,

        "validation": _validation_summary(
            geojson
        ),

        "outputs": {
            "evidence_metadata": str(
                EVIDENCE_METADATA
            ),

            "validation_geojson": str(
                VALIDATION_GEOJSON
            ),

            "candidate_zones_geojson": str(
                CANDIDATE_ZONES_GEOJSON
            ),

            "candidate_zones_csv": str(
                CANDIDATE_ZONES_CSV
            ),

            "figures": figure_paths,
        },

        "interpretation": {
            "summary": (
                "The assessment summarizes "
                "satellite-derived flood evidence "
                "and conservative candidate zones "
                "from the currently imported and "
                "processed Bataan dataset."
            ),

            "candidate_zone_definition": (
                "Candidate zones are spatial clusters "
                "of strong SAR change with independent "
                "optical water and vegetation support. "
                "Strong flood candidates additionally "
                "have positive moisture support."
            ),

            "warning": warning,
        },
    }

    return report


# ============================================================
# CREATE REPORT
# ============================================================

def create_report(
    requested_date: str,
    area: str,
    assessment_type: str,
) -> dict[str, Any]:

    normalized_area = _normalize_area(
        area
    )

    normalized_type = (
        _normalize_assessment_type(
            assessment_type
        )
    )

    try:

        datetime.strptime(
            requested_date,
            "%Y-%m-%d"
        )

    except ValueError as exc:

        raise ReportServiceError(
            "assessment_date must use YYYY-MM-DD format."
        ) from exc

    report = _build_report(
        requested_date,
        normalized_area,
        normalized_type,
    )

    REPORTS_DIR.mkdir(
        parents=True,
        exist_ok=True
    )

    output_path = (
        REPORTS_DIR
        / f"{report['report_id']}.json"
    )

    report["outputs"][
        "report_json"
    ] = str(output_path)

    with output_path.open(
        "w",
        encoding="utf-8"
    ) as handle:

        json.dump(
            report,
            handle,
            indent=2
        )

    return report


# ============================================================
# REPORT LIST / DETAIL
# ============================================================

def list_reports() -> list[dict[str, Any]]:

    if not REPORTS_DIR.exists():
        return []

    reports: list[dict[str, Any]] = []

    for path in sorted(
        REPORTS_DIR.glob("AGOS-*.json"),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    ):

        try:

            reports.append(
                _read_json(path)
            )

        except ReportServiceError:
            continue

    return reports


def get_report(
    report_id: str
) -> dict[str, Any]:

    safe_id = report_id.strip()

    if (
        not safe_id
        or Path(safe_id).name != safe_id
    ):

        raise ReportServiceError(
            "Invalid report ID."
        )

    return _read_json(
        REPORTS_DIR
        / f"{safe_id}.json"
    )


# ============================================================
# CANDIDATE ZONE GEOJSON
# ============================================================

def get_candidate_zones_geojson() -> dict[str, Any]:

    return _read_json(
        CANDIDATE_ZONES_GEOJSON
    )


# ============================================================
# VALIDATION GEOJSON
# ============================================================

def get_validation_geojson() -> dict[str, Any]:

    return _read_json(
        VALIDATION_GEOJSON
    )


# ============================================================
# FIGURE PATH
# ============================================================

def get_report_figure(
    report_id: str,
    figure_name: str,
) -> Path:

    safe_id = report_id.strip()

    safe_name = Path(
        figure_name.strip()
    ).name

    if (
        not safe_id
        or Path(safe_id).name != safe_id
        or not safe_name.endswith(".png")
    ):

        raise ReportServiceError(
            "Invalid report figure."
        )

    path = (
        REPORTS_DIR
        / safe_id
        / "figures"
        / safe_name
    )

    if not path.exists():

        raise ReportServiceError(
            "Requested report figure does not exist."
        )

    return path