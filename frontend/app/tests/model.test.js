import { test } from "node:test";
import assert from "node:assert/strict";
import { pctRange, unlistedShare, renderModel } from "../js/views/parts/model.js";

test("pctRange and unlistedShare", () => {
  assert.equal(pctRange(0.62, [0.45, 0.78]), "62% (45–78%)");
  assert.equal(pctRange(null, null), "—");
  assert.equal(unlistedShare({ episodes: 10, hit_episodes: 4 }), 0.6);
  assert.equal(unlistedShare({ episodes: 0, hit_episodes: 0 }), null);
});

test("too few cases shows a notice, no numbers", () => {
  const html = renderModel({ summary: { cases: 3, towns: 12, years: 11, enough_cases: false, min_cases: 8 } });
  assert.match(html, /notice-info/);
  assert.doesNotMatch(html, /<table/);
});

test("renders table and caution when enough cases", () => {
  const row = (t) => ({ threshold: t, cases: 20, caught: 14, episodes: 50, hit_episodes: 12, recall: 0.7, recall_range: [0.48, 0.86], precision_lower_bound: 0.24 });
  const html = renderModel({
    summary: { cases: 20, towns: 12, years: 11, enough_cases: true, min_cases: 8 },
    rain: { table: [row(95), row(99)], leave_one_year_out: { result: row(95) } },
    flow_towns: null,
  });
  assert.match(html, /<table/);
  assert.match(html, /notice-warning/);
  assert.match(html, /70% \(48–86%\)/);
});
