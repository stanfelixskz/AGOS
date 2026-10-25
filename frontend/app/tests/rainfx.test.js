import { test } from "node:test";
import assert from "node:assert/strict";
import { intensity, normName } from "../js/map/rainfx.js";

test("no streaks without data or below 0.1 mm/h", () => {
  for (const value of [null, undefined, "3", NaN, Infinity, 0, 0.09]) assert.equal(intensity(value), null, String(value));
});

test("heavier rain means more, faster and longer streaks", () => {
  const steps = [0.5, 3, 10, 20, 45].map((mm) => intensity(mm));
  for (let i = 1; i < steps.length; i += 1) {
    assert.ok(steps[i].density > steps[i - 1].density);
    assert.ok(steps[i].speed > steps[i - 1].speed);
    assert.ok(steps[i].length > steps[i - 1].length);
  }
});

test("steps match the level thresholds (1, 7.5, 15, over 30 mm/h)", () => {
  assert.equal(intensity(0.99).density, intensity(0.1).density);
  assert.ok(intensity(1).density > intensity(0.99).density);
  assert.ok(intensity(7.5).density > intensity(7.49).density);
  assert.ok(intensity(15).density > intensity(14.9).density);
  assert.equal(intensity(30).density, intensity(15).density);
  assert.ok(intensity(30.01).density > intensity(30).density);
});

test("town names match across sources", () => {
  assert.equal(normName("City of Balanga"), normName("Balanga"));
});
