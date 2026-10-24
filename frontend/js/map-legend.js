/*
 * AGOS — Map layers and legend panel
 *
 * One place that lists every map layer with:
 *   - a checkbox to show or hide it
 *   - its color key (what each color means)
 *   - "Why these colors?": what the layer shows, its source, how fresh it
 *     is, and what it must NOT be used for
 *
 * Rules (see CLAUDE.md): no invented data, every color explained with its
 * source, and unavailable data is reported as unavailable.
 *
 * The panel talks to the map only through the public window.AGOSMap API
 * (getMap, setLayerVisibility, getDataStatus), so js/map.js is unchanged.
 */
(function () {
  "use strict";

  const MGB_URL =
    "https://controlmap.mgb.gov.ph/arcgis/rest/services/" +
    "GeospatialDataInventory_Public/GDI_Detailed_Flood_Susceptibility_Public/MapServer";

  const TERRAIN_NOTE =
    "Needs terrain tile data (frontend/data/tiles), which is not included in the repository.";

  const TERRAIN_COLOR_NOTE =
    "The color scale is built into the tile images when they are processed. " +
    "A numeric legend will be added when the tile data is available.";

  // groups are rendered in this order
  const GROUPS = [
    { id: "hazard", title: "Hazard and forecast" },
    { id: "reference", title: "Reference" },
    { id: "terrain", title: "Terrain (needs data files)" },
  ];

  /*
   * Registry. Keep `api`, `mapLayers`, `dataKey` and the swatch colors in
   * step with js/map.js (tests/map-legend.test.js checks this).
   *   api        name accepted by AGOSMap.setLayerVisibility(); null = not toggleable
   *   mapLayers  MapLibre layer ids, used to read the real on/off state
   *   dataKey    key in AGOSMap.getDataStatus(), when the map reports one
   */
  const LAYERS = [
    {
      id: "susceptibility",
      group: "hazard",
      label: "Flood susceptibility (MGB)",
      kind: "Long-term hazard map",
      api: "baselinesusceptibility",
      mapLayers: ["agos-mgb-baseline-flood-susceptibility-layer"],
      dataKey: "baselineFloodSusceptibility",
      swatches: [
        { color: "#002673", label: "Very high" },
        { color: "#5900ff", label: "High" },
        { color: "#b045ff", label: "Moderate" },
        { color: "#e3d1ff", label: "Low" },
      ],
      shows:
        "How susceptible each area is to flooding, as mapped by the DENR–Mines and Geosciences Bureau (MGB).",
      why:
        "The colors are MGB's four susceptibility classes. Darker blue/purple means more susceptible; pale lilac means less.",
      source: { name: "DENR–MGB Geospatial Data Inventory (live map service)", url: MGB_URL },
      updated: "Fixed hazard map. It does not change with the weather.",
      limits:
        "Baseline susceptibility only. It is not a live forecast and does not mean flooding will happen.",
    },
    {
      id: "precipitation",
      group: "hazard",
      label: "Precipitation (WeatherAPI)",
      kind: "Weather tiles",
      api: "precipitation",
      mapLayers: ["agos-weather-precipitation-layer"],
      dataKey: "precipitation",
      freshnessElementId: "agos-precipitation-timestamp",
      swatches: [],
      shows: "Where the weather provider shows rain right now.",
      why:
        "The colors are the weather provider's own rain-intensity scale. AGOS does not recolor the tiles, so a numeric key is not available here.",
      source: { name: "WeatherAPI.com precipitation map tiles", url: "https://www.weatherapi.com/" },
      updated: "Hourly tiles. The tile time is shown below when the layer is on.",
      limits:
        "Rain shown is not a flood observation, flood depth or an official warning.",
    },
    {
      id: "forecast-rain",
      group: "hazard",
      label: "Forecast rain by municipality",
      kind: "Forecast model",
      api: null,
      alwaysOn: true,
      mapLayers: ["agos-storm-rainfall-warning-circles"],
      swatches: [
        { color: "#93c5fd", label: "Peak under 1 mm/h · little forecast rain" },
        { color: "#38bdf8", label: "Peak 1 to under 7.5 mm/h · rain forecast, below PAGASA yellow" },
        { color: "#facc15", label: "Peak 7.5 to under 15 mm/h · yellow level intensity" },
        { color: "#fb923c", label: "Peak 15 to 30 mm/h · orange level intensity" },
        { color: "#ef4444", label: "Peak over 30 mm/h · red level intensity" },
      ],
      shows:
        "Forecast rain for the next 6 hours at one reference point per municipality. The circle color is the heaviest forecast hour; the label shows the 6-hour total.",
      why:
        "Yellow, orange and red use PAGASA's Heavy Rainfall Warning intensity criteria (7.5, 15 and 30 mm per hour, as published by PAGASA and reported by news explainers; AGOS has not confirmed the numbers on a PAGASA page). AGOS applies them to the Open-Meteo forecast peak hour, so this is a PAGASA-equivalent forecast level, not an official PAGASA warning. The two blue bands are AGOS display bands, not PAGASA.",
      source: { name: "Open-Meteo forecast, through the AGOS API (/weather/rainfall-outlook)", url: "https://open-meteo.com/en/docs" },
      updated: "Refreshed about every 10 minutes while the map is open.",
      limits:
        "Model forecast at a reference point, not a rain-gauge reading, flood depth or an official warning. Always shown on the map.",
    },
    {
      id: "municipalities",
      group: "reference",
      label: "Municipal boundaries",
      kind: "Reference",
      api: "municipalities",
      mapLayers: ["agos-municipality-fill"],
      dataKey: "municipalities",
      swatches: [{ color: "#4d9cb3", label: "Municipality area (reference only)" }],
      shows: "The 12 municipalities of Bataan.",
      why:
        "The light-blue fill only separates municipalities. It does not mean water or flooding.",
      source: { name: "AGOS boundary file (data/bataan-municipalities.geojson)", url: null },
      updated: "Static file.",
      limits: "Not an official survey boundary.",
    },
    {
      id: "evacuation",
      group: "reference",
      label: "Evacuation centers",
      kind: "Reference",
      api: "evacuation",
      mapLayers: ["agos-evacuation-centers"],
      dataKey: "evacuationCenters",
      swatches: [{ color: "#21845c", label: "Evacuation center location" }],
      shows: "Locations of listed evacuation centers.",
      why:
        "Green only marks a location. It does not mean the center is open, has space, or is safe.",
      source: { name: "AGOS evacuation file (data/evacuation-centers.json), from public map listings", url: null },
      updated: "Static file.",
      limits: "Capacity and operating status are unverified.",
    },
    {
      id: "basemap",
      group: "reference",
      label: "Topographic basemap",
      kind: "Background map",
      api: "terrain",
      mapLayers: ["agos-topographic-basemap-layer"],
      swatches: [],
      shows: "Background map with terrain shading and roads.",
      why: "Standard map styling. It carries no flood meaning.",
      source: { name: "OpenTopoMap, data © OpenStreetMap contributors", url: "https://opentopomap.org/" },
      updated: "Provider tiles.",
      limits: "Background only.",
    },
    {
      id: "elevation",
      group: "terrain",
      label: "Elevation",
      kind: "Terrain",
      api: "elevation",
      mapLayers: ["agos-elevation-layer"],
      statusNote: TERRAIN_NOTE,
      swatches: [],
      shows: "Ground height.",
      why: TERRAIN_COLOR_NOTE,
      source: { name: "AGOS terrain processing (source elevation model not recorded in the repository)", url: null },
      updated: "Static tiles.",
      limits: "Screening view of terrain only. Not a flood extent.",
    },
    {
      id: "slope",
      group: "terrain",
      label: "Slope",
      kind: "Terrain",
      api: "slope",
      mapLayers: ["agos-slope-layer"],
      statusNote: TERRAIN_NOTE,
      swatches: [],
      shows: "How steep the ground is.",
      why: TERRAIN_COLOR_NOTE,
      source: { name: "AGOS terrain processing (source elevation model not recorded in the repository)", url: null },
      updated: "Static tiles.",
      limits: "Screening view of terrain only. Not a flood extent.",
    },
    {
      id: "flow",
      group: "terrain",
      label: "Flow accumulation",
      kind: "Terrain",
      api: "flow",
      mapLayers: ["agos-flow-layer"],
      statusNote: TERRAIN_NOTE,
      swatches: [],
      shows: "Where water tends to collect and flow over the terrain.",
      why: TERRAIN_COLOR_NOTE,
      source: { name: "AGOS terrain processing (source elevation model not recorded in the repository)", url: null },
      updated: "Static tiles.",
      limits: "Screening view of terrain only. Not a flood extent.",
    },
  ];

  // ---------------------------------------------------------------
  // Pure helpers (no DOM, unit-tested)
  // ---------------------------------------------------------------

  function layersInGroup(groupId) {
    return LAYERS.filter((layer) => layer.group === groupId);
  }

  // true when at least one of the entry's map layers is currently shown
  function readVisible(map, layer) {
    return layer.mapLayers.some(
      (id) => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none"
    );
  }

  function layerExists(map, layer) {
    return layer.mapLayers.some((id) => map.getLayer(id));
  }

  /*
   * Status text for a row.
   * Returns { state, text } where state is one of
   * loading | ready | unavailable | info
   */
  function describeStatus(layer, map, dataStatus) {
    if (!map) return { state: "loading", text: "Map is loading…" };
    if (layer.statusNote) return { state: "info", text: layer.statusNote };
    if (layer.dataKey && dataStatus && dataStatus[layer.dataKey] === false) {
      return { state: "unavailable", text: "Data not available in this deployment." };
    }
    if (!layerExists(map, layer)) return { state: "loading", text: "Not loaded yet…" };
    return { state: "ready", text: readVisible(map, layer) ? "Shown on map." : "Hidden." };
  }

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function detailLine(label, value, url) {
    const row = el("p", "legend-detail");
    row.appendChild(el("strong", null, label + " "));
    if (url) {
      const link = el("a", null, value);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      row.appendChild(link);
    } else {
      row.appendChild(document.createTextNode(value));
    }
    return row;
  }

  function buildRow(layer) {
    const row = el("div", "legend-row");
    row.dataset.layer = layer.id;

    const head = el("label", "legend-head");
    const box = el("input");
    box.type = "checkbox";
    box.id = "legend-toggle-" + layer.id;
    box.disabled = true;
    if (layer.alwaysOn) {
      box.checked = true;
      box.setAttribute("aria-label", layer.label + " (always shown)");
    }
    head.appendChild(box);
    head.appendChild(el("span", "legend-name", layer.label));
    head.appendChild(el("span", "legend-kind", layer.kind));
    row.appendChild(head);

    if (layer.swatches.length) {
      const keys = el("ul", "legend-keys");
      layer.swatches.forEach((swatch) => {
        const item = el("li");
        const chip = el("span", "legend-chip");
        chip.style.background = swatch.color;
        chip.setAttribute("aria-hidden", "true");
        item.appendChild(chip);
        item.appendChild(document.createTextNode(swatch.label));
        keys.appendChild(item);
      });
      row.appendChild(keys);
    }

    row.appendChild(el("p", "legend-status", ""));

    const more = el("details", "legend-why");
    more.appendChild(el("summary", null, "Why these colors?"));
    more.appendChild(detailLine("Shows:", layer.shows));
    more.appendChild(detailLine("Colors:", layer.why));
    more.appendChild(detailLine("Source:", layer.source.name, layer.source.url));
    const updated = detailLine("Updated:", layer.updated);
    updated.classList.add("legend-updated");
    more.appendChild(updated);
    more.appendChild(detailLine("Do not use for:", layer.limits));
    row.appendChild(more);

    return row;
  }

  function render(container) {
    container.textContent = "";
    container.appendChild(el("h3", "legend-title", "Layers and legend"));
    container.appendChild(
      el(
        "p",
        "legend-intro",
        "Tick a layer to show it. Open “Why these colors?” to see what a color means, where it comes from and its limits."
      )
    );

    GROUPS.forEach((group) => {
      const layers = layersInGroup(group.id);
      if (!layers.length) return;
      const section = el("section", "legend-group");
      section.appendChild(el("h4", null, group.title));
      layers.forEach((layer) => section.appendChild(buildRow(layer)));
      container.appendChild(section);
    });

    container.appendChild(
      el(
        "p",
        "legend-foot",
        "Weather values are model output, not gauge readings. Nothing on this map is an official warning. Use PAGASA and your local DRRMO for official information."
      )
    );
  }

  function freshnessText(layer) {
    if (!layer.freshnessElementId) return null;
    const source = document.getElementById(layer.freshnessElementId);
    const text = source ? source.textContent.replace(/\s+/g, " ").trim() : "";
    if (!text || /waiting/i.test(text)) return null;
    return text;
  }

  function sync(container) {
    const api = typeof window !== "undefined" ? window.AGOSMap : null;
    const map = api && typeof api.getMap === "function" ? api.getMap() : null;
    const dataStatus = api && typeof api.getDataStatus === "function" ? api.getDataStatus() : null;
    const ready = Boolean(map && map.getStyle && map.isStyleLoaded());

    LAYERS.forEach((layer) => {
      const row = container.querySelector('[data-layer="' + layer.id + '"]');
      if (!row) return;
      const box = row.querySelector("input");
      const status = row.querySelector(".legend-status");

      const info = describeStatus(layer, ready ? map : null, dataStatus);
      status.textContent = layer.alwaysOn ? "Always shown on the map." : info.text;
      status.dataset.state = info.state;

      if (!layer.alwaysOn) {
        const usable = ready && layer.api && layerExists(map, layer) && info.state !== "unavailable";
        // terrain rows can be toggled once their layer exists, even though
        // their tiles may be missing; the status note already says so.
        box.disabled = !usable;
        if (ready && layerExists(map, layer)) box.checked = readVisible(map, layer);
        // a layer whose data file is missing draws nothing: do not show it as ticked
        if (info.state === "unavailable") box.checked = false;
      }

      const updated = row.querySelector(".legend-updated");
      const live = freshnessText(layer);
      if (updated && live) {
        updated.textContent = "";
        updated.appendChild(el("strong", null, "Updated: "));
        updated.appendChild(document.createTextNode(live));
      }
    });
  }

  function bind(container) {
    container.addEventListener("change", (event) => {
      const box = event.target;
      if (!(box instanceof HTMLInputElement) || box.type !== "checkbox") return;
      const row = box.closest("[data-layer]");
      const layer = LAYERS.find((item) => item.id === (row && row.dataset.layer));
      const api = window.AGOSMap;
      if (!layer || !layer.api || !api || typeof api.setLayerVisibility !== "function") return;
      api.setLayerVisibility(layer.api, box.checked);
      sync(container);
    });
  }

  function start() {
    const container = document.getElementById("agosLayerPanel");
    if (!container) return;

    render(container);
    bind(container);
    sync(container);

    // js/map.js creates the map later (when the Flood Map view opens), so
    // wait for it, then follow its changes.
    let attached = false;
    const timer = setInterval(() => {
      const api = window.AGOSMap;
      const map = api && typeof api.getMap === "function" ? api.getMap() : null;
      if (map && !attached && typeof map.on === "function") {
        attached = true;
        map.on("idle", () => sync(container));
      }
      sync(container);
      if (attached) clearInterval(timer);
    }, 1000);
  }

  if (typeof window !== "undefined") {
    window.AGOSLegend = { layers: LAYERS, groups: GROUPS, describeStatus, readVisible };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { LAYERS, GROUPS, layersInGroup, describeStatus, readVisible, layerExists };
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  }
})();
