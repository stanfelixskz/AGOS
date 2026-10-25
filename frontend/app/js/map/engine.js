/*
 * AGOS map engine (MapLibre). Owns the basemap and AGOS overlay layers.
 * Pages talk to it through the returned controller only.
 *
 * Labels use HTML markers instead of MapLibre text layers, so the map never
 * depends on font "glyph" files (the old map's labels failed for that reason).
 */

import { loadMapLibre } from "./loader.js";
import { escapeHTML } from "../core/format.js";
import { levelColor } from "../core/levels.js";
import { createRainFx } from "./rainfx.js";
import { addPinImages, PIN_ID, PIN_SELECTED_ID } from "./pins.js";
import { circlePolygon, destination, intensityLevel, kmToPixels, typhoonLayers, unscaledSize } from "./typhoon.js";

export const BATAAN_BOUNDS = [[120.18, 14.33], [120.72, 15.01]];
const MAX_BOUNDS = [[119.6, 13.9], [121.3, 15.45]];

const OPENFREEMAP = "https://tiles.openfreemap.org/styles";
const MGB_TILES = "https://controlmap.mgb.gov.ph/arcgis/rest/services/GeospatialDataInventory_Public/GDI_Detailed_Flood_Susceptibility_Public/MapServer/tile/{z}/{y}/{x}";
const PRECIP_TILES = "https://weathermaps.weatherapi.com/precip/tiles/{date}{hour}/{z}/{x}/{y}.png";
// First: PSGC 2023 boundaries kept in the repo (see app/data/). Then local
// files some machines have, so older setups keep working.
const BOUNDARY_FILES = [
  "app/data/bataan-municipalities-psgc2023.geojson",
  "data/bataan-municipalities.geojson",
  "data/bataan_province_boundary.geojson",
];

