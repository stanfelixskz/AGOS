import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict, rankLabel, renderEvidence, dateRange } from "../js/views/parts/evidence.js";

test("verdict needs enough floods and a margin over chance", () => {
  assert.equal(verdict({ events_with_rain_data: 5, share_top5: 0.9, chance_top5: 0.1 }).key, "evidence.verdictFew");
  assert.equal(verdict({ events_with_rain_data: 20, share_top5: 0.6, chance_top5: 0.25 }).key, "evidence.verdictWetter");
  // 0.32 vs 0.25 with 20 floods is within 2 standard errors (about 0.19)
  assert.equal(verdict({ events_with_rain_data: 20, share_top5: 0.32, chance_top5: 0.25 }).key, "evidence.verdictUnclear");
});

test("rank labels", () => {
  assert.equal(rankLabel(99.7), "top 1%");
  assert.equal(rankLabel(95.4), "95th");
  assert.equal(rankLabel(null), "—");
});

test("untestable events say why instead of showing zero", () => {
  const html = renderEvidence({
    summary: { events: 2, events_dated: 2, events_with_rain_data: 1, cases: 1, cases_top5: 1, share_top5: 1, chance_top5: 0.2, median_3day_percentile: 99.8, cases_with_flow: 0, median_flow_percentile: null, cases_outside_record: 1 },
    record: { first: "2015-01-01" },
    events: [
      { id: "a", start_date: "2020-08-01", end_date: "2020-08-01", confidence: "high", sources: [{ publisher: "GMA News", url: "https://example.org" }], towns: [{ municipality: "Hermosa", status: "ok", max_3day_mm: 210, max_3day_percentile: 99.8 }], median_3day_percentile: 99.8, max_3day_mm: 210, any_top5: true },
      { id: "b", start_date: "2012-08-07", end_date: "2012-08-07", confidence: "high", sources: [], towns: [{ municipality: "Hermosa", status: "outside_record" }], median_3day_percentile: null, max_3day_mm: null, any_top5: null },
    ],
  });
  assert.match(html, /before the rain record/);
  assert.match(html, /not testable yet/);
  assert.match(html, /210 mm/);
  assert.match(html, /Too few floods/);
  assert.match(html, /not a forecast/);
});

test("compact date ranges", () => {
  assert.equal(dateRange("2026-09-07", "2026-09-08"), "Sep 7–8, 2026");
  assert.equal(dateRange("2021-07-30", "2021-08-02"), "Jul 30 – Aug 2, 2021");
  assert.ok(dateRange("2020-01-01", "2020-01-01").includes("2020"));
});
