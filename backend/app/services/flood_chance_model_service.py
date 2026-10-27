"""
AGOS — chance that a town gets a listed flood in the next 3 days, from incoming rain, wet ground and
flood-prone ground (only for days when the incoming rain is in the top 10% of the town's own record).

How it was chosen (tools/check_chance_model.py, run on the AGOS database, leave-one-year-out):
  * wet ground (rain in the 14 days before) and flood-prone ground (share of the town rated high or very
    high by DENR-MGB) improved the held-out scores a little; spring tide and storm did not, so they are out.
  * the model's score ranks days in the right order, but its raw probabilities were too high at the top.
    So no raw probability is shown. Held-out days are grouped by score, and each group shows what actually
    happened to those days: lower (bottom half of scores), usual (next 30%) and higher (top 20%; the top 5%
    could not be told apart from the 15% below it).

A group's rate is the share of its held-out town-days that were followed by a listed flood within 3 days.
Neighbouring days repeat the same flood, so the 95% range is widened by treating about 4 days as one case.
Confidence is always low: about 109 flood town-cases, the flood list misses small floods (every rate is a
lower bound) and the rain is modeled. It is not a forecast and not an official warning, and it does not
change the warning sign.

The model is fitted offline by tools/build_chance_model.py (about a minute) and saved to
backend/data/chance_model.json (git-ignored). If that file is missing, the panel says so.
"""

from __future__ import annotations

import json
import math
from bisect import bisect_left
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

DATA_FILE = Path(__file__).resolve().parents[2] / "data" / "chance_model.json"
FROM_DATE = date(2011, 1, 1)
ENTRY_PERCENTILE = 90.0
FLOOD_AFTER_DAYS = 3
WET_DAYS = 14
RIDGE = 1.0
FACTORS = ("wet", "ground")
BAND_CUTS = (0.50, 0.80)
BANDS = ("lower", "usual", "higher")
DAYS_PER_CASE = 4
MIN_FLOOD_CASES = 30
MIN_P, MAX_P = 1e-6, 1 - 1e-6
SOURCE = ("AGOS fit on the stored ERA5 rain record (modeled), the AGOS flood list (news and official reports; small "
          "floods are missing) and the DENR-MGB flood susceptibility map")


# ------------------------------------------------------------------ small maths
def stretch(p: float) -> float:
    """Percentile (0-100) -> -ln(share of the record at or above it)."""
    return -math.log(max(1 - p / 100.0, 0.001))


def percentile(value: float, sorted_values: Sequence[float]) -> float:
    return 100.0 * bisect_left(sorted_values, value) / len(sorted_values)


def wilson_p(p: float, n: float, z: float = 1.96) -> tuple[float, float]:
    if n <= 0:
        return (0.0, 1.0)
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(max(0.0, p * (1 - p) / n + z * z / (4 * n * n)))
    return (max(0.0, (c - m) / d), min(1.0, (c + m) / d))


def sigmoid(z: float) -> float:
    return 1 / (1 + math.exp(-z)) if z >= 0 else math.exp(z) / (1 + math.exp(z))


def solve(a: list[list[float]], b: list[float]) -> list[float]:
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[piv] = m[piv], m[c]
        if abs(m[c][c]) < 1e-12:
            raise ValueError("singular")
        for r in range(n):
            if r != c:
                f = m[r][c] / m[c][c]
                for k in range(c, n + 1):
                    m[r][k] -= f * m[c][k]
    return [m[i][n] / m[i][i] for i in range(n)]


def fit(x: list[list[float]], y: list[int], ridge: float = RIDGE, iterations: int = 40) -> list[float]:
    """Logistic regression by Newton steps; rows start with 1 (intercept, not penalised)."""
    k = len(x[0])
    w = [0.0] * k
    for _ in range(iterations):
        grad = [0.0] * k
        hess = [[0.0] * k for _ in range(k)]
        for row, yi in zip(x, y):
            p = sigmoid(sum(wi * xi for wi, xi in zip(w, row)))
            g, h = p - yi, p * (1 - p)
            for i in range(k):
                grad[i] += g * row[i]
                for j in range(k):
                    hess[i][j] += h * row[i] * row[j]
        for i in range(1, k):
            grad[i] += ridge * w[i]
            hess[i][i] += ridge
        step = solve(hess, grad)
        w = [wi - si for wi, si in zip(w, step)]
        if max(abs(s) for s in step) < 1e-8:
            break
    return w


