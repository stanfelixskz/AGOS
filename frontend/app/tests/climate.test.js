import { test } from "node:test";
import assert from "node:assert/strict";
import { renderClimate, percent, percentRange, monthName } from "../js/views/parts/climate.js";

const levels = { status: "ok", n_years: 11, observed_max_mm: 150, levels: [{ years: 10, mm: 160, low: 120, high: 230 }], exceedance: [{ mm: 100, probability: 0.2, low: 0.1, high: 0.3 }] };
const town = (extra = {}) => ({
  name: "Balanga", full_years: 11, monthly: [], trend: { status: "ok", slope_mm_per_year: 12.4, distinguishable_from_zero: false },
  years: [{ year: 2020, complete: true, total_mm: 2000, wettest_day: { date: "2020-08-15", mm: 150 } }],
  return_levels: levels, ...extra,
});
const payload = (t) => ({ any_data: true, first_year: 2015, last_year: 2026, towns: [t] });

test("percent never shows a bare zero for a small chance", () => {
  assert.equal(percent(0.004), "<1%");
  assert.equal(percent(0.2), "20%");
  assert.equal(percent(null), "—");
});

test("a range of two tiny chances is not shown as <1%–<1%", () => {
  assert.equal(percentRange(0.001, 0.004), "<1%");
  assert.equal(percentRange(0.078, 0.38), "7.8%–38%");
});

test("range is always shown next to the estimate, with the caveat", () => {
  const html = renderClimate(payload(town()), "Balanga");
  assert.match(html, /160 mm/);
  assert.match(html, /120–230 mm/);
  assert.match(html, /not a forecast/i);
  assert.match(html, /within normal year-to-year swings/);
});

test("too few years explains why instead of showing numbers", () => {
  const html = renderClimate(payload(town({ return_levels: { status: "insufficient_data", n_years: 6, needed: 10 } })), "Balanga");
  assert.match(html, /at least 10 full years/);
  assert.doesNotMatch(html, /Likely range/);
});

test("no data points to the backfill tool", () => {
  assert.match(renderClimate({ any_data: false, towns: [] }, "Balanga"), /backfill_history/);
});

test("month names come out in both languages", () => {
  assert.ok(monthName(1, "en").length > 0 && monthName(1, "fil").length > 0);
});
