import { test } from "node:test";
import assert from "node:assert/strict";
import { destination, circlePolygon, kmToPixels, typhoonSVG } from "../js/map/typhoon.js";

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

test("typhoonSVG has four spiral arms and an eye", () => {
  const svg = typhoonSVG();
  assert.equal((svg.match(/fill="url\(#ty-band\)"/g) || []).length, 4);
  assert.match(svg, /viewBox="-100 -100 200 200"/);
});