def predict(w: Sequence[float], row: Sequence[float]) -> float:
    return min(MAX_P, max(MIN_P, sigmoid(sum(wi * xi for wi, xi in zip(w, row)))))


# ------------------------------------------------------------------ rows
def rolling(daily: Mapping[date, float], length: int) -> dict[date, float]:
    out = {}
    for d in daily:
        days = [d - timedelta(days=k) for k in range(length)]
        if all(x in daily for x in days):
            out[d] = sum(daily[x] for x in days)
    return out


def flood_starts_by_town(events: Sequence[Mapping[str, Any]]) -> dict[str, list[date]]:
    out: dict[str, set[date]] = {}
    for e in events:
        if not e.get("start_date") or e.get("date_basis") == "article_date":
            continue
        for t in e.get("towns", []):
            if t.get("evidence") == "flooded":
                out.setdefault(t["municipality"], set()).add(date.fromisoformat(e["start_date"]))
    return {k: sorted(v) for k, v in out.items()}


def build_rows(daily_by_town: Mapping[str, Mapping[date, float]], floods: Mapping[str, list[date]],
               ground: Mapping[str, float], first: date = FROM_DATE) -> list[dict[str, Any]]:
    """One row per town and day whose incoming rain (largest 3-day total ending D, D+1, D+2) is in the top 10%."""
    rows = []
    for town, daily in daily_by_town.items():
        r3, r14 = rolling(daily, 3), rolling(daily, WET_DAYS)
        if not r3 or not r14:
            continue
        s3, s14 = sorted(r3.values()), sorted(r14.values())
        last = max(r3) - timedelta(days=FLOOD_AFTER_DAYS)
        starts = floods.get(town, [])
        d = first
        while d <= last:
            incoming = [r3[x] for x in (d, d + timedelta(days=1), d + timedelta(days=2)) if x in r3]
            before = d - timedelta(days=1)
            if incoming and before in r14:
                p_in = percentile(max(incoming), s3)
                if p_in >= ENTRY_PERCENTILE:
                    hit = next((f for f in starts if d <= f <= d + timedelta(days=FLOOD_AFTER_DAYS)), None)
                    rows.append({"town": town, "day": d, "year": d.year, "rain": stretch(p_in),
                                 "wet": stretch(percentile(r14[before], s14)), "ground": ground.get(town, 0.0),
                                 "flood": hit, "y": 1 if hit else 0})
            d += timedelta(days=1)
    return rows


def _scale(rows: Sequence[Mapping[str, Any]]) -> dict[str, list[float]]:
    out = {}
    for name in ("rain",) + FACTORS:
        values = [r[name] for r in rows]
        mean = sum(values) / len(values)
        sd = math.sqrt(sum((v - mean) ** 2 for v in values) / len(values)) or 1.0
        out[name] = [mean, sd]
    return out


def _design(rows: Sequence[Mapping[str, Any]], scale: Mapping[str, Sequence[float]]) -> list[list[float]]:
    return [[1.0] + [(r[n] - scale[n][0]) / scale[n][1] for n in ("rain",) + FACTORS] for r in rows]


