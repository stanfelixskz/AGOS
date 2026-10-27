import test from "node:test";
import assert from "node:assert/strict";
import { setLang } from "../js/core/i18n.js";
import * as storm from "../js/views/parts/storm-risk.js";
import { todayPH, addDays, stormDay, riskTense, renderStormRiskForm, renderStormRisk } from "../js/views/parts/storm-risk.js";

setLang("en");

const town = (name, level, mm = 120, percentile = 98.5) => ({
  name,
  state: ["watch", "warning", "high_warning"].includes(level) ? "raised" : level === "no_data" ? "no_data" : "ordinary",
  rain: level === "no_data" ? { level } : { level, peak: { mm, start: "2024-07-22", end: "2024-07-24", percentile } },
});

const answer = (extra = {}) => ({
  date: "2024-07-24",
  mode: "replay",
  factors: {
    mode: "replay", date: "2024-07-24", raised: ["Hermosa"],
    towns: [town("Hermosa", "warning"), town("Mariveles", "normal", 20, 40)],
    events_near: [{ id: "e1", start: "2024-07-24", end: "2024-07-25", towns: ["Hermosa", "Orani"], sources: [{ publisher: "Inquirer", url: "https://example.org/a" }] }],
  },
  storm: { radius_km: 300, nearest: { name: "Mariveles", km: 180 }, inside_radius: ["Mariveles", "Hermosa"], towns: [] },
  comparison: { listed_flooded: ["Hermosa", "Orani"], raised: ["Hermosa"], both: ["Hermosa"], flooded_not_raised: ["Orani"], raised_not_listed: [] },
  ...extra,
});

test("todayPH uses Philippine time and addDays crosses months", () => {
  assert.equal(todayPH(new Date("2026-10-26T17:30:00Z")), "2026-10-27");
  assert.equal(addDays("2026-10-30", 2), "2026-11-01");
});

test("stormDay reads the article day and tolerates its absence", () => {
  assert.equal(stormDay({ article: { day: { date: "2022-09-25", basis: "published" } } }), "2022-09-25");
  assert.equal(stormDay({ article: { day: null } }), null);
  assert.equal(stormDay(null), null);
});

test("riskTense names the kind of rain behind the answer", () => {
  assert.equal(riskTense({ mode: "replay", date: "2024-07-24" }, "2026-10-27"), "recorded");
  assert.equal(riskTense({ mode: "forecast", date: "2026-10-20" }, "2026-10-27"), "recent");
  assert.equal(riskTense({ mode: "forecast", date: "2026-10-27" }, "2026-10-27"), "today");
  assert.equal(riskTense({ mode: "forecast", date: "2026-10-29" }, "2026-10-27"), "ahead");
});

test("the form is prefilled with the article day and capped at today + 2", () => {
  const html = renderStormRiskForm({ article: { day: { date: "2022-09-25" } } }, "2026-10-27");
  assert.match(html, /value="2022-09-25"/);
  assert.match(html, /max="2026-10-29"/);
  assert.match(html, /publish day/);
  assert.match(renderStormRiskForm({ article: {} }, "2026-10-27"), /no publish date/);
});

test("a past day shows the signs, the storm as context, and the listed floods beside them", () => {
  const html = renderStormRisk(answer(), "2026-10-27");
  assert.match(html, /actually fell/);
  assert.match(html, /Rain unusual for 1 of 2 towns: Hermosa/);
  assert.match(html, /Warning sign/);
  assert.match(html, /about 180 km from Mariveles/);
  assert.match(html, /Inside the stated wind-extent radius \(300 km\): Mariveles, Hermosa/);
  assert.match(html, /not part of the sign/);
  assert.match(html, /Floods listed around that day/);
  assert.match(html, /href="https:\/\/example.org\/a"/);
  assert.match(html, /Flooded, sign not raised<\/dt><dd>Orani/);
  assert.match(html, /Not an official warning/);
});

test("today and coming days skip the flood list; missing position and radius are said plainly", () => {
  const html = renderStormRisk(answer({ date: "2026-10-28", mode: "forecast", storm: null, comparison: null }), "2026-10-27");
  assert.match(html, /Forecast for the days around/);
  assert.doesNotMatch(html, /Floods listed around that day/);
  assert.match(html, /no storm position/);
  const noRadius = renderStormRisk(answer({ storm: { radius_km: null, nearest: { name: "Bagac", km: 90 }, inside_radius: null, towns: [] } }), "2026-10-27");
  assert.match(noRadius, /states no wind-extent radius/);
});

test("a past day with no listed flood says the list misses small floods", () => {
  const data = answer({ comparison: null });
  data.factors.events_near = [];
  assert.match(renderStormRisk(data, "2026-10-27"), /Small floods are often missing/);
});

test("the record line warns when the stored record is short", () => {
  const { recordLine } = storm;
  assert.match(recordLine({ replay: { min: "1990-01-18" } }, "2026-10-27"), /since about Jan 18, 1990\.$/);
  assert.match(recordLine({ replay: { min: "2025-01-14" } }, "2026-10-27"), /only 1\.8 years/);
  assert.match(recordLine({ replay: null }, "2026-10-27"), /No rain record/);
});

test("riskRows colors every town with a sign and leaves towns without data out", async () => {
  const { riskRows, RISK_COLORS, RISK_LEVELS } = await import("../js/map/outlook.js");
  const rows = riskRows({ towns: [town("Hermosa", "high_warning"), town("Orani", "watch"), town("Bagac", "normal"), town("Limay", "no_data")] });
  assert.deepEqual(rows.map((r) => [r.name, r.level]), [["Hermosa", "high_warning"], ["Orani", "watch"], ["Bagac", "normal"]]);
  assert.equal(rows[0].color, RISK_COLORS.high_warning);
  assert.equal(new Set(RISK_LEVELS.map((l) => RISK_COLORS[l])).size, RISK_LEVELS.length);
  assert.deepEqual(riskRows(null), []);
});

test("an empty answer and town names are escaped", () => {
  assert.match(renderStormRisk({ factors: { towns: [] } }, "2026-10-27"), /No town data/);
  const data = answer();
  data.factors.towns = [town("<b>X</b>", "normal")];
  assert.doesNotMatch(renderStormRisk(data, "2026-10-27"), /<b>X<\/b>/);
});
