import test from "node:test";
import assert from "node:assert/strict";
import { setLang } from "../js/core/i18n.js";
import { riverNames, renderFactorsBanner, renderFactorsBody } from "../js/views/parts/factors.js";
import { SOURCES } from "../js/core/sources.js";

setLang("en");

const town = (name, extra = {}) => ({
  name, state: "ordinary",
  rain: { level: "normal", peak: { mm: 40, end: "2026-10-27", percentile: 60 }, daily: [{ date: "2026-10-26", mm: 20 }] },
  wet_ground: null, susceptibility: null, floods: { listed_floods: 0, months: [], latest: null, barangays: [] },
  ...extra,
});
const ok = (towns) => ({ status: "ok", data: { mode: "forecast", date: "2026-10-26", issued_at: "2026-10-26T10:00:00+08:00", raised: [], towns, backing: {}, events_near: [] } });
const body = (rivers, lang = "en") => {
  setLang(lang);
  try {
    return renderFactorsBody(ok([town("A", { rivers })]), "A");
  } finally {
    setLang("en");
  }
};

test("riverNames shows the first few names and counts the rest", () => {
  assert.deepEqual(riverNames(["a", "b", "c"]), { shown: ["a", "b", "c"], more: 0 });
  assert.deepEqual(riverNames(["a", "b", "c", "d", "e", "f", "g", "h"]), { shown: ["a", "b", "c", "d", "e", "f"], more: 2 });
  assert.deepEqual(riverNames(["a", "b", "c"], 2), { shown: ["a", "b"], more: 1 });
  assert.deepEqual(riverNames(null), { shown: [], more: 0 });
  assert.deepEqual(riverNames(["a", "", null]), { shown: ["a"], more: 0 });
});

test("rivers row lists the named rivers, the mapped length and where it comes from", () => {
  const html = body({ names: ["Talisay River", "Tenejero Creek"], length_km: 83.54 });
  assert.match(html, /Rivers/);
  assert.match(html, /Named: Talisay River, Tenejero Creek/);
  assert.match(html, /83\.5 km of rivers, streams and canals mapped/);
  assert.match(html, /OpenStreetMap, may be incomplete\. Context only: not part of the sign\./);
});

test("more than six rivers say how many are left out", () => {
  const names = ["A1", "B2", "C3", "D4", "E5", "F6", "G7", "H8"];
  assert.match(body({ names, length_km: 90 }), /Named: A1, B2, C3, D4, E5, F6 and 2 more/);
});

test("a town with no named river still shows its mapped length", () => {
  const html = body({ names: [], length_km: 90.2 });
  assert.match(html, /No named river or creek is mapped in this town/);
  assert.match(html, /90\.2 km/);
});

test("without river data the row says so and nothing is invented", () => {
  const html = body(null);
  assert.match(html, /River map not available/);
  assert.doesNotMatch(html, /km of rivers/);
  assert.doesNotMatch(body(undefined), /km of rivers/);
});

test("river names are escaped", () => {
  const html = body({ names: ["<b>X</b>"], length_km: 1 });
  assert.doesNotMatch(html, /<b>X<\/b>/);
  assert.match(html, /&lt;b&gt;X&lt;\/b&gt;/);
});

test("rivers are a data row, dikes and drainage stay marked as not included", () => {
  for (const rivers of [{ names: ["X River"], length_km: 3 }, null]) {
    const html = body(rivers);
    assert.equal((html.match(/is-off/g) || []).length, 3); // tide, storm, dikes and drainage
    assert.match(html, /Dikes and drainage/);
    assert.match(html, /Not included: no public dataset found/);
    assert.doesNotMatch(html, /Rivers, dikes, drainage/);
  }
});

test("rivers do not change the warning sign", () => {
  setLang("en");
  const plain = renderFactorsBanner(ok([town("A")]), "A");
  const withRivers = renderFactorsBanner(ok([town("A", { rivers: { names: ["X River"], length_km: 3 } })]), "A");
  assert.equal(plain, withRivers);
});

test("Filipino rivers row", () => {
  const html = body({ names: ["Talisay River"], length_km: 12 }, "fil");
  assert.match(html, /Mga ilog/);
  assert.match(html, /May pangalan: Talisay River/);
  assert.match(html, /Konteksto lamang/);
  assert.match(html, /Dike at drainage/);
});

test("the OpenStreetMap source is listed with its licence and its limits", () => {
  const source = SOURCES.find((s) => s.id === "rivers");
  assert.ok(source);
  assert.match(source.what, /ODbL/);
  assert.match(source.limits, /Context only/);
  assert.match(source.fil.limits, /Konteksto lamang/);
});
