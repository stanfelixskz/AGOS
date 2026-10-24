// Run with:  node --test frontend/tests/
// Checks the legend registry against js/map.js so colors and layer ids
// cannot silently drift apart.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { LAYERS, GROUPS, describeStatus, readVisible } = require("../js/map-legend.js");
const mapSource = fs.readFileSync(path.join(__dirname, "../js/map.js"), "utf8");

// Names accepted by AGOSMap.setLayerVisibility(), read from map.js itself.
const aliasBlock = mapSource.slice(mapSource.indexOf("const aliases = {"));
const API_NAMES = new Set(
  [...aliasBlock.slice(0, aliasBlock.indexOf("};")).matchAll(/^\s*([a-z]+):/gm)].map((m) => m[1])
);

function fakeMap(layers) {
  return {
    getLayer: (id) => (id in layers ? { id } : undefined),
    getLayoutProperty: (id) => layers[id],
  };
}

test("ids are unique and every layer belongs to a known group", () => {
  const ids = LAYERS.map((layer) => layer.id);
  assert.equal(new Set(ids).size, ids.length);
  const groups = new Set(GROUPS.map((group) => group.id));
  LAYERS.forEach((layer) => assert.ok(groups.has(layer.group), layer.id));
});

test("every layer explains itself: shows, colors, source, updated, limits", () => {
  LAYERS.forEach((layer) => {
    for (const field of ["label", "kind", "shows", "why", "updated", "limits"]) {
      assert.ok(layer[field] && layer[field].trim(), `${layer.id}.${field}`);
    }
    assert.ok(layer.source && layer.source.name, `${layer.id}.source`);
    assert.ok(Array.isArray(layer.mapLayers) && layer.mapLayers.length, `${layer.id}.mapLayers`);
  });
});

test("swatch colors are valid hex and each swatch has a text label", () => {
  LAYERS.forEach((layer) =>
    layer.swatches.forEach((swatch) => {
      assert.match(swatch.color, /^#[0-9a-f]{6}$/i, layer.id);
      assert.ok(swatch.label.trim(), layer.id);
    })
  );
});

test("toggle names are ones AGOSMap.setLayerVisibility understands", () => {
  assert.ok(API_NAMES.size >= 8, "could not read the alias list from map.js");
  LAYERS.filter((layer) => layer.api).forEach((layer) =>
    assert.ok(API_NAMES.has(layer.api), `${layer.id} uses unknown name "${layer.api}"`)
  );
});

test("every map layer id and data key is really used in map.js", () => {
  LAYERS.forEach((layer) => {
    layer.mapLayers.forEach((id) =>
      assert.ok(mapSource.includes(`"${id}"`), `${layer.id}: layer id ${id} not found in map.js`)
    );
    if (layer.dataKey) {
      assert.ok(mapSource.includes(`layerAvailability.${layer.dataKey}`), `${layer.id}: ${layer.dataKey}`);
    }
  });
});

test("legend colors match the colors painted by map.js", () => {
  LAYERS.forEach((layer) =>
    layer.swatches.forEach((swatch) =>
      assert.ok(
        mapSource.toLowerCase().includes(swatch.color.toLowerCase()),
        `${layer.id}: ${swatch.color} is not used in map.js`
      )
    )
  );
});

test("forecast-rain bands match stormRainfallLabel in map.js", () => {
  const body = mapSource.slice(mapSource.indexOf("function stormRainfallLabel"));
  const code = body.slice(0, body.indexOf("\n  }\n"));
  assert.match(code, /mm < 1\)/);
  assert.match(code, /mm < 10\)/);
  assert.match(code, /mm < 30\)/);
  const rain = LAYERS.find((layer) => layer.id === "forecast-rain");
  assert.deepEqual(
    rain.swatches.map((swatch) => swatch.color),
    ["#93c5fd", "#38bdf8", "#fbbf24", "#fb7185"]
  );
});

test("forecast rain is always on and says it is not a PAGASA level", () => {
  const rain = LAYERS.find((layer) => layer.id === "forecast-rain");
  assert.equal(rain.alwaysOn, true);
  assert.equal(rain.api, null);
  assert.match(rain.why, /not PAGASA/i);
});

test("status: map not ready -> loading; missing layer -> not loaded", () => {
  const layer = LAYERS.find((item) => item.id === "evacuation");
  assert.equal(describeStatus(layer, null, null).state, "loading");
  assert.equal(describeStatus(layer, fakeMap({}), null).text, "Not loaded yet…");
});

test("status: missing data file is reported as unavailable, never hidden", () => {
  const layer = LAYERS.find((item) => item.id === "municipalities");
  const map = fakeMap({ "agos-municipality-fill": "visible" });
  const status = describeStatus(layer, map, { municipalities: false });
  assert.equal(status.state, "unavailable");
  assert.match(status.text, /not available/i);
});

test("status: terrain rows always carry the missing-tiles note", () => {
  ["elevation", "slope", "flow"].forEach((id) => {
    const layer = LAYERS.find((item) => item.id === id);
    const status = describeStatus(layer, fakeMap({ [layer.mapLayers[0]]: "none" }), null);
    assert.equal(status.state, "info");
    assert.match(status.text, /not included in the repository/);
  });
});

test("status: reads real visibility from the map", () => {
  const layer = LAYERS.find((item) => item.id === "susceptibility");
  const id = layer.mapLayers[0];
  assert.equal(describeStatus(layer, fakeMap({ [id]: "visible" }), {}).text, "Shown on map.");
  assert.equal(describeStatus(layer, fakeMap({ [id]: "none" }), {}).text, "Hidden.");
  assert.equal(readVisible(fakeMap({ [id]: undefined }), layer), true);
});
