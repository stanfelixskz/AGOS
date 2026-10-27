import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setLang } from "../js/core/i18n.js";
import { factorsTown, topMonths, wetWords, renderFactorsBanner, renderFactorsBody, chanceRow, chanceTodayRow } from "../js/views/parts/factors.js";
import { outerRings, unionOutline, outsideMask, outlookRows, raisedTowns } from "../js/map/outlook.js";

setLang("en");

const town = (name, level, extra = {}) => ({
  name, state: level === "no_data" ? "no_data" : ["watch", "warning", "high_warning"].includes(level) ? "raised" : "ordinary",
  rain: { level, peak: level === "no_data" ? null : { mm: 120, end: "2026-10-27", percentile: 98.5 }, daily: [{ date: "2026-10-26", mm: 40 }] },
  wet_ground: { mm: 180, days: 14, percentile: 93 }, susceptibility: null, floods: { listed_floods: 2, months: [0, 0, 0, 0, 0, 0, 3, 5, 2, 0, 0, 0], latest: "2021-07-29", barangays: [] },
  ...extra,
});
const ok = (towns, extra = {}) => ({ status: "ok", data: { mode: "forecast", date: "2026-10-26", issued_at: "2026-10-26T10:00:00+08:00", raised: towns.filter((x) => x.state === "raised").map((x) => x.name), towns, backing: {}, events_near: [], ...extra } });

test("factorsTown finds a town and tolerates unavailable data", () => {
  const f = ok([town("Hermosa", "warning")]);
  assert.equal(factorsTown(f, "Hermosa").name, "Hermosa");
  assert.equal(factorsTown(f, "Nope"), null);
  assert.equal(factorsTown({ status: "unavailable", detail: "x" }, "Hermosa"), null);
});

test("topMonths and wetWords", () => {
  assert.equal(topMonths([0, 0, 0, 0, 0, 0, 3, 5, 2, 0, 0, 0]), "July, August, September");
  assert.equal(topMonths([]), "");
  assert.match(wetWords(95), /95/);
  assert.equal(wetWords(null), "—");
  assert.doesNotMatch(wetWords(50), /50/);
});

test("banner states: raised, ordinary, no data, replay, nothing for unknown town", () => {
  assert.match(renderFactorsBanner(ok([town("A", "warning")]), "A"), /data-state="raised"/);
  assert.match(renderFactorsBanner(ok([town("A", "normal")]), "A"), /data-state="ordinary"/);
  assert.match(renderFactorsBanner(ok([town("A", "no_data")]), "A"), /data-state="no_data"/);
  assert.match(renderFactorsBanner(ok([town("A", "normal")], { mode: "replay", date: "2021-07-27" }), "A"), /2021/);
  assert.equal(renderFactorsBanner(ok([town("A", "normal")]), "B"), "");
  assert.equal(renderFactorsBanner({ status: "unavailable", detail: "x" }, "A"), "");
});

test("body lists the factors and says what is not included", () => {
  const html = renderFactorsBody(ok([town("A", "warning")]), "A");
  assert.equal((html.match(/is-off/g) || []).length, 3);
  assert.match(html, /Not an official warning|not an official/i);
  assert.match(renderFactorsBody({ status: "unavailable", detail: "boom" }, "A"), /boom/);
});

test("outlook rows and raised towns", () => {
  const f = ok([town("A", "warning"), town("B", "normal"), town("C", "no_data")]);
  assert.deepEqual(outlookRows(f), [{ name: "A", raised: true }, { name: "B", raised: false }, { name: "C", raised: false }]);
  assert.deepEqual(raisedTowns(f), ["A"]);
  assert.deepEqual(outlookRows({ status: "unavailable" }), []);
});

test("outline stitches the real PSGC towns into one mask", () => {
  const file = JSON.parse(readFileSync(new URL("../data/bataan-municipalities-psgc2023.geojson", import.meta.url), "utf8"));
  assert.equal(outerRings(file.features).length, file.features.length);
  const mask = outsideMask(file.features);
  assert.ok(mask);
  const rings = mask.features[0].geometry.coordinates;
  assert.equal(rings.length, 1 + unionOutline(file.features).length);
  assert.equal(outsideMask([]), null);
});

const tideData = (spring) => ({
  window_days: 2,
  days: [{ date: "2026-10-25", spring: false, moon: "new", days_from_moon: 3 }, { date: "2026-10-26", spring, moon: "full", days_from_moon: 0.4 }],
  spring_in_window: spring, part_of_sign: false,
  tested: { events: 28, near_spring: 10, share: 0.36, expected_share_if_no_link: 0.27 },
});

