import { test } from "node:test";
import assert from "node:assert/strict";
import { topShare, watchBadge, renderWatchTown, renderWatchList } from "../js/views/parts/watch.js";

const data = {
  today: "2026-10-25",
  backing: { warning: { caught: 64, cases: 104, share: 0.615, range: [0.52, 0.7], alerts_per_town_year: 2.7 } },
  rain_record: { consistent: false },
  towns: [
    { name: "Hermosa", level: "warning", listed_floods: 21, latest: "2026-09-07",
      peak: { start: "2026-10-24", end: "2026-10-26", mm: 180, percentile: 98.4 },
      daily: [{ date: "2026-10-23", mm: 2 }, { date: "2026-10-24", mm: 60 }, { date: "2026-10-25", mm: 90 }, { date: "2026-10-26", mm: 30 }, { date: "2026-10-27", mm: null }] },
    { name: "Limay", level: "normal", listed_floods: 0, latest: null, peak: { start: "2026-10-23", end: "2026-10-25", mm: 4, percentile: 40 }, daily: [] },
  ],
};

test("top share wording", () => {
  assert.equal(topShare(98.4), "top 1.6%");
  assert.equal(topShare(80), "ordinary");
  assert.equal(topShare(100), "above every 3-day total on record");
  assert.equal(topShare(null), "—");
});

test("badges carry tone and text", () => {
  assert.match(watchBadge("warning"), /badge-danger/);
  assert.match(watchBadge("normal"), /Normal/);
});

test("town card explains the sign with its backing, missing day shown as missing", () => {
  const html = renderWatchTown(data, "Hermosa");
  assert.match(html, /Warning sign/);
  assert.match(html, /180 mm of rain over Oct 24–26, 2026: top 1.6% for Hermosa/);
  assert.match(html, /62% of listed Bataan floods \(64 of 104\)/);
  assert.match(html, /21 times/);
  assert.match(html, /—/);
  assert.match(html, /Not an official warning/);
  assert.match(html, /mixes two models/);
});

test("normal town says floods can still happen; list counts raised towns", () => {
  assert.match(renderWatchTown(data, "Limay"), /high tide/);
  assert.match(renderWatchList(data), /1 town\(s\)/);
  assert.equal(renderWatchTown(data, "Nowhere"), "");
});

import { barScale, renderWatchDetail } from "../js/views/parts/watch.js";

test("ordinary rain is called ordinary, not 'top 50%'", () => {
  assert.equal(topShare(50), "ordinary");
  assert.equal(topShare(91), "top 9.0%");
});

test("bar scale puts the town's own marks in order and caps the fill", () => {
  const sc = barScale({ peak: { mm: 500 }, thresholds_mm: { watch: 60, warning: 80, high_warning: 100 } });
  assert.deepEqual(sc.marks.map((m) => m.at), [48, 64, 80]);
  assert.equal(sc.fill, 100);
  assert.equal(barScale({ thresholds_mm: {} }), null);
});

test("chart has a clickable row per town and the detail explains one", () => {
  const withTh = { ...data, towns: data.towns.map((x) => ({ ...x, thresholds_mm: { watch: 60, warning: 80, high_warning: 100 } })) };
  const html = renderWatchList(withTh);
  assert.equal((html.match(/data-watch-pick=/g) || []).length, 2);
  assert.match(html, /warning sign at 80 mm/);
  const detail = renderWatchDetail(withTh, "Hermosa");
  assert.match(detail, /Warning sign from 80 mm/);
  assert.match(detail, /Open Hermosa(&#39;|')s flood history/);
});
