import { test } from "node:test";
import assert from "node:assert/strict";
import { barChart, lineChart } from "../js/core/charts.js";

test("missing values are drawn as gaps, not zero-height data", () => {
  const svg = barChart([{ label: "1", value: 2 }, { label: "2", value: null }], { width: 300 });
  assert.match(svg, /chart-missing/);
  assert.match(svg, /no data/);
});

test("line chart breaks at missing values", () => {
  const svg = lineChart([{ label: "a", value: 1 }, { label: "b", value: null }, { label: "c", value: 2 }], { width: 300 });
  const path = svg.match(/<path d="([^"]*)" fill="none"/)[1];
  assert.equal((path.match(/M/g) || []).length, 2);
});

test("labels are escaped", () => {
  assert.doesNotMatch(barChart([{ label: "<b>", value: 1 }], { width: 300 }), /<b>/);
});
