import { test } from "node:test";
import assert from "node:assert/strict";
import { pct, highShare, stackedBar, renderSusceptibility, renderSuscDetail } from "../js/views/parts/susceptibility.js";

const data = {
  available: true, step_m: 200, built_at: "2026-10-26T01:50:00+00:00", classes_present: ["high", "moderate", "low"],
  check: { spearman_high_share_vs_listed_floods: 0.71, towns: 12 },
  towns: [
    { name: "Hermosa", shares: { very_high: 0, high: 0.184, moderate: 0.035, low: 0.019, not_rated: 0.762 }, listed_floods: 21,
      barangays_unsampled: ["Tiny"], top_barangays: [{ name: "Almacen", shares: { very_high: 0, high: 1, moderate: 0, low: 0, not_rated: 0 } }] },
    { name: "Bagac", shares: { very_high: 0, high: 0.061, moderate: 0.013, low: 0.029, not_rated: 0.898 }, listed_floods: 3, barangays_unsampled: [], top_barangays: [] },
  ],
};

test("percent and high share", () => {
  assert.equal(pct(0.184), "18%");
  assert.equal(pct(0.004), "<1%");
  assert.equal(pct(null), "—");
  assert.ok(Math.abs(highShare({ high: 0.2, very_high: 0.05 }) - 0.25) < 1e-9);
});

test("stacked bar only draws classes that exist and is labelled", () => {
  const html = stackedBar({ very_high: 0, high: 0.5, moderate: 0, low: 0.25, not_rated: 0.25 }, { label: "X" });
  assert.equal((html.match(/<span style=/g) || []).length, 3);
  assert.match(html, /aria-label="X"/);
});

test("card: one row per town, check line, source and date; very high not in legend", () => {
  const html = renderSusceptibility(data);
  assert.equal((html.match(/data-susc-pick=/g) || []).length, 2);
  assert.match(html, /rank correlation 0.71 over 12 towns/);
  assert.match(html, /DENR Mines and Geosciences Bureau/);
  assert.doesNotMatch(html, /Very high/);
  assert.match(renderSusceptibility({ available: false }), /not built yet/);
});

test("detail: barangays, unsampled named, today's sign joins in", () => {
  const watch = { towns: [{ name: "Hermosa", level: "warning" }] };
  const html = renderSuscDetail(data, "Hermosa", watch);
  assert.match(html, /Almacen/);
  assert.match(html, /100% High/);
  assert.match(html, /Too small to measure at this spacing: Tiny/);
  assert.match(html, /watch first/);
  assert.doesNotMatch(renderSuscDetail(data, "Hermosa", null), /watch first/);
});
