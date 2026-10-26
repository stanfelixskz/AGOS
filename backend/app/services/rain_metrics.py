"""
Rain metrics from several weather models, computed the right way round:
every metric (heaviest hour, heaviest 3 hours, totals) is computed for EACH
model's own series first, and only then combined across models.

Taking the median of each hour and adding the hours up is wrong for rain:
models put their showers in different hours, so the hour-by-hour median
washes the rain out and the total comes out too low. (Found when the flood
of 28 Aug 2026 in Dinalupihan was missed: the hourly-median total was
21.6 mm while the median of the six models' own totals was about 26 mm.)

Two ways to combine the models are offered:
  median  the middle model: a balanced "best guess"
  upper   the second-wettest model (with six models, about the 83rd
          percentile): a cautious value for flood warning, so one or two
          wet models are not outvoted by dry ones
"""

from __future__ import annotations

import statistics
from datetime import datetime, timedelta
from typing import Iterable

METRICS = ("peak_24h_mm_h", "peak_3h_mm", "total_24h_mm", "total_72h_mm", "past_72h_mm")
MIN_MODELS = 3


def _sum(values: list, need: int) -> float | None:
    valid = [v for v in values if v is not None]
    return round(sum(valid), 1) if len(valid) >= need else None


def _peak3(values: list) -> float | None:
    sums = [sum(values[i:i + 3]) for i in range(len(values) - 2) if None not in values[i:i + 3]]
    return round(max(sums), 1) if sums else None


def _pick(times: list[datetime], values: list, start: datetime, end: datetime) -> list:
    return [v for t, v in zip(times, values) if start <= t < end]


def series_metrics(times: list[datetime], values: list, start: datetime, mode: str = "forecast") -> dict[str, float | None]:
    """
    Metrics of ONE model's hourly series.
    mode "forecast": start = current hour; next 24 h, next 72 h, 72 h before start.
    mode "day":      start = local midnight of day D; day D, D-2..D, the 3 days before D.
    """
    if mode == "forecast":
        day = _pick(times, values, start, start + timedelta(hours=24))
        three = _pick(times, values, start, start + timedelta(hours=72))
    else:
        day = _pick(times, values, start, start + timedelta(days=1))
        three = _pick(times, values, start - timedelta(days=2), start + timedelta(days=1))
    before = _pick(times, values, start - timedelta(hours=72), start)
    valid_day = [v for v in day if v is not None]
    return {
        "peak_24h_mm_h": round(max(valid_day), 2) if valid_day else None,
        "peak_3h_mm": _peak3(day),
        "total_24h_mm": _sum(day, 20),
        "total_72h_mm": _sum(three, 60),
        "past_72h_mm": _sum(before, 60),
    }


def combine(values: Iterable[float | None], statistic: str = "median") -> float | None:
    """Combine one metric across models. None when fewer than MIN_MODELS have a value."""
    valid = sorted(v for v in values if v is not None)
    if len(valid) < MIN_MODELS:
        return None
    if statistic == "upper":
        return valid[-2]  # second-wettest model
    return round(statistics.median(valid), 2)


def ensemble_metrics(times: list[datetime], model_series: list[list], start: datetime,
                     mode: str = "forecast", statistic: str = "median") -> dict[str, object]:
    """Each model's metrics, and the combined value of every metric."""
    per_model = [series_metrics(times, series, start, mode) for series in model_series]
    combined = {m: combine((pm[m] for pm in per_model), statistic) for m in METRICS}
    return {**combined, "per_model": per_model, "statistic": statistic,
            "models": sum(1 for pm in per_model if pm["total_24h_mm"] is not None)}
