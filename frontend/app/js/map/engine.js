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

export const BATAAN_BOUNDS = [[120.18, 14.33], [120.72, 15.01]];

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
    maxBounds: [[119.6, 13.9], [121.3, 15.45]],
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
    visible: { boundaries: true, rain: true, evacuation: true, reports: true, mgb: false, precip: false },
    available: { boundaries: null, rain: null, evacuation: null, reports: null, mgb: true, precip: true },
    messages: {},
    boundaries: null,
    centers: [],
    reports: [],
    rainRows: [],
    markers: new Map(),
    selected: null,
    userMarker: null,
    precip: precipTileUrl(),
    basemap,
  };

  const emit = () => options.onLayerState?.(layerStates());

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
    // Put rasters under AGOS vectors but above the basemap.
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
      map.addLayer({ id: "agos-precip", type: "raster", source: "agos-precip", layout: { visibility: vis(state.visible.precip) }, paint: { "raster-opacity": 0.7 } }, firstOverlayLayerId());
    }
  }

  function addBoundaryLayers() {
    if (!state.boundaries) return;
    if (!map.getSource("agos-boundaries")) map.addSource("agos-boundaries", { type: "geojson", data: state.boundaries });
    if (!map.getLayer("agos-boundary-fill")) {
      map.addLayer({ id: "agos-boundary-fill", type: "fill", source: "agos-boundaries", layout: { visibility: vis(state.visible.boundaries) }, paint: { "fill-color": "#0b63c4", "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.12, 0.025] } });
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
        properties: { id: c.id, name: c.name },
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
    if (!map.getLayer("agos-centers")) {
      map.addLayer({
        id: "agos-centers", type: "circle", source: "agos-centers", layout: { visibility: vis(state.visible.evacuation) },
        paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4.5, 13, 8], "circle-color": "#16a34a", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
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

  function addAllOverlays() {
    addBoundaryLayers();
    addRasterLayers();
    addPointLayers();
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

  // ---------------- interaction ----------------
  function bindInteractions() {
    map.on("click", "agos-centers", (event) => {
      const id = event.features?.[0]?.properties?.id;
      const center = state.centers.find((c) => c.id === id);
      if (center) options.onSelectCenter?.(center);
    });
    map.on("click", "agos-reports", (event) => {
      const id = event.features?.[0]?.properties?.id;
      const report = state.reports.find((r) => r.report_id === id);
      if (report) options.onSelectReport?.(report);
    });
    map.on("click", "agos-boundary-fill", (event) => {
      if (map.queryRenderedFeatures(event.point, { layers: ["agos-centers", "agos-reports"].filter((id) => map.getLayer(id)) }).length) return;
      const name = featureName(event.features?.[0]);
      const match = name && state.rainRows.find((row) => row.name.toLowerCase().replace(/city of |city/g, "").trim() === String(name).toLowerCase().replace(/city of |city/g, "").trim());
      if (match) options.onSelectMunicipality?.(match.name);
    });
    for (const id of ["agos-centers", "agos-reports"]) {
      map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
    }
    const updateLabels = () => {
      container.classList.toggle("map-show-labels", map.getZoom() >= 10.2);
      // Zoomed in, town circles would cover nearby reports and centers.
      container.classList.toggle("map-zoomed", map.getZoom() >= 12);
    };
    map.on("zoom", updateLabels);
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
      state.messages.precip = "Some precipitation tiles did not load.";
      emit();
    }
  });

  const controller = {
    map,
    ready,
    basemap,

    layerStates,

    setLayer(id, visible) {
      if (!(id in state.visible)) return;
      state.visible[id] = Boolean(visible);
      const layerIds = {
        boundaries: ["agos-boundary-fill", "agos-boundary-line"],
        mgb: ["agos-mgb"], precip: ["agos-precip"], evacuation: ["agos-centers"], reports: ["agos-reports"],
      }[id] || [];
      for (const layerId of layerIds) {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", vis(state.visible[id]));
      }
      if (id === "precip" && visible) {
        const fresh = precipTileUrl();
        if (fresh.url !== state.precip.url) {
          state.precip = fresh;
          map.getSource("agos-precip")?.setTiles([fresh.url]);
        }
      }
      if (id === "rain") renderRainMarkers();
      emit();
    },

    precipTime() {
      return state.precip.utcHour;
    },

    /** rows: [{ name, point:{latitude,longitude}, level, valueText, labelText }] */
    setRain(rows, available = true, message = "") {
      state.rainRows = rows;
      state.available.rain = available;
      state.messages.rain = message;
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

    select(name) {
      state.selected = name;
      renderRainMarkers();
      if (state.boundaries && map.getSource("agos-boundaries")) {
        state.boundaries.features.forEach((f) => {
          const n = String(featureName(f) || "").toLowerCase();
          const on = Boolean(name) && n.replace(/city of |city/g, "").trim() === name.toLowerCase();
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
      map.remove();
    },
  };

  return controller;
}
