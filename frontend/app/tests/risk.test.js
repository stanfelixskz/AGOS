import { test } from "node:test";
import assert from "node:assert/strict";
import { riskRows, riskQuery, factorText, riskColor, RISK_IDS } from "../js/core/risk.js";
import { STRINGS } from "../js/core/i18n.js";

const factor = (id, value, points, extra = {}) => ({ id, value, points, ...extra });

const town = (overrides = {}) => ({
  municipality: "Balanga",
  level: "moderate",
  score: 2,
  factors: [
    factor("peak_24h", 8, 2, { level: "yellow" }),
    factor("total_24h", 20, 0),
    factor("total_72h", 30, 0),
    factor("past_72h", 12, 0),
    factor("soil", 0.31, 0),
    factor("discharge", null, 0),
  ],
  storm: null,
  ...overrides,
});

test("every risk level has a color and English + Filipino names", () => {
  for (const id of [...RISK_IDS, "nodata"]) {
    assert.match(riskColor(id), /^#[0-9a-f]{6}$/);
    assert.ok(STRINGS.en[`risk.level.${id}`] && STRINGS.fil[`risk.level.${id}`], id);
  }
});

test("hover reasons list the inputs that scored, highest first", () => {
  const [row] = riskRows({ municipalities: [town()] });
  assert.equal(row.name, "Balanga");
  assert.equal(row.lines.length, 1);
  assert.match(row.lines[0], /^Heaviest hour, next 24 h: 8\.0 mm\/h \(yellow\) \(\+2\)$/);
  assert.match(row.title, /Moderate · 2 pts/);
});

test("when nothing scored, the card still explains with the main rain values", () => {
  const dry = town({ level: "low", score: 0, factors: town().factors.map((f) => ({ ...f, points: 0 })) });
  const [row] = riskRows({ municipalities: [dry] });
  assert.equal(row.lines.length, 2);
  assert.match(row.lines.join(" | "), /Forecast rain, next 24 h: 20\.0 mm \| Rain in the past 72 h: 12\.0 mm/);
});

test("missing values say no data, never zero", () => {
  assert.equal(factorText(factor("discharge", null, 0)), "River flow (GloFAS): no data");
});

test("storm line explains inside, outside and no stated radius", () => {
  const inside = riskRows({ municipalities: [town({ storm: { name: "Testa", distance_km: 120, radius_km: 290, inside_radius: true } })] })[0];
  assert.match(inside.lines.at(-1), /Inside Testa's stated 290 km wind radius \(120 km away\)/);
  const none = riskRows({ municipalities: [town({ storm: { name: "Testa", distance_km: 400, radius_km: null, inside_radius: false } })] })[0];
  assert.match(none.lines.at(-1), /gives no wind radius: no change/);
});

test("riskQuery sends the storm only when it has a position", () => {
  assert.equal(riskQuery(null), "/api/flood-risk");
  assert.equal(riskQuery({ storm: { name: "Testa" } }), "/api/flood-risk");
  const q = riskQuery({ position: { latitude: 14.7, longitude: 123.3 }, radius_km: { value: 290 }, strength: 4, storm: { name: "Testa" } });
  const params = new URL(q, "http://x").searchParams;
  assert.equal(params.get("storm_lat"), "14.7");
  assert.equal(params.get("storm_radius_km"), "290");
  assert.equal(params.get("storm_strength"), "4");
  assert.equal(params.get("storm_name"), "Testa");
});