const RASTER_FALLBACK = {
  version: 8,
  sources: {
    "agos-fallback-basemap": {
      type: "raster",
      tiles: ["https://a.tile.opentopomap.org/{z}/{x}/{y}.png", "https://b.tile.opentopomap.org/{z}/{x}/{y}.png", "https://c.tile.opentopomap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 17,
      attribution: 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, <a href="https://opentopomap.org/">OpenTopoMap</a>',
    },
  },
  layers: [{ id: "agos-fallback-basemap", type: "raster", source: "agos-fallback-basemap", paint: { "raster-saturation": -0.55, "raster-opacity": 0.9 } }],
};

async function fetchStyle(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const style = await response.json();
    return style && style.version === 8 && Array.isArray(style.layers) ? style : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Pick a basemap: OpenFreeMap vector style, else the raster fallback. */
export async function resolveStyle(theme) {
  const candidates = theme === "dark" ? ["dark", "positron"] : ["positron"];
  for (const name of candidates) {
    const style = await fetchStyle(`${OPENFREEMAP}/${name}`);
    if (style) return { style, name: `OpenFreeMap ${name}`, vector: true };
  }
  return { style: RASTER_FALLBACK, name: "OpenTopoMap (fallback)", vector: false };
}

export function precipTileUrl(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  return { url: PRECIP_TILES.replace("{date}", day).replace("{hour}", pad(date.getUTCHours())), utcHour: `${day} ${pad(date.getUTCHours())}:00 UTC` };
}

/** Compare town names across sources ("City of Balanga" = "Balanga"). */
function normName(name) {
  return String(name || "").toLowerCase().replace(/city of |city/g, "").trim();
}

function featureName(feature) {
  const p = feature?.properties || {};
  return p.name ?? p.MUNICIPALITY ?? p.municipality ?? p.NAME_2 ?? p.name_2 ?? p.adm3_en ?? p.ADM3_EN ?? null;
}

/**
 * Create the map. options:
 *   theme, onSelectMunicipality(name), onSelectCenter(center), onSelectReport(report),
 *   onLayerState(states), interactive (default true)
 */
export async function createAgosMap(container, options = {}) {
  const maplibregl = await loadMapLibre();
  const basemap = await resolveStyle(options.theme);

  const map = new maplibregl.Map({
    container,
    style: basemap.style,
    bounds: BATAAN_BOUNDS,
    fitBoundsOptions: { padding: 24 },
    maxBounds: MAX_BOUNDS,
    attributionControl: { compact: true },
    cooperativeGestures: Boolean(options.cooperative),
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  if (options.interactive !== false) {
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  }

  const state = {
    visible: { boundaries: true, rain: true, rainfx: false, windfx: false, cloudfx: false, evacuation: true, reports: true, mgb: false, precip: false },
    // windfx and cloudfx are listed but not available: AGOS stores no wind direction, cloud cover or sun data yet.
    available: { boundaries: null, rain: null, rainfx: null, windfx: false, cloudfx: false, evacuation: null, reports: null, mgb: true, precip: true },
    messages: {},
    boundaries: null,
    centers: [],
    reports: [],
    rainRows: [],
    markers: new Map(),
    selected: null,
    selectedCenter: null,
    userMarker: null,
    typhoon: null,
    typhoonMarker: null,
    precip: precipTileUrl(),
    precipDate: null,       // null = the current hour
    precipOpacity: 0.7,
    precipStatus: "ok",     // ok | partial (some tiles failed) | missing (404: no tile for this hour)
    basemap,
  };

  let rainfx = null;
  const emit = () => options.onLayerState?.(layerStates());

  const rainfxRows = () => state.rainRows.map((row) => ({ name: row.name, mm: row.animMm }));

  function layerStates() {
    return Object.fromEntries(Object.keys(state.visible).map((id) => [id, {
      visible: state.visible[id],
      available: state.available[id],
      message: state.messages[id] || "",
    }]));
  }

  function vis(on) {
    return on ? "visible" : "none";
  }

  function firstOverlayLayerId() {
    // Rasters go above the basemap fills but under its labels (first symbol layer),
    // so place names stay readable. Without a vector basemap, under the AGOS shapes.
    const symbol = map.getStyle()?.layers?.find((l) => l.type === "symbol" && !l.id.startsWith("agos-"));
    if (symbol) return symbol.id;
    return map.getLayer("agos-boundary-fill") ? "agos-boundary-fill" : undefined;
  }

  function addRasterLayers() {
    if (!map.getSource("agos-mgb")) {
      map.addSource("agos-mgb", {
        type: "raster", tiles: [MGB_TILES], tileSize: 256, minzoom: 6, maxzoom: 14,
        attribution: 'Flood susceptibility © <a href="https://controlmap.mgb.gov.ph/">DENR–MGB</a>',
      });
    }
    if (!map.getLayer("agos-mgb")) {
      map.addLayer({ id: "agos-mgb", type: "raster", source: "agos-mgb", layout: { visibility: vis(state.visible.mgb) }, paint: { "raster-opacity": 0.62 } }, firstOverlayLayerId());
    }
    if (!map.getSource("agos-precip")) {
      map.addSource("agos-precip", { type: "raster", tiles: [state.precip.url], tileSize: 256, attribution: 'Precipitation © <a href="https://www.weatherapi.com/">WeatherAPI.com</a>' });
    }
    if (!map.getLayer("agos-precip")) {
      map.addLayer({ id: "agos-precip", type: "raster", source: "agos-precip", layout: { visibility: vis(state.visible.precip) }, paint: { "raster-opacity": state.precipOpacity } }, firstOverlayLayerId());
    }
  }

  function addBoundaryLayers() {
    if (!state.boundaries) return;
    if (!map.getSource("agos-boundaries")) {
      map.addSource("agos-boundaries", { type: "geojson", data: state.boundaries, attribution: state.boundaryAttribution || undefined });
    }
    if (!map.getLayer("agos-boundary-fill")) {
      // Town shapes: tinted with the rain level (feature-state "color"), stronger on hover/select.
      map.addLayer({
        id: "agos-boundary-fill", type: "fill", source: "agos-boundaries", layout: { visibility: vis(state.visible.boundaries || state.visible.rain) },
        paint: {
          "fill-color": ["coalesce", ["feature-state", "color"], "#0b63c4"],
          "fill-opacity": ["case",
            ["boolean", ["feature-state", "selected"], false], 0.46,
            ["boolean", ["feature-state", "hover"], false], 0.36,
            ["boolean", ["feature-state", "tinted"], false], 0.24,
            0.025],
        },
      });
    }
    if (!map.getLayer("agos-boundary-selected")) {
      map.addLayer({ id: "agos-boundary-selected", type: "line", source: "agos-boundaries", layout: { visibility: vis(state.visible.boundaries || state.visible.rain) }, paint: { "line-color": "#0b63c4", "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 3.2, 0] } });
    }
    if (!map.getLayer("agos-boundary-line")) {
      map.addLayer({ id: "agos-boundary-line", type: "line", source: "agos-boundaries", layout: { visibility: vis(state.visible.boundaries) }, paint: { "line-color": "#0b63c4", "line-opacity": 0.55, "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 12, 1.8] } });
    }
  }

  function centersGeoJSON() {
    return {
      type: "FeatureCollection",
      features: state.centers.filter((c) => c.has_coordinates).map((c) => ({
        type: "Feature", id: c.id,
        geometry: { type: "Point", coordinates: [c.longitude, c.latitude] },
        properties: { id: c.id, name: c.name, selected: c.id === state.selectedCenter ? 1 : 0 },
      })),
    };
  }

  function reportsGeoJSON() {
    return {
      type: "FeatureCollection",
      features: state.reports.filter((r) => Number.isFinite(r.longitude) && Number.isFinite(r.latitude)).map((r) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r.longitude, r.latitude] },
        properties: { id: r.report_id, severity: r.severity || "" },
      })),
    };
  }

  function addPointLayers() {
    if (!map.getSource("agos-centers")) map.addSource("agos-centers", { type: "geojson", data: centersGeoJSON() });
    addPinImages(map);
    if (!map.getLayer("agos-centers")) {
      // Shelter pins (canvas-drawn icons, no glyphs needed). The selected pin is larger and drawn on top.
      map.addLayer({
        id: "agos-centers", type: "symbol", source: "agos-centers",
        layout: {
          visibility: vis(state.visible.evacuation),
          "icon-image": ["case", ["==", ["get", "selected"], 1], PIN_SELECTED_ID, PIN_ID],
          "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.62, 13, 0.95],
          "icon-anchor": "bottom",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "symbol-sort-key": ["case", ["==", ["get", "selected"], 1], 1, 0],
        },
      });
    }
    if (!map.getSource("agos-reports")) map.addSource("agos-reports", { type: "geojson", data: reportsGeoJSON() });
    if (!map.getLayer("agos-reports")) {
      map.addLayer({
        id: "agos-reports", type: "circle", source: "agos-reports", layout: { visibility: vis(state.visible.reports) },
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4, 13, 7], "circle-color": "#7c3aed", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
      });
    }
  }

  // ---------------- typhoon (from an article) ----------------
  function typhoonGeoJSON() {
    const ty = state.typhoon;
    const radius = ty?.radius_km?.value;
    if (!ty?.position || !radius) return { type: "FeatureCollection", features: [] };
    return { type: "FeatureCollection", features: [circlePolygon([ty.position.longitude, ty.position.latitude], radius)] };
  }

  function addTyphoonLayers() {
    if (!map.getSource("agos-typhoon")) map.addSource("agos-typhoon", { type: "geojson", data: typhoonGeoJSON() });
    if (!map.getLayer("agos-typhoon-fill")) {
      map.addLayer({ id: "agos-typhoon-fill", type: "fill", source: "agos-typhoon", paint: { "fill-color": "#dc2626", "fill-opacity": 0.06 } });
    }
    if (!map.getLayer("agos-typhoon-line")) {
      map.addLayer({ id: "agos-typhoon-line", type: "line", source: "agos-typhoon", paint: { "line-color": "#dc2626", "line-width": 2, "line-opacity": 0.85, "line-dasharray": [3, 2] } });
    }
  }

  /** Keep the spiral the size of the stated wind extent at every zoom. */
  function sizeTyphoon() {
    const ty = state.typhoon;
    const el = state.typhoonMarker?.getElement();
    if (!ty || !el) return;
    const radius = ty.radius_km?.value;
    // Stated wind extent: true size on the map. Otherwise a fixed screen size by strength.
    const px = radius ? 2 * kmToPixels(radius, ty.position.latitude, map.getZoom()) : unscaledSize(intensityLevel(ty));
    el.style.setProperty("--size", `${Math.round(Math.min(4000, Math.max(28, px)))}px`);
  }

  function renderTyphoonMarker(label) {
    state.typhoonMarker?.remove();
    state.typhoonMarker = null;
    const ty = state.typhoon;
    if (!ty?.position) return;
    const el = document.createElement("div");
    el.className = `typhoon-marker${ty.position.latitude < 0 ? " is-south" : ""}${ty.radius_km ? "" : " is-unscaled"}`;
    const bearing = ty.movement?.bearing_deg;
    el.innerHTML = `
      ${Object.entries(typhoonLayers(intensityLevel(ty))).map(([part, svg]) => `<div class="typhoon-layer typhoon-${part}">${svg}</div>`).join("")}
      ${Number.isFinite(bearing) ? `<span class="typhoon-heading" style="--bearing:${bearing}deg" aria-hidden="true"></span>` : ""}
      <button type="button" class="typhoon-label">${escapeHTML(label)}</button>`;
    el.querySelector(".typhoon-label").addEventListener("click", (event) => {
      event.stopPropagation();
      options.onSelectTyphoon?.(ty);
    });
    state.typhoonMarker = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat([ty.position.longitude, ty.position.latitude])
      .addTo(map);
    sizeTyphoon();
  }

  function addAllOverlays() {
    addBoundaryLayers();
    addRasterLayers();
    addPointLayers();
    addTyphoonLayers();
    applyTint();
  }

  // ---------------- town shape tint, hover ----------------
  function featureIdFor(name) {
    const key = normName(name);
    return state.boundaries?.features.find((f) => normName(featureName(f)) === key)?.id;
  }

  /** Color each town shape by its rain level (only while the rain layer is on). */
  function applyTint() {
    if (!state.boundaries || !map.getSource("agos-boundaries")) return;
    const byId = new Map();
    if (state.visible.rain) {
      for (const row of state.rainRows) {
        const id = featureIdFor(row.name);
        if (id !== undefined) byId.set(id, row);
      }
    }
    for (const f of state.boundaries.features) {
      const row = byId.get(f.id);
      const tinted = Boolean(row) && row.level !== "nodata";
      map.setFeatureState({ source: "agos-boundaries", id: f.id }, { tinted, color: tinted ? levelColor(row.level) : null });
    }
  }

  function updateFillVisibility() {
    for (const id of ["agos-boundary-fill", "agos-boundary-selected"]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis(state.visible.boundaries || state.visible.rain));
    }
  }

  const hoverCard = document.createElement("div");
  hoverCard.className = "map-hovercard";
  hoverCard.hidden = true;
  hoverCard.setAttribute("aria-hidden", "true");
  container.appendChild(hoverCard);
  let hoverId = null;

  function clearHover() {
    if (hoverId !== null) map.setFeatureState({ source: "agos-boundaries", id: hoverId }, { hover: false });
    hoverId = null;
    hoverCard.hidden = true;
  }

  function onHover(event) {
    const feature = event.features?.[0];
    if (!feature || map.getZoom() >= 12) return clearHover();
    if (map.queryRenderedFeatures(event.point, { layers: ["agos-centers", "agos-reports"].filter((id) => map.getLayer(id)) }).length) return clearHover();
    if (feature.id !== hoverId) {
      clearHover();
      hoverId = feature.id;
      map.setFeatureState({ source: "agos-boundaries", id: hoverId }, { hover: true });
    }
    const key = normName(featureName(feature));
    const row = state.rainRows.find((r) => normName(r.name) === key);
    if (!row) return clearHover();
    hoverCard.innerHTML = `<strong>${escapeHTML(row.name)}</strong><span class="hc-level"><span class="hc-dot" style="background:${levelColor(row.level)}"></span>${escapeHTML(row.levelText || "")} · <span class="num">${escapeHTML(row.valueText)}</span></span><span class="hc-sub">${escapeHTML(row.modeText || "")}</span>`;
    hoverCard.hidden = false;
    // Keep the card inside the map: flip to the left / above the pointer near the edges.
    const width = hoverCard.offsetWidth || 160;
    const height = hoverCard.offsetHeight || 70;
    let x = event.point.x + 14;
    let y = event.point.y + 14;
    if (x + width > container.clientWidth - 8) x = event.point.x - 14 - width;
    if (y + height > container.clientHeight - 8) y = event.point.y - 14 - height;
    hoverCard.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }

  async function loadBoundaries() {
    for (const file of BOUNDARY_FILES) {
      try {
        const response = await fetch(file, { cache: "no-cache" });
        if (!response.ok) continue;
        const data = await response.json();
        if (data?.type === "FeatureCollection" && Array.isArray(data.features)) {
          data.features.forEach((f, i) => { f.id = i; });
          state.boundaries = data;
          state.boundaryAttribution = file.includes("psgc2023")
            ? 'Boundaries: PSA PSGC 2023 via <a href="https://github.com/faeldon/philippines-json-maps" target="_blank" rel="noopener noreferrer">philippines-json-maps</a> (MIT)'
            : "";
          state.available.boundaries = true;
          state.messages.boundaries = file.includes("province") ? "Only the province outline is available on this computer." : "";
          return;
        }
      } catch {
        /* try the next file */
      }
    }
    state.available.boundaries = false;
    state.messages.boundaries = "Boundary file not found (frontend/data/bataan-municipalities.geojson is kept outside the repository).";
  }

  /** Point the precipitation tiles at the chosen hour (only while the layer is on). */
  function applyPrecipTime() {
    const fresh = precipTileUrl(state.precipDate || new Date());
    if (fresh.url === state.precip.url) return false;
    state.precip = fresh;
    state.precipStatus = "ok";
    map.getSource("agos-precip")?.setTiles([fresh.url]);
    probePrecip(fresh.url);
    return true;
  }

  // MapLibre treats a 404 tile as "no data" and fires no error, so check one tile
  // over the middle of Bataan ourselves to tell the user when an hour has no tiles.
  let probeToken = 0;
  function probePrecip(templateUrl) {
    const token = ++probeToken;
    const z = 8;
    const lon = 120.45;
    const lat = 14.67;
    const n = 2 ** z;
    const x = Math.floor(((lon + 180) / 360) * n);
    const rad = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
    const img = new Image();
    img.onload = () => { if (token === probeToken && state.precipStatus === "missing") { state.precipStatus = "ok"; emit(); } };
    img.onerror = () => { if (token === probeToken && state.visible.precip) { state.precipStatus = "missing"; emit(); } };
    img.src = templateUrl.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  }

  // ---------------- interaction ----------------
  function bindInteractions() {
    map.on("click", "agos-centers", (event) => {
      const id = event.features?.[0]?.properties?.id;
      const center = state.centers.find((c) => c.id === id);
      if (center) {
        controller.selectCenter(center.id);
        options.onSelectCenter?.(center);
      }
    });
    map.on("click", "agos-reports", (event) => {
      const id = event.features?.[0]?.properties?.id;
      const report = state.reports.find((r) => r.report_id === id);
      if (report) options.onSelectReport?.(report);
    });
    map.on("click", "agos-boundary-fill", (event) => {
      if (map.queryRenderedFeatures(event.point, { layers: ["agos-centers", "agos-reports"].filter((id) => map.getLayer(id)) }).length) return;
      const name = featureName(event.features?.[0]);
      const match = name && state.rainRows.find((row) => normName(row.name) === normName(name));
      if (match) options.onSelectMunicipality?.(match.name);
    });
    if (window.matchMedia?.("(hover: hover)").matches) {
      map.on("mousemove", "agos-boundary-fill", onHover);
      map.on("mouseleave", "agos-boundary-fill", clearHover);
    }
    for (const id of ["agos-boundary-fill", "agos-centers", "agos-reports"]) {
      map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
    }
    const updateLabels = () => {
      container.classList.toggle("map-show-labels", map.getZoom() >= 10.2);
      // Zoomed in, town circles would cover nearby reports and centers.
      container.classList.toggle("map-zoomed", map.getZoom() >= 12);
    };
    map.on("zoom", updateLabels);
    map.on("zoom", sizeTyphoon);
    updateLabels();
  }

  // ---------------- rain markers (HTML) ----------------
  function renderRainMarkers() {
    const ids = new Set(state.rainRows.map((row) => row.name));
    for (const [name, marker] of state.markers) {
      if (!ids.has(name)) {
        marker.remove();
        state.markers.delete(name);
      }
    }
    for (const row of state.rainRows) {
      if (!row.point) continue;
      let marker = state.markers.get(row.name);
      if (!marker) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "rain-marker";
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          options.onSelectMunicipality?.(row.name);
        });
        marker = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([row.point.longitude, row.point.latitude]).addTo(map);
        state.markers.set(row.name, marker);
      }
      const el = marker.getElement();
      el.dataset.level = row.level;
      el.style.setProperty("--lvl", levelColor(row.level));
      el.style.display = state.visible.rain ? "" : "none";
      el.classList.toggle("is-selected", state.selected === row.name);
      el.setAttribute("aria-label", `${row.name}: ${row.labelText}. Open details.`);
      el.innerHTML = `<span class="rain-marker-dot"></span><span class="rain-marker-label"><strong>${escapeHTML(row.name)}</strong><span class="num">${escapeHTML(row.valueText)}</span></span>`;
    }
  }

  // ---------------- public controller ----------------
  const ready = new Promise((resolve) => {
    map.once("load", async () => {
      await loadBoundaries();
      state.available.rainfx = Boolean(state.boundaries);
      state.messages.rainfx = state.boundaries ? "" : "Needs the municipal boundaries.";
      if (state.boundaries) {
        rainfx = createRainFx(map, { theme: options.theme, nameOf: featureName });
        rainfx.setGeometry(state.boundaries);
        rainfx.setRates(rainfxRows());
        rainfx.setEnabled(state.visible.rainfx);
      }
      addAllOverlays();
      bindInteractions();
      renderRainMarkers();
      emit();
      resolve();
    });
  });

  // Some basemap styles reference sprite icons they do not ship (e.g. "circle-11").
  // Add an empty image so MapLibre stops warning; AGOS layers do not use them.
  map.on("styleimagemissing", (event) => {
    if (!map.hasImage(event.id)) map.addImage(event.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });

  map.on("error", (event) => {
    const sourceId = event?.sourceId || event?.source?.id || "";
    if (sourceId === "agos-mgb" && state.available.mgb !== false) {
      state.messages.mgb = "Some MGB tiles did not load (the MGB server may be slow or unreachable).";
      emit();
    }
    if (sourceId === "agos-precip" && state.visible.precip) {
      if (state.precipStatus === "ok") {
        state.precipStatus = "partial";
        emit();
      }
    }
  });

  const controller = {
    map,
    ready,
    basemap,

    layerStates,

    boundarySource() {
      return state.boundaryAttribution ? "psgc2023" : state.available.boundaries ? "local" : null;
    },

    setLayer(id, visible) {
      if (!(id in state.visible)) return;
      state.visible[id] = Boolean(visible);
      if (id === "precip" && visible) applyPrecipTime(); // point at the right hour before tiles start loading
      const layerIds = {
        boundaries: ["agos-boundary-line"],
        mgb: ["agos-mgb"], precip: ["agos-precip"], evacuation: ["agos-centers"], reports: ["agos-reports"],
      }[id] || [];
      for (const layerId of layerIds) {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", vis(state.visible[id]));
      }
      if (id === "precip" && visible) probePrecip(state.precip.url);
      if (id === "rainfx") rainfx?.setEnabled(visible);
      if (id === "rain" || id === "boundaries") updateFillVisibility();
      if (id === "rain") {
        applyTint();
        renderRainMarkers();
        if (!visible) clearHover();
      }
      emit();
    },

    /** Streaks per town right now (for tests). */
    rainfxCounts() {
      return rainfx?.counts() || {};
    },

    precipTime() {
      return state.precip.utcHour;
    },

    /** The hour the tiles show (a Date). */
    precipDate() {
      const date = new Date(state.precipDate || Date.now());
      date.setUTCMinutes(0, 0, 0);
      return date;
    },

    /** Show tiles for this Date, or the current hour when null. Cheap while the layer is off. */
    setPrecipTime(date) {
      state.precipDate = date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
      // While the layer is off only the date is remembered; the tiles update when it is switched on.
      if (state.visible.precip && applyPrecipTime()) emit();
    },

    precipOpacity() {
      return state.precipOpacity;
    },

    /** 0.1 to 1. Does not emit (the slider is being dragged). */
    setPrecipOpacity(value) {
      state.precipOpacity = Math.min(1, Math.max(0.1, Number(value) || 0.7));
      if (map.getLayer("agos-precip")) map.setPaintProperty("agos-precip", "raster-opacity", state.precipOpacity);
    },

    precipStatus() {
      return state.precipStatus;
    },

    /** rows: [{ name, point:{latitude,longitude}, level, valueText, labelText }] */
    setRain(rows, available = true, message = "") {
      state.rainRows = rows;
      state.available.rain = available;
      state.messages.rain = message;
      rainfx?.setRates(rainfxRows());
      applyTint();
      renderRainMarkers();
      emit();
    },

    setCenters(centers, available = true, message = "") {
      state.centers = centers || [];
      state.available.evacuation = available;
      state.messages.evacuation = message;
      map.getSource("agos-centers")?.setData(centersGeoJSON());
      emit();
    },

    setReports(reports, available = true, message = "") {
      state.reports = reports || [];
      state.available.reports = available;
      state.messages.reports = message;
      map.getSource("agos-reports")?.setData(reportsGeoJSON());
      emit();
    },

    /** Highlight one evacuation pin (null clears it). */
    selectCenter(id) {
      state.selectedCenter = id || null;
      map.getSource("agos-centers")?.setData(centersGeoJSON());
    },

    select(name) {
      state.selected = name;
      if (name && state.selectedCenter) controller.selectCenter(null);
      renderRainMarkers();
      if (state.boundaries && map.getSource("agos-boundaries")) {
        state.boundaries.features.forEach((f) => {
          const on = Boolean(name) && normName(featureName(f)) === normName(name);
          map.setFeatureState({ source: "agos-boundaries", id: f.id }, { selected: on });
        });
      }
    },

    flyTo(lon, lat, zoom = 11.2) {
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom), duration: 900, essential: true });
    },

    fitBataan() {
      map.fitBounds(BATAAN_BOUNDS, { padding: 24, duration: 700 });
    },

    /**
     * Show a storm read from an article (typhoon_service result with a
     * position). The map is unlocked from Bataan while a storm is shown,
     * and framed to show both the storm and Bataan.
     */
    setTyphoon(typhoon, label) {
      state.typhoon = typhoon?.position ? typhoon : null;
      map.getSource("agos-typhoon")?.setData(typhoonGeoJSON());
      renderTyphoonMarker(label);
      if (!state.typhoon) return;
      map.setMaxBounds(null);
      const center = [state.typhoon.position.longitude, state.typhoon.position.latitude];
      const reach = state.typhoon.radius_km?.value || 60;
      const lons = [BATAAN_BOUNDS[0][0], BATAAN_BOUNDS[1][0]];
      const lats = [BATAAN_BOUNDS[0][1], BATAAN_BOUNDS[1][1]];
      for (const bearing of [0, 90, 180, 270]) {
        const [lon, lat] = destination(center, bearing, reach);
        lons.push(lon);
        lats.push(lat);
      }
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 48, duration: 1200, maxZoom: 9 });
    },

    clearTyphoon() {
      state.typhoon = null;
      map.getSource("agos-typhoon")?.setData(typhoonGeoJSON());
      renderTyphoonMarker("");
      map.setMaxBounds(MAX_BOUNDS);
      controller.fitBataan();
    },

    showUser(lon, lat) {
      if (!state.userMarker) {
        const el = document.createElement("div");
        el.className = "user-marker";
        el.setAttribute("aria-label", "Your location");
        state.userMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
      } else {
        state.userMarker.setLngLat([lon, lat]);
      }
    },

    async setTheme(theme) {
      rainfx?.setTheme(theme);
      const next = await resolveStyle(theme);
      if (next.name === controller.basemap.name) return;
      controller.basemap = next;
      map.setStyle(next.style);
      map.once("style.load", () => {
        addAllOverlays();
        controller.select(state.selected);
      });
    },

    resize() {
      map.resize();
    },

    destroy() {
      for (const marker of state.markers.values()) marker.remove();
      state.userMarker?.remove();
      state.typhoonMarker?.remove();
      hoverCard.remove();
      rainfx?.destroy();
      map.remove();
    },
  };

  return controller;
}
