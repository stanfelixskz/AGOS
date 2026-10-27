"""
Does adding wet ground, flood-prone ground, spring tide or storm to the incoming rain give a better flood chance?

Read-only: prints a result, writes nothing.  Run from backend/ (needs the AGOS database):
    python tools/check_chance_model.py [path/to/ibtracs.WP.list.v04r01.csv]
The IBTrACS file is optional; without it the storm factor is simply not tested.

Rows: one per town and day D (2011 on) on which the incoming rain is at least a little unusual:
the largest 3-day total among the windows ending D, D+1 and D+2 (what the warning sign looks at) is
in the top 10% of that town's own record. Outcome: that town has a listed flood that began from D
to D+3. Factors tried on top of the incoming rain (all computed only from what is known on day D):
  wet     rain over the 14 days before D, as a rank in the town's own record
  ground  share of the town's area that DENR-MGB maps as high or very high flood susceptibility
  tide    a new or full moon within 2 days of D..D+2 (spring tide, from the moon)
  storm   a tropical storm (>= 34 kt) within 500 km of Bataan from D-2 to D+1 (needs the IBTrACS file)
Each model is a plain logistic regression. Models are compared by leave-one-year-out testing, so a
model is judged on years it was not fitted on: log-loss (lower is better), Brier score (lower is
better) and AUC (higher is better, 0.5 is a coin flip). A factor earns a place only if it improves
the held-out log-loss in most years that have a flood, not just on average.

Honest limits: about 25 listed floods (about 90 town-cases) is small, and rows on neighbouring days
and towns overlap, so the effective sample is closer to the number of town-cases than to the row
count. Ranges and p-values are therefore rough; "no improvement" means "not detectable with this
list". The flood list misses small floods. Rain is ERA5 (modeled). This is a suggestion, never proof,
and it does not change the warning sign.
"""

from __future__ import annotations

import json
import math
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tools import check_storms as cs  # noqa: E402

FROM_DATE = date(2011, 1, 1)
ENTRY_PERCENTILE = 90.0
FLOOD_AFTER_DAYS = 3
WET_DAYS = 14
RIDGE = 1.0
MIN_P, MAX_P = 1e-6, 1 - 1e-6
STORM_KT, STORM_KM = 34, 500
MODELS = {
    "rain only": [],
    "rain + wet ground": ["wet"],
    "rain + flood-prone ground": ["ground"],
    "rain + spring tide": ["tide"],
    "rain + storm": ["storm"],
    "rain + wet + ground": ["wet", "ground"],
    "rain + all factors": ["wet", "ground", "tide", "storm"],
}


# ------------------------------------------------------------------ data
def percentile(value: float, sorted_values: list[float]) -> float:
    from bisect import bisect_left

    return 100.0 * bisect_left(sorted_values, value) / len(sorted_values)


def stretch(p: float) -> float:
    """Percentile (0-100) -> -ln(share of the record at or above it): 95 -> 3.0, 99 -> 4.6, 99.9 -> 6.9."""
    return -math.log(max(1 - p / 100.0, 0.001))


def rolling(daily: dict[date, float], length: int) -> dict[date, float]:
    out = {}
    for d in daily:
        days = [d - timedelta(days=k) for k in range(length)]
        if all(x in daily for x in days):
            out[d] = sum(daily[x] for x in days)
    return out


def flood_town_days(path: Path = cs.EVENTS) -> dict[str, list[date]]:
    """{town: start days of listed floods that flooded it} (dated, not article-date only)."""
    with open(path, encoding="utf-8") as handle:
        events = json.load(handle)["events"]
    out: dict[str, set[date]] = {}
    for e in events:
        if not e.get("start_date") or e.get("date_basis") == "article_date":
            continue
        for t in e.get("towns", []):
            if t.get("evidence") == "flooded":
                out.setdefault(t["municipality"], set()).add(date.fromisoformat(e["start_date"]))
    return {k: sorted(v) for k, v in out.items()}


