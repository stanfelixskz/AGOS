import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("../data/bataan-municipalities-psgc2023.geojson", import.meta.url), "utf8"));
const python = readFileSync(new URL("../../../backend/app/data/municipalities.py", import.meta.url), "utf8");
const towns = [...python.matchAll(/^\s{4}"([A-Za-z]+)": \{/gm)].map((m) => m[1]);

function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

test("boundary file has the 12 Bataan municipalities with PSGC codes and a source", () => {
  assert.equal(data.type, "FeatureCollection");
  assert.equal(data.features.length, 12);
  assert.match(data.metadata.source, /philippines-json-maps/);
  assert.deepEqual(data.features.map((f) => f.properties.name).sort(), [...towns].sort());
  for (const f of data.features) assert.match(String(f.properties.adm3_psgc), /^3008\d\d000$/);
});

test("every AGOS town reference point lies inside its own polygon", () => {
  for (const town of towns) {
    const block = python.slice(python.indexOf(`"${town}": {`));
    const lat = Number(block.match(/"latitude": ([\d.]+)/)[1]);
    const lon = Number(block.match(/"longitude": ([\d.]+)/)[1]);
    const feature = data.features.find((f) => f.properties.name === town);
    const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    assert.ok(polygons.some((poly) => inside([lon, lat], poly[0])), town);
  }
});
