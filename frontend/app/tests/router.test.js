import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHash, buildHash } from "../js/core/router.js";

test("empty hash goes to overview", () => {
  assert.deepEqual(parseHash(""), { view: "overview", requested: "overview", params: [], query: {} });
});

test("params and query", () => {
  const route = parseHash("#/municipality/Balanga?tab=rain");
  assert.equal(route.view, "municipality");
  assert.deepEqual(route.params, ["Balanga"]);
  assert.deepEqual(route.query, { tab: "rain" });
});

test("unknown route is notfound", () => {
  assert.equal(parseHash("#/nope").view, "notfound");
});

test("buildHash round trip with spaces", () => {
  const hash = buildHash("municipality", ["Balanga City"], { m: "x", empty: "" });
  assert.equal(hash, "#/municipality/Balanga%20City?m=x");
  assert.deepEqual(parseHash(hash).params, ["Balanga City"]);
});