def build_rows(daily_by_town: dict[str, dict[date, float]], floods: dict[str, list[date]], ground: dict[str, float],
               tide_flag, storm_flag, first: date = FROM_DATE) -> list[dict]:
    """One row per town and day with incoming rain in the top 10% of that town's record."""
    rows = []
    for town, daily in daily_by_town.items():
        r3 = rolling(daily, 3)
        r14 = rolling(daily, WET_DAYS)
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
                    rows.append({
                        "town": town, "day": d, "year": d.year,
                        "rain": stretch(p_in),
                        "wet": stretch(percentile(r14[before], s14)),
                        "ground": ground.get(town, 0.0),
                        "tide": 1.0 if tide_flag(d) else 0.0,
                        "storm": 1.0 if storm_flag(d) else 0.0,
                        "flood": next((f for f in starts if d <= f <= d + timedelta(days=FLOOD_AFTER_DAYS)), None),
                        "y": 1 if any(d <= f <= d + timedelta(days=FLOOD_AFTER_DAYS) for f in starts) else 0,
                    })
            d += timedelta(days=1)
    return rows


# ------------------------------------------------------------------ logistic regression (no numpy needed)
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


def sigmoid(z: float) -> float:
    return 1 / (1 + math.exp(-z)) if z >= 0 else math.exp(z) / (1 + math.exp(z))


def fit(x: list[list[float]], y: list[int], ridge: float = RIDGE, iterations: int = 40) -> list[float]:
    """Logistic regression by Newton steps; x rows start with 1 (intercept, not penalised)."""
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


def predict(w: list[float], row: list[float]) -> float:
    return min(MAX_P, max(MIN_P, sigmoid(sum(wi * xi for wi, xi in zip(w, row)))))


