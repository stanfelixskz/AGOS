import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setLang } from "../js/core/i18n.js";
import { factorsTown, topMonths, wetWords, renderFactorsBanner, renderFactorsBody } from "../js/views/parts/factors.js";
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
  days: [{ date: "2026-10-25", spring: false, moon: "new" }, { date: "2026-10-26", spring, moon: "full" }],
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
