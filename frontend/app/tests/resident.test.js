import { test } from "node:test";
import assert from "node:assert/strict";
import { rainWords, townFloods, floodMonths, renderTownFloods, renderRareRain, renderSeason, fold } from "../js/views/parts/resident.js";

const events = { events: [
  { id: "a", start_date: "2018-07-17", end_date: "2018-07-17", storm: "Henry", period: "2018-07", towns: [{ municipality: "Hermosa", evidence: "flooded", note: "12 villages" }], sources: [{ publisher: "PNA", url: "https://example.org/a" }] },
  { id: "b", start_date: "2021-07-29", end_date: "2021-07-30", period: "2021-07", towns: [{ municipality: "Hermosa", evidence: "road" }, { municipality: "Balanga", evidence: "flooded" }], sources: [] },
  { id: "c", start_date: null, end_date: null, period: "2013-08", towns: [{ municipality: "Hermosa", evidence: "evacuation" }], sources: [] },
] };
const evidence = {
  summary: { share_top5: 0.78, chance_top5: 0.26 },
  events: [{ id: "a", towns: [{ municipality: "Hermosa", status: "ok", max_3day_mm: 297, max_3day_percentile: 99.8 }] }],
};

test("rain words follow the tested alert levels", () => {
  assert.equal(rainWords(99.6).key, "resident.rank.extreme");
  assert.equal(rainWords(98.2).key, "resident.rank.veryUnusual");
  assert.equal(rainWords(96).key, "resident.rank.unusual");
  assert.equal(rainWords(91).key, "resident.rank.heavier");
  assert.equal(rainWords(50).key, "resident.rank.normal");
  assert.equal(rainWords(null), null);
});

test("town floods include every kind of mention, newest first, rain only where tested", () => {
  const list = townFloods(events, evidence, "Hermosa");
  assert.deepEqual(list.map((x) => x.event.id), ["b", "a", "c"]);
  assert.equal(list[1].rain.max_3day_mm, 297);
  assert.equal(list[0].rain, null);
  assert.equal(townFloods(events, evidence, "Limay").length, 0);
});

test("flood months count dated events only", () => {
  assert.deepEqual(floodMonths(events), [{ month: 7, count: 2 }]);
});

test("town flood card: rank wording, source link, honest empty state", () => {
  const html = renderTownFloods(events, evidence, "Hermosa");
  assert.match(html, /297 mm/);
  assert.match(html, /top 1%/);
  assert.match(html, /href="https:\/\/example.org\/a"/);
  assert.match(html, /78%/);
  assert.match(html, /not checked/);
  assert.match(renderTownFloods(events, evidence, "Limay"), /does not mean it never floods/);
});

test("rare-rain card shows ranges and says when data is short", () => {
  const climate = { towns: [{ name: "Balanga", full_years: 36, monthly: [], return_levels: { status: "ok", n_years: 36, observed_max_mm: 296, levels: [{ years: 10, mm: 240, low: 210, high: 270 }], exceedance: [{ mm: 100, probability: 0.78 }] } }] };
  const html = renderRareRain(climate, "Balanga");
  assert.match(html, /once every 10 years: a day with 240 mm/);
  assert.match(html, /between 210 and 270 mm/);
  assert.match(html, /78% chance/);
  assert.match(renderRareRain({ towns: [{ name: "Balanga", full_years: 3, return_levels: { status: "insufficient_data" } }] }, "Balanga"), /Not enough years/);
});

test("season card names the wet months and has the chart slot", () => {
  const climate = { towns: [{ name: "Balanga", monthly: [{ month: 7, above_average: true, mean_total_mm: 400 }, { month: 1, above_average: false, mean_total_mm: 5 }] }] };
  const html = renderSeason(climate, events, "Balanga");
  assert.match(html, /Wettest months in Balanga: Jul/);
  assert.match(html, /data-climate-month="Balanga"/);
});

test("fold is closed unless asked", () => {
  assert.doesNotMatch(fold("x", "T", "S", "<p>i</p>"), / open>/);
  assert.match(fold("x", "T", "S", "<p>i</p>", true), / open>/);
});

test("long flood lists show the newest 5 and fold the rest", () => {
  const many = { events: Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, start_date: `201${i}-08-01`, end_date: `201${i}-08-01`, towns: [{ municipality: "Hermosa", evidence: "flooded" }], sources: [] })) };
  const html = renderTownFloods(many, { events: [] }, "Hermosa");
  assert.match(html, /Show all 8 events/);
  const firstList = html.split("town-floods-more")[0];
  assert.equal((firstList.match(/class="town-flood"/g) || []).length, 5);
  assert.match(firstList, /Aug 1, 2017/);
});