def auc(scores: list[float], y: list[int]) -> float | None:
    pos = [s for s, v in zip(scores, y) if v]
    neg = [s for s, v in zip(scores, y) if not v]
    if not pos or not neg:
        return None
    ranked = sorted(range(len(scores)), key=lambda i: scores[i])
    rank = [0.0] * len(scores)
    i = 0
    while i < len(ranked):
        j = i
        while j + 1 < len(ranked) and scores[ranked[j + 1]] == scores[ranked[i]]:
            j += 1
        for t in range(i, j + 1):
            rank[ranked[t]] = (i + j) / 2 + 1
        i = j + 1
    rank_sum = sum(rank[i] for i, v in enumerate(y) if v)
    return (rank_sum - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def design(rows: list[dict], factors: list[str], scale: dict[str, tuple[float, float]]) -> list[list[float]]:
    out = []
    for r in rows:
        line = [1.0]
        for name in ["rain"] + factors:
            mean, sd = scale[name]
            line.append((r[name] - mean) / sd)
        out.append(line)
    return out


def scale_of(rows: list[dict], names: list[str]) -> dict[str, tuple[float, float]]:
    out = {}
    for n in names:
        values = [r[n] for r in rows]
        mean = sum(values) / len(values)
        sd = math.sqrt(sum((v - mean) ** 2 for v in values) / len(values)) or 1.0
        out[n] = (mean, sd)
    return out


def loss(p: float, y: int) -> float:
    return -math.log(p if y else 1 - p)


def cross_validate(rows: list[dict], factors: list[str]) -> dict:
    """Leave-one-year-out: fit on the other years, score the held-out year."""
    names = ["rain"] + factors
    scale = scale_of(rows, names)
    preds, ys, used = [], [], []
    year_loss: dict[int, float] = {}
    for year in sorted({r["year"] for r in rows}):
        train = [r for r in rows if r["year"] != year]
        test = [r for r in rows if r["year"] == year]
        if not train or not test or not any(r["y"] for r in train):
            continue
        w = fit(design(train, factors, scale), [r["y"] for r in train])
        p = [predict(w, line) for line in design(test, factors, scale)]
        preds += p
        ys += [r["y"] for r in test]
        used += test
        year_loss[year] = sum(loss(pi, r["y"]) for pi, r in zip(p, test))
    n = len(ys)
    return {
        "rows": n, "positives": sum(ys),
        "log_loss": sum(loss(p, y) for p, y in zip(preds, ys)) / n if n else None,
        "brier": sum((p - y) ** 2 for p, y in zip(preds, ys)) / n if n else None,
        "auc": auc(preds, ys), "year_loss": year_loss, "preds": preds, "ys": ys, "used": used,
    }


def compare(rows: list[dict], models: dict[str, list[str]] = MODELS) -> list[dict]:
    """CV scores per model, plus how many flood-years each beats the rain-only model in held-out log-loss."""
    results = {name: cross_validate(rows, f) for name, f in models.items()}
    base = results.get("rain only")
    flood_years = {r["year"] for r in rows if r["y"]}
    out = []
    for name, res in results.items():
        better = worse = 0
        if base and name != "rain only":
            for y in flood_years:
                a, b = res["year_loss"].get(y), base["year_loss"].get(y)
                if a is None or b is None:
                    continue
                better += a < b
                worse += a > b
        out.append({"model": name, "factors": models[name], **{k: res[k] for k in ("rows", "positives", "log_loss", "brier", "auc")},
                    "flood_years_better": better, "flood_years_worse": worse,
                    "delta_log_loss": (res["log_loss"] - base["log_loss"]) if base and res["log_loss"] is not None else None})
    return out


def calibration(preds: list[float], ys: list[int], edges=(0.02, 0.05, 0.10, 0.20)) -> list[dict]:
    bins = [(0.0, edges[0])] + [(edges[i], edges[i + 1]) for i in range(len(edges) - 1)] + [(edges[-1], 1.01)]
    out = []
    for lo, hi in bins:
        idx = [i for i, p in enumerate(preds) if lo <= p < hi]
        if idx:
            out.append({"from": lo, "to": min(hi, 1.0), "rows": len(idx), "predicted": sum(preds[i] for i in idx) / len(idx),
                        "observed": sum(ys[i] for i in idx) / len(idx)})
    return out


BAND_CUTS = (0.50, 0.80, 0.95)  # share of held-out rows below each cut: bottom half, next 30%, next 15%, top 5%


def bands(res: dict, cuts=BAND_CUTS) -> list[dict]:
    """Groups of held-out rows by the model's score, with the share actually followed by a flood.

    Reports distinct flood town-cases per group because neighbouring days repeat the same flood.
    """
    order = sorted(range(len(res["preds"])), key=lambda i: res["preds"][i])
    n = len(order)
    edges = [0] + [int(n * c) for c in cuts] + [n]
    out = []
    for lo, hi in zip(edges, edges[1:]):
        idx = order[lo:hi]
        if not idx:
            continue
        cases = {(res["used"][i]["town"], res["used"][i]["flood"]) for i in idx if res["ys"][i]}
        k = sum(res["ys"][i] for i in idx)
        windows = max(1, len(idx) // 4)  # rough: about 4 neighbouring days repeat each case
        low, high = cs.wilson(min(len(cases), windows), windows)
        out.append({
            "from_share": lo / n, "to_share": hi / n, "rows": len(idx),
            "mean_predicted": sum(res["preds"][i] for i in idx) / len(idx),
            "observed": k / len(idx), "flood_cases": len(cases),
            "case_rate": min(len(cases), windows) / windows, "case_range_95": (low, high),
        })
    return out


# ------------------------------------------------------------------ database and main
def load_inputs(track_path: Path | None):
    from app.data.municipalities import MUNICIPALITIES
    from app.services import evidence_service as ev
    from app.services import susceptibility_service as ss
    from app.services import tide_service as ts
    from app.services.climate_service import load_daily_rain, rain_record

    connection = ev._default_connect()
    try:
        record = rain_record(connection)
        daily = {name: {date.fromisoformat(k): v for k, v in load_daily_rain(connection, point, record["source"]).items()}
                 for name, point in MUNICIPALITIES.items()}
    finally:
        connection.close()
    report = ss.susceptibility_report()
    ground = {}
    if report.get("available"):
        for row in report.get("towns", []):
            shares = row.get("shares") or {}
            ground[row["name"]] = shares.get("high", 0.0) + shares.get("very_high", 0.0)

    def tide_flag(d: date) -> bool:
        return any(ts.days_from_syzygy(d + timedelta(days=k)) <= ts.WINDOW_DAYS for k in range(3))

    storm_flag = lambda d: False  # noqa: E731
    has_storm = False
    if track_path and track_path.exists():
        nearest = cs.daily_nearest(cs.read_tracks(track_path), cs.bataan_points(), STORM_KT)
        storm_flag = lambda d: any((d + timedelta(days=k)) in nearest and nearest[d + timedelta(days=k)][0] <= STORM_KM for k in range(-2, 2))  # noqa: E731
        has_storm = True
    return daily, ground, tide_flag, storm_flag, has_storm, record, bool(ground)


def main(argv: list[str]) -> int:
    track = Path(argv[1]) if len(argv) > 1 else cs.DEFAULT_TRACKS
    try:
        daily, ground, tide_flag, storm_flag, has_storm, record, has_ground = load_inputs(track)
    except Exception as error:  # noqa: BLE001 - say why and stop, never guess
        print(f"Could not read the stored rain record ({type(error).__name__}: {error}). Nothing was calculated.")
        return 2
    if not any(daily.values()):
        print("The AGOS database has no stored rain record. Nothing was calculated.")
        return 2
    floods = flood_town_days()
    rows = build_rows(daily, floods, ground, tide_flag, storm_flag)
    if not rows or not any(r["y"] for r in rows):
        print("No usable rows or no listed flood among them. Nothing was calculated.")
        return 2
    models = {k: v for k, v in MODELS.items()
              if (has_ground or "ground" not in v) and (has_storm or "storm" not in v)}
    print(f"Rain record: {record.get('label')}")
    print(f"Rows (town-days with incoming rain in the top 10% of the town's record, {FROM_DATE} on): {len(rows)}; "
          f"followed by a listed flood within {FLOOD_AFTER_DAYS} days: {sum(r['y'] for r in rows)} "
          f"({sum(r['y'] for r in rows) / len(rows):.1%})")
    print(f"Listed flood town-cases since {FROM_DATE}: {sum(1 for v in floods.values() for d in v if d >= FROM_DATE)}")
    if not has_ground:
        print("(flood-prone ground share not available: those models are skipped)")
    if not has_storm:
        print("(no IBTrACS file: storm models are skipped)")
    print("\nLeave-one-year-out scores (log-loss, Brier lower is better; AUC higher is better):")
    scores = compare(rows, models)
    for s in scores:
        extra = "" if s["model"] == "rain only" else (
            f"  vs rain only: log-loss {s['delta_log_loss']:+.4f}, better in {s['flood_years_better']} / worse in {s['flood_years_worse']} flood-years")
        auc_text = "n/a" if s["auc"] is None else f"{s['auc']:.3f}"
        print(f"  {s['model']:<28} log-loss {s['log_loss']:.4f}  Brier {s['brier']:.4f}  AUC {auc_text}{extra}")
    base = cross_validate(rows, [])
    print("\nCalibration of the rain-only model (held-out years): predicted vs observed share of rows followed by a flood")
    for b in calibration(base["preds"], base["ys"]):
        print(f"  predicted {b['from']:.0%}-{b['to']:.0%}: {b['rows']} rows, predicted {b['predicted']:.1%}, observed {b['observed']:.1%}")
    for name in ("rain + wet ground", "rain + wet + ground"):
        if name not in models:
            continue
        res = cross_validate(rows, models[name])
        print(f"\nHeld-out score groups for '{name}' (lowest to highest score; flood cases = distinct town floods, "
              "rate per about 4 neighbouring days is rough):")
        for b in bands(res):
            print(f"  rows {b['from_share']:.0%}-{b['to_share']:.0%} by score: {b['rows']} rows, predicted {b['mean_predicted']:.1%}, "
                  f"observed {b['observed']:.1%}, flood cases {b['flood_cases']}, "
                  f"cases per independent window {b['case_rate']:.1%} (95% range {b['case_range_95'][0]:.1%}-{b['case_range_95'][1]:.1%})")
    full_names = ["rain", "wet", "ground", "tide", "storm"]
    scale = scale_of(rows, full_names)
    print("\nCoefficients fitted on all years (per 1 standard deviation; positive = more floods):")
    for name, factors in models.items():
        w = fit(design(rows, factors, scale), [r["y"] for r in rows])
        parts = ", ".join(f"{n} {c:+.2f}" for n, c in zip(["intercept", "rain"] + factors, w))
        print(f"  {name:<28} {parts}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