# ------------------------------------------------------------------ train and score
def train(records: Mapping[str, Any], events: Sequence[Mapping[str, Any]], ground: Mapping[str, float]) -> dict[str, Any] | None:
    """Fit on all years, group leave-one-year-out scores into bands and measure each band. None without enough floods."""
    daily = {name: {date.fromisoformat(k): float(v) for k, v in (rec.get("daily") or {}).items() if v is not None}
             for name, rec in records.get("towns", {}).items()}
    floods = flood_starts_by_town(events)
    rows = build_rows(daily, floods, ground)
    cases = {(r["town"], r["flood"]) for r in rows if r["y"]}
    if not rows or len(cases) < MIN_FLOOD_CASES:
        return None
    scale = _scale(rows)
    preds, used = [], []
    for year in sorted({r["year"] for r in rows}):
        train_rows = [r for r in rows if r["year"] != year]
        test_rows = [r for r in rows if r["year"] == year]
        if not test_rows or not any(r["y"] for r in train_rows):
            continue
        w = fit(_design(train_rows, scale), [r["y"] for r in train_rows])
        preds += [predict(w, line) for line in _design(test_rows, scale)]
        used += test_rows
    order = sorted(range(len(preds)), key=lambda i: preds[i])
    cuts = [preds[order[int(len(order) * c)]] for c in BAND_CUTS]
    groups: dict[str, list[int]] = {b: [] for b in BANDS}
    for i, p in enumerate(preds):
        groups[band_for(p, cuts)].append(i)
    bands = []
    for name in BANDS:
        idx = groups[name]
        if not idx:
            continue
        rate = sum(used[i]["y"] for i in idx) / len(idx)
        low, high = wilson_p(rate, max(1.0, len(idx) / DAYS_PER_CASE))
        bands.append({"band": name, "rows": len(idx), "rate": round(rate, 4), "range_95": [round(low, 4), round(high, 4)],
                      "flood_cases": len({(used[i]["town"], used[i]["flood"]) for i in idx if used[i]["y"]})})
    weights = fit(_design(rows, scale), [r["y"] for r in rows])
    return {
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "from": FROM_DATE.isoformat(), "to": max(r["day"] for r in rows).isoformat(),
        "rows": len(rows), "flood_cases": len(cases), "horizon_days": FLOOD_AFTER_DAYS,
        "entry_percentile": ENTRY_PERCENTILE, "factors": list(FACTORS),
        "weights": [round(x, 6) for x in weights], "scale": {k: [round(v[0], 6), round(v[1], 6)] for k, v in scale.items()},
        "cuts": [round(c, 6) for c in cuts], "bands": bands,
        "rain_record": (records.get("record") or {}).get("label"), "source": SOURCE,
    }


def band_for(p: float, cuts: Sequence[float]) -> str:
    return BANDS[0] if p < cuts[0] else (BANDS[1] if p < cuts[1] else BANDS[2])


def score(model: Mapping[str, Any] | None, rain_percentile: float | None, wet_percentile: float | None,
          ground_share: float | None) -> dict[str, Any] | None:
    """The band a town falls in today, or a short reason. None when no model is available."""
    if not model:
        return None
    if rain_percentile is None or wet_percentile is None or ground_share is None:
        return {"band": None, "reason": "missing_input"}
    if rain_percentile < model["entry_percentile"]:
        return {"band": None, "reason": "below_range"}
    values = {"rain": stretch(rain_percentile), "wet": stretch(wet_percentile), "ground": ground_share}
    line = [1.0] + [(values[n] - model["scale"][n][0]) / model["scale"][n][1] for n in ("rain",) + tuple(model["factors"])]
    band = band_for(predict(model["weights"], line), model["cuts"])
    row = next(b for b in model["bands"] if b["band"] == band)
    return {"band": band, "rate": row["rate"], "range_95": row["range_95"], "rows": row["rows"],
            "horizon_days": model["horizon_days"], "confidence": "low",
            "reasons": ["few_cases", "list_incomplete", "modeled_rain"],
            "inputs": {"rain_percentile": round(rain_percentile, 1), "wet_percentile": round(wet_percentile, 1),
                       "ground_share": round(ground_share, 4)}}


# ------------------------------------------------------------------ file
def save(model: Mapping[str, Any], path: Path = DATA_FILE) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(model, indent=1), encoding="utf-8")
    return path


_cache: dict[str, Any] = {"key": None, "value": None}


def load(path: Path = DATA_FILE) -> dict[str, Any] | None:
    """The saved model, or None if the file is missing or unreadable. Re-read when the file changes."""
    try:
        stamp = path.stat().st_mtime_ns
    except OSError:
        return None
    key = (str(path), stamp)
    if _cache["key"] != key:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            ok = all(k in data for k in ("weights", "scale", "cuts", "bands", "entry_percentile", "factors", "horizon_days"))
        except (OSError, ValueError):
            data, ok = None, False
        _cache.update(key=key, value=data if ok else None)
    return _cache["value"]