test("tide row: spring tide, ordinary tide, overlap line and missing data", () => {
  const spring = renderFactorsBody(ok([town("A", "warning", { tide_overlap: true })], { tide: tideData(true) }), "A");
  assert.match(spring, /Spring tide around the full moon/);
  assert.match(spring, /factor-precaution/);
  assert.match(spring, /10 of 28/);
  assert.match(spring, /not a tide gauge/i);
  const calm = renderFactorsBody(ok([town("A", "normal", { tide_overlap: false })], { tide: tideData(false) }), "A");
  assert.match(calm, /ordinary tide range/);
  assert.doesNotMatch(calm, /factor-precaution/);
  const none = renderFactorsBody(ok([town("A", "warning")]), "A");
  assert.match(none, /no tide gauge or official tide table/);
  assert.equal((none.match(/is-off/g) || []).length, 3);
});

const chanceTable = { from: "2011-01-01", to: "2026-10-19", not_a_forecast: true, includes_replayed_day: false, levels: [] };
const chance = (extra = {}) => ({ level: "warning", spells: 40, floods: 9, rate: 0.225, range_95: [0.123, 0.378], confidence: "medium", reasons: ["list_incomplete", "modeled_rain"], ...extra });

test("chance row: rate with range and confidence for a raised town", () => {
  const html = chanceRow({ chance: chance() }, { chance: chanceTable });
  assert.match(html, /9 ended in a listed flood/);
  assert.match(html, /23%/);
  assert.match(html, /12% to 38%/);
  assert.match(html, /Confidence: medium/);
  assert.match(html, /misses small floods/);
  assert.match(html, /Not a forecast/);
  assert.doesNotMatch(html, /Confidence: high/);
});

test("chance row: too few spells gives no rate; ordinary town and missing table say so", () => {
  const few = chanceRow({ chance: chance({ spells: 4, floods: 2, rate: null, range_95: null, confidence: "none" }) }, { chance: chanceTable });
  assert.match(few, /only 4 past spells/);
  assert.doesNotMatch(few, /95% range/);
  assert.match(chanceRow({ chance: null }, { chance: chanceTable }), /Shown when the sign is raised/);
  const none = chanceRow({ chance: null }, { chance: null });
  assert.match(none, /Not available/);
});

test("chance row: replay says the day is part of the history", () => {
  const html = chanceRow({ chance: chance() }, { chance: { ...chanceTable, includes_replayed_day: true } });
  assert.match(html, /part of the history/);
});

test("body includes the chance row", () => {
  const html = renderFactorsBody(ok([town("A", "warning", { chance: chance() })], { chance: chanceTable }), "A");
  assert.match(html, /Past frequency/);
});

const model = { available: true, flood_cases: 109, from: "2011-01-01", includes_replayed_day: false };
const today = (extra = {}) => ({ band: "higher", rate: 0.079, range_95: [0.06, 0.1], rows: 2249, horizon_days: 3, confidence: "low",
  reasons: ["few_cases", "list_incomplete", "modeled_rain"], inputs: { rain_percentile: 99, wet_percentile: 96, ground_share: 0.3 }, ...extra });

test("chance today row: band, rate with range, inputs and low confidence", () => {
  const html = chanceTodayRow({ chance_today: today() }, { chance_model: model });
  assert.match(html, /Higher than usual/);
  assert.match(html, /8%/);
  assert.match(html, /6% to 10%/);
  assert.match(html, /within 3 days/);
  assert.match(html, /Confidence: low/);
  assert.match(html, /109 past town floods/);
  assert.match(html, /did not help/);
  assert.doesNotMatch(html, /Confidence: (high|medium)/);
});

test("chance today row: other bands, below range, missing input, model not built, replay", () => {
  assert.match(chanceTodayRow({ chance_today: today({ band: "lower" }) }, { chance_model: model }), /Lower than usual/);
  assert.match(chanceTodayRow({ chance_today: today({ band: "usual" }) }, { chance_model: model }), /About usual/);
  assert.match(chanceTodayRow({ chance_today: { band: null, reason: "below_range" } }, { chance_model: model }), /Rain is ordinary, so AGOS gives no flood chance/);
  assert.match(chanceTodayRow({ chance_today: { band: null, reason: "missing_input" } }, { chance_model: model }), /Not enough data/);
  assert.match(chanceTodayRow({ chance_today: { band: null, reason: "below_range" } }, { chance_model: model }), /does not mean flooding is impossible/);
  const off = chanceTodayRow({ chance_today: null }, { chance_model: { available: false } });
  assert.match(off, /tools\/build_chance_model\.py/);
  assert.match(chanceTodayRow({ chance_today: today() }, { chance_model: { ...model, includes_replayed_day: true } }), /part of the history/);
});

test("tide row names the day closest to the moon, not the first day of the window", () => {
  const data = { tide: { days: [
    { date: "2026-10-25", spring: true, moon: "full", days_from_moon: 1.6 },
    { date: "2026-10-26", spring: true, moon: "full", days_from_moon: 0.6 },
    { date: "2026-10-27", spring: true, moon: "full", days_from_moon: 0.4 },
  ], tested: null } };
  const html = renderFactorsBody(ok([town("A", "normal")], data), "A");
  assert.match(html, /full moon \(Oct 27\)/);
});
