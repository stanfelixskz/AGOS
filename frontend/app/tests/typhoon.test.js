import { test } from "node:test";
import assert from "node:assert/strict";
import { destination, circlePolygon, kmToPixels, typhoonSVG, intensityLevel, unscaledSize } from "../js/map/typhoon.js";

test("destination: 111.195 km due east at the equator is about 1 degree", () => {
  const [lon, lat] = destination([120, 0], 90, 111.195);
  assert.ok(Math.abs(lon - 121) < 0.01, `lon ${lon}`);
  assert.ok(Math.abs(lat) < 0.01, `lat ${lat}`);
});

test("circlePolygon is a closed ring at the given radius", () => {
  const feature = circlePolygon([125, 14], 300, 36);
  const ring = feature.geometry.coordinates[0];
  assert.equal(ring.length, 37);
  assert.deepEqual(ring[0], ring[36]);
  const [, northLat] = ring[0];
  assert.ok(Math.abs(northLat - (14 + 300 / 111.195)) < 0.02, `north edge ${northLat}`);
});

test("kmToPixels doubles with each zoom level", () => {
  const a = kmToPixels(100, 14, 6);
  const b = kmToPixels(100, 14, 7);
  assert.ok(Math.abs(b / a - 2) < 1e-9);
  assert.ok(a > 0);
});

test("intensityLevel follows the PAGASA scale, winds first, then category", () => {
  const level = (kmh) => intensityLevel({ max_wind_kmh: { value: kmh } });
  assert.deepEqual([61, 62, 88, 89, 117, 118, 184, 185].map(level), [0, 1, 1, 2, 2, 3, 3, 4]);
  assert.equal(intensityLevel({ storm: { category: "Super Typhoon" } }), 4);
  assert.equal(intensityLevel({ storm: { category: "Severe Tropical Storm" } }), 2);
  assert.equal(intensityLevel({ storm: { category: "Tropical cyclone (Filipino: Bagyong)" } }), null);
  assert.equal(intensityLevel({ max_wind_kmh: { value: 195 }, storm: { category: "Tropical Storm" } }), 4);
});

test("stronger storms get a bigger unscaled symbol", () => {
  const sizes = [0, 1, 2, 3, 4].map(unscaledSize);
  assert.deepEqual([...sizes].sort((a, b) => a - b), sizes);
  assert.equal(unscaledSize(null), unscaledSize(2));
});

test("typhoonSVG: colder layers and an eye only for strong storms", () => {
  const layers = (svg) => (svg.match(/<g fill="#/g) || []).length;
  assert.equal(layers(typhoonSVG(0)), 4);
  assert.equal(layers(typhoonSVG(4)), 7);
  assert.doesNotMatch(typhoonSVG(1), /#ff2200/);
  assert.match(typhoonSVG(4), /#ff2200/);
  assert.doesNotMatch(typhoonSVG(2), /fill="#2b2f36"/);
  assert.match(typhoonSVG(3), /fill="#2b2f36"/);
  assert.match(typhoonSVG(3), /viewBox="-100 -100 200 200"/);
});
