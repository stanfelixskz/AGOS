import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHTML, num, withUnit, parseTime, relativeTime, distanceKm, slug, formatHour } from "../js/core/format.js";

test("escapeHTML escapes markup", () => {
  assert.equal(escapeHTML(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(escapeHTML(null), "");
});

test("missing numbers are never shown as 0", () => {
  assert.equal(num(null), "—");
  assert.equal(num(NaN), "—");
  assert.equal(num("3"), "—");
  assert.equal(withUnit(undefined, "mm"), "Not available");
  assert.equal(withUnit(0, "mm"), "0.0 mm");
});

test("Open-Meteo local times are Philippine time", () => {
  const date = parseTime("2026-09-07T10:00");
  assert.equal(date.toISOString(), "2026-09-07T02:00:00.000Z");
  assert.equal(parseTime("2026-09-07T10:00:00+08:00").toISOString(), "2026-09-07T02:00:00.000Z");
  assert.equal(parseTime("2026-09-07").toISOString(), "2026-09-06T16:00:00.000Z");
  assert.equal(parseTime("not a date"), null);
  assert.match(formatHour("2026-09-07T14:00"), /2/);
});

test("relative time", () => {
  const now = new Date("2026-09-07T02:00:00Z");
  assert.equal(relativeTime("2026-09-07T01:55:00Z", now), "5 min ago");
  assert.equal(relativeTime("2026-09-07T05:00:00Z", now), "in 3 h");
  assert.equal(relativeTime(null, now), "unknown time");
});

test("distance between Balanga and Mariveles is about 27 km", () => {
  const km = distanceKm([120.5363, 14.676], [120.4858, 14.4338]);
  assert.ok(km > 26 && km < 29, String(km));
});

test("slug", () => {
  assert.equal(slug("Balanga City"), "balanga-city");
  assert.equal(slug("Sto. Niño"), "sto-nino");
});
