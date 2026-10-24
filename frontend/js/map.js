/*
 * AGOS — MapLibre Flood Intelligence Map
 * Complete replacement for frontend/js/map.js
 *
 * Includes:
 * - Topographic basemap and Bataan GIS layers
 * - Evacuation centers and municipality boundaries
 * - Optional terrain tiles and weather grids
 * - Real WeatherAPI precipitation raster overlay
 * - Precipitation visibility controls and UTC-hour tile updates
 * - Municipality selector with smooth fly-to and center markers
 * - Municipality-panel flood outlook combining provisional MGB observations and rainfall forecast
 * - Open-Meteo current conditions; realistic precipitation tiles are separate from local conditions
 *
 * IMPORTANT:
 * - Weather precipitation is not a confirmed flood observation.
 * - Terrain layers require prepared XYZ tiles.
 */

(() => {
  "use strict";

  // Keep map controls independent: municipality selector at upper-left,
  // feature details at lower-left, and Flood Risk & Weather controls at lower-right.
  // Rainfall outlook now lives inside the selected municipality information panel;
  // there is deliberately no separate right-side Storm Outlook panel.
  const agosPanelStyle = document.createElement("style");
  agosPanelStyle.textContent = `
    #agos-municipality-control, #agos-precipitation-controls, #agos-feature-panel {
      pointer-events: auto;
    }
    #agos-municipality-control {
      z-index: 20 !important;
      top: 12px !important;
      left: 12px !important;
      right: auto !important;
    }
    #agos-precipitation-controls {
      z-index: 19 !important;
      top: auto !important;
      right: 12px !important;
      bottom: 12px !important;
      left: auto !important;
      width: 220px !important;
      max-height: 48vh !important;
      overflow-y: auto !important;
    }
    #agos-feature-panel {
      z-index: 21 !important;
      left: 12px !important;
      bottom: 12px !important;
      width: min(330px, calc(100% - 24px)) !important;
      max-height: min(58vh, 520px) !important;
      overflow-y: auto !important;
    }
    @media (max-width: 640px) {
      #agos-municipality-control {
        top: 10px !important; left: 10px !important; right: auto !important;
        width: min(220px, calc(100% - 84px)) !important;
      }
      #agos-precipitation-controls {
        top: auto !important; right: 10px !important; bottom: 10px !important; left: auto !important;
        width: min(220px, calc(100% - 20px)) !important;
        max-height: 46vh !important;
      }
      #agos-feature-panel {
        left: 10px !important; bottom: 10px !important;
        width: min(330px, calc(100% - 20px)) !important;
        max-height: 44vh !important;
      }
    }
    @media (max-height: 560px) {
      #agos-precipitation-controls { max-height: 42vh !important; }
      #agos-feature-panel { max-height: 42vh !important; }
    }
  `;
  document.head.appendChild(agosPanelStyle);

  // ------------------------------------------------------------
  // 1. CONFIGURATION
  // ------------------------------------------------------------

  const CONFIG = {
    mapElementId: "map",
    center: [120.45, 14.62],
    zoom: 9.3,

    bounds: [
      [120.18, 14.33],
      [120.72, 15.01]
    ],

    data: {
      municipalities: "data/bataan-municipalities.geojson",
      provinceBoundary: "data/bataan_province_boundary.geojson",
      floodReports: "data/flood-data.json",
      evacuationCenters: "data/evacuation-centers.json"
    },

    api: {
      rainfallGrid: "http://127.0.0.1:8000/weather/grid",
      forecastGrid: "http://127.0.0.1:8000/weather/forecast-grid",
      rainfallOutlook: "http://127.0.0.1:8000/weather/rainfall-outlook?hours=6",
      floodOutlook: "http://127.0.0.1:8000/weather/flood-outlook?forecast_days=7",
    },

    weatherMap: {
      precipitationTileTemplate:
        "https://weathermaps.weatherapi.com/precip/tiles/{date}{hour}/{z}/{x}/{y}.png",

      tileSize: 256,
      opacity: 0.68,

      // Check periodically, but replace tiles only when the
      // current UTC hour changes.
      refreshIntervalMs: 60000
    },

    terrainTiles: {
      elevation: "data/tiles/elevation/{z}/{x}/{y}.png",
      slope: "data/tiles/slope/{z}/{x}/{y}.png",
      flow: "data/tiles/flow_accumulation/{z}/{x}/{y}.png"
    },

    refreshIntervalMs: 60000
  };

  const COLORS = {
    boundary: "#287b9c",
    evacuation: "#21845c"
  };

  // ------------------------------------------------------------
  // 2. STATE
  // ------------------------------------------------------------

  let map = null;
  let initialized = false;
  let refreshTimer = null;
  let resizeHandler = null;
  let precipitationRefreshTimer = null;
  let lastPrecipitationHour = null;
  let precipitationControl = null;
  let precipitationStatusElement = null;
  let precipitationTimestampElement = null;
  let precipitationToggleElement = null;
  let precipitationRefreshButton = null;
  let precipitationLoading = false;
  let stormAssessmentControl = null;
  let stormAssessmentTimer = null;
  let stormAssessmentLoading = false;
  let stormAssessmentData = null;
  const floodMonitoringReferenceMm = 30; // Prototype normalization reference for the current 6-hour outlook; not an official threshold.

  const loadedData = {};
  const layerAvailability = {};

  const visibility = {
    municipalities: true,
    provinceBoundary: true,
    evacuationCenters: true,
    rainfallGrid: false,
    forecastGrid: false,
    elevation: false,
    slope: false,
    flow: false,
    precipitation: false,
    baselineFloodSusceptibility: false
  };

  const ids = {
    municipalitiesSource: "agos-municipalities",
    municipalityMarkersSource: "agos-municipality-markers",
    provinceSource: "agos-province-boundary",
    evacuationSource: "agos-evacuation-centers",
    heatmapSource: "agos-evidence-heatmap",
    rainfallSource: "agos-rainfall-grid",
    forecastSource: "agos-forecast-grid",
    precipitationSource: "agos-weather-precipitation",
    baselineFloodSusceptibilitySource: "agos-mgb-baseline-flood-susceptibility"
  };

  const LAYER_IDS = {
    basemap: "agos-topographic-basemap-layer",

    municipalities: [
      "agos-municipality-fill",
      "agos-municipality-outline",
      "agos-municipality-labels"
    ],

    evacuation: ["agos-evacuation-centers"],

    precipitation: "agos-weather-precipitation-layer",
    baselineFloodSusceptibility: "agos-mgb-baseline-flood-susceptibility-layer"
  };

  // ------------------------------------------------------------
  // 3. GENERAL HELPERS
  // ------------------------------------------------------------

  function byId(id) {
    return document.getElementById(id);
  }

  function setStatus(message, state = "loading") {
    const status = byId("mapStatus");

    if (status) {
      status.textContent = message;
      status.classList.remove("ok", "error");

      if (state === "ok") status.classList.add("ok");
      if (state === "error") status.classList.add("error");
    }

    const dataState = byId("dataState");
    if (dataState) dataState.textContent = message;
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function property(feature, names) {
    const props = feature?.properties || {};

    for (const name of names) {
      if (
        props[name] !== undefined &&
        props[name] !== null &&
        props[name] !== ""
      ) {
        return props[name];
      }
    }

    return null;
  }

  function validFeatureCollection(data) {
    return Boolean(
      data &&
      data.type === "FeatureCollection" &&
      Array.isArray(data.features)
    );
  }

  function normalizeGeoJSON(data) {
    if (validFeatureCollection(data)) return data;

    if (data?.type === "Feature") {
      return {
        type: "FeatureCollection",
        features: [data]
      };
    }

    if (
      data &&
      typeof data.type === "string" &&
      Array.isArray(data.coordinates)
    ) {
      return {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: {},
          geometry: data
        }]
      };
    }

    if (data?.geojson) {
      return normalizeGeoJSON(data.geojson);
    }

    if (data?.data?.type) {
      return normalizeGeoJSON(data.data);
    }

    throw new Error("The response is not valid GeoJSON.");
  }

  async function fetchJSON(url) {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-cache"
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async function fetchOptionalGeoJSON(url) {
    try {
      const data = normalizeGeoJSON(await fetchJSON(url));

      return {
        ok: true,
        data,
        message: `${data.features.length} features loaded`
      };
    } catch (error) {
      return {
        ok: false,
        data: {
          type: "FeatureCollection",
          features: []
        },
        message: `${url}: ${error.message}`
      };
    }
  }

  function addGeoJSONSource(sourceId, data) {
    if (map.getSource(sourceId)) {
      map.getSource(sourceId).setData(data);
      return;
    }

    map.addSource(sourceId, {
      type: "geojson",
      data
    });
  }

  function addIfMissing(layer) {
    if (!map.getLayer(layer.id)) {
      map.addLayer(layer);
    }
  }

  function setLayerVisibility(layerId, visible) {
    if (!map || !map.getLayer(layerId)) return;

    map.setLayoutProperty(
      layerId,
      "visibility",
      visible ? "visible" : "none"
    );
  }

  function setVisibilityGroup(layerIds, visible) {
    layerIds.forEach(id => setLayerVisibility(id, visible));
  }

  function setPrecipitationStatus(message, state = "info") {
    if (!precipitationStatusElement) return;

    precipitationStatusElement.textContent = message;
    precipitationStatusElement.dataset.state = state;

    if (precipitationTimestampElement) {
      const match = String(message).match(/(?:tile time|Tiles updated ·)\s*(.+?)(?:\. Overlay is off\.)?$/i);
      if (match) {
        precipitationTimestampElement.textContent = `TILE TIMESTAMP · ${match[1].replace(/\. Overlay is off\.$/i, "")}`;
      } else if (/updating/i.test(message)) {
        precipitationTimestampElement.textContent = "TILE TIMESTAMP · UPDATING…";
      } else if (/unable|failed|error/i.test(message)) {
        precipitationTimestampElement.textContent = "TILE TIMESTAMP · UNAVAILABLE";
      } else if (/overlay is off/i.test(message)) {
        precipitationTimestampElement.textContent = "TILE TIMESTAMP · OVERLAY OFF";
      }
    }

    if (state === "error") {
      precipitationStatusElement.style.color = "#fca5a5";
    } else if (state === "ok") {
      precipitationStatusElement.style.color = "#86efac";
    } else {
      precipitationStatusElement.style.color = "#cbd5e1";
    }
  }

  // ------------------------------------------------------------
  // 4. WEATHERAPI PRECIPITATION TILE URL
  // ------------------------------------------------------------

  function getPrecipitationTileTime(date = new Date()) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hour = String(date.getUTCHours()).padStart(2, "0");

    return {
      date: `${year}${month}${day}`,
      hour,
      key: `${year}${month}${day}${hour}`
    };
  }

  function getPrecipitationTileUrl(date = new Date()) {
    const time = getPrecipitationTileTime(date);

    return CONFIG.weatherMap.precipitationTileTemplate
      .replace("{date}", time.date)
      .replace("{hour}", time.hour);
  }

  function formatPrecipitationTimestamp(date = new Date()) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date) + " UTC";
  }

  // ------------------------------------------------------------
  // 5. WEATHERAPI PRECIPITATION CONTROL PANEL
  // ------------------------------------------------------------

  function createPrecipitationControls(container) {
    if (precipitationControl) return;

    const panel = document.createElement("section");
    panel.id = "agos-precipitation-controls";
    panel.setAttribute("aria-label", "Weather precipitation layer");

    Object.assign(panel.style, {
      position: "absolute",
      top: "auto",
      right: "12px",
      bottom: "12px",
      left: "auto",
      zIndex: "19",
      width: "220px",
      maxWidth: "calc(100% - 24px)",
      maxHeight: "34vh",
      overflowY: "auto",
      boxSizing: "border-box",
      padding: "8px",
      borderRadius: "10px",
      background: "rgba(13, 31, 48, 0.96)",
      color: "#f8fafc",
      font: "12px/1.5 system-ui, sans-serif",
      boxShadow: "0 3px 14px rgba(0,0,0,.25)"
    });

    panel.innerHTML = `
      <div style="font-size:12px;font-weight:800;margin-bottom:3px">
        Flood Risk & Weather
      </div>

      <div style="font-size:9px;color:#c4b5fd;letter-spacing:.03em;margin-bottom:5px">
        BASELINE SUSCEPTIBILITY · DENR–MGB
      </div>

      <label style="display:flex;align-items:flex-start;gap:6px;cursor:pointer;margin-bottom:5px">
        <input
          id="agos-baseline-flood-susceptibility-toggle"
          type="checkbox"
          style="accent-color:#a78bfa;width:13px;height:13px;min-width:13px;margin:2px 0 0;flex:0 0 13px"
        >
        <span>Show baseline flood-susceptibility areas</span>
      </label>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 6px;margin:0 0 6px;font-size:9px;color:#e2e8f0">
        <span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#002673;margin-right:4px"></i>Very high</span>
        <span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#5900ff;margin-right:4px"></i>High</span>
        <span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#b045ff;margin-right:4px"></i>Moderate</span>
        <span><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#e3d1ff;margin-right:4px"></i>Low</span>
      </div>

      <div id="agos-baseline-flood-susceptibility-note" style="font-size:9px;line-height:1.35;color:#cbd5e1;margin-bottom:8px">
        Baseline susceptibility only — not a live storm forecast or a prediction that flooding will occur.
      </div>

      <div style="height:1px;background:rgba(148,163,184,.3);margin:0 0 8px"></div>

      <div style="font-size:12px;font-weight:700;margin-bottom:2px">
        Precipitation
      </div>

      <div style="
        color:#93c5fd;
        font-size:9px;
        letter-spacing:.03em;
        margin-bottom:5px
      ">
        WEATHERAPI PRECIPITATION TILES
      </div>

      <label style="
        display:flex;
        align-items:center;
        gap:6px;
        cursor:pointer;
        margin-bottom:5px
      ">
        <input
          id="agos-precipitation-toggle"
          type="checkbox"
          style="accent-color:#38bdf8;width:13px;height:13px;min-width:13px;margin:0;flex:0 0 13px"
        >
        <span>Show precipitation overlay</span>
      </label>

      <div
        id="agos-precipitation-status"
        role="status"
        aria-live="polite"
        style="color:#cbd5e1;margin-bottom:5px;font-size:10px;line-height:1.3"
      >
        Precipitation overlay is off.
      </div>

      <div id="agos-precipitation-timestamp" style="
        display:block;
        padding:5px 6px;
        margin:0 0 6px;
        border:1px solid rgba(56,189,248,.65);
        border-radius:7px;
        background:rgba(8,47,73,.78);
        color:#f8fafc;
        font-size:10px;
        font-weight:800;
        line-height:1.3;
        letter-spacing:.01em
      ">
        TILE TIME · WAITING FOR UPDATE
      </div>

      <button
        id="agos-precipitation-refresh"
        type="button"
        style="
          padding:4px 7px;
          font-size:10px;
          border:0;
          border-radius:5px;
          cursor:pointer;
          background:#38bdf8;
          color:#082f49;
          font-weight:700
        "
      >
        Refresh map
      </button>

      <p style="
        color:#cbd5e1;
        font-size:9px;
        line-height:1.3;
        margin:6px 0 0
      ">
        Weather tiles depend on provider availability and timestamps.
        Precipitation is not a confirmed flood observation.
      </p>
    `;

    container.appendChild(panel);

    precipitationControl = panel;
    precipitationStatusElement =
      panel.querySelector("#agos-precipitation-status");
    precipitationTimestampElement =
      panel.querySelector("#agos-precipitation-timestamp");

    precipitationToggleElement =
      panel.querySelector("#agos-precipitation-toggle");

    precipitationRefreshButton =
      panel.querySelector("#agos-precipitation-refresh");

    precipitationToggleElement.checked = visibility.precipitation;

    const baselineFloodToggle = panel.querySelector(
      "#agos-baseline-flood-susceptibility-toggle"
    );
    if (baselineFloodToggle) {
      baselineFloodToggle.checked = visibility.baselineFloodSusceptibility;
      baselineFloodToggle.addEventListener("change", () => {
        visibility.baselineFloodSusceptibility = baselineFloodToggle.checked;
        setLayerVisibility(
          LAYER_IDS.baselineFloodSusceptibility,
          visibility.baselineFloodSusceptibility
        );
      });
    }

    precipitationToggleElement.addEventListener("change", async () => {
      const enabled = precipitationToggleElement.checked;
      visibility.precipitation = enabled;

      if (!enabled) {
        setLayerVisibility(LAYER_IDS.precipitation, false);
        setPrecipitationStatus("Precipitation overlay is off.");
        return;
      }

      await refreshPrecipitationLayer(true);
    });

    precipitationRefreshButton.addEventListener("click", async () => {
      await refreshPrecipitationLayer(true);
    });
  }

  // ------------------------------------------------------------
  // 6. WEATHERAPI PRECIPITATION RASTER LAYER
  // ------------------------------------------------------------

  async function refreshPrecipitationLayer(force = false) {
    if (!map || !map.isStyleLoaded()) return false;
    if (precipitationLoading) return false;

    const now = new Date();
    const tileTime = getPrecipitationTileTime(now);

    if (
      !force &&
      tileTime.key === lastPrecipitationHour &&
      map.getSource(ids.precipitationSource)
    ) {
      setLayerVisibility(
        LAYER_IDS.precipitation,
        visibility.precipitation
      );

      return true;
    }

    precipitationLoading = true;

    if (precipitationRefreshButton) {
      precipitationRefreshButton.disabled = true;
      precipitationRefreshButton.textContent = "Refreshing…";
      precipitationRefreshButton.style.opacity = "0.7";
    }

    setPrecipitationStatus("Updating precipitation map…");

    try {
      const tileUrl = getPrecipitationTileUrl(now);

      /*
       * The WeatherAPI tile URL contains a date and UTC hour.
       * Re-create the raster source when refreshing so MapLibre
       * requests tiles for the correct time.
       */
      if (map.getLayer(LAYER_IDS.precipitation)) {
        map.removeLayer(LAYER_IDS.precipitation);
      }

      if (map.getSource(ids.precipitationSource)) {
        map.removeSource(ids.precipitationSource);
      }

      map.addSource(ids.precipitationSource, {
        type: "raster",
        tiles: [tileUrl],
        tileSize: CONFIG.weatherMap.tileSize,
        minzoom: 0,
        maxzoom: 18,
        attribution:
          '<a href="https://www.weatherapi.com/" target="_blank" ' +
          'rel="noopener noreferrer">WeatherAPI.com</a>'
      });

      map.addLayer({
        id: LAYER_IDS.precipitation,
        type: "raster",
        source: ids.precipitationSource,
        layout: {
          visibility: visibility.precipitation ? "visible" : "none"
        },
        paint: {
          "raster-opacity": CONFIG.weatherMap.opacity,
          "raster-fade-duration": 250
        }
      });

      lastPrecipitationHour = tileTime.key;
      layerAvailability.precipitation = true;

      setPrecipitationStatus(
        visibility.precipitation
          ? `Overlay enabled · tile time ${formatPrecipitationTimestamp(now)}`
          : `Tiles updated · ${formatPrecipitationTimestamp(now)}. Overlay is off.`,
        "ok"
      );

      console.info("AGOS precipitation tiles updated:", {
        url: tileUrl,
        utcHour: tileTime.key,
        visible: visibility.precipitation
      });

      return true;
    } catch (error) {
      layerAvailability.precipitation = false;

      console.warn(
        "AGOS: Could not initialize precipitation tiles:",
        error
      );

      setPrecipitationStatus(
        "Unable to initialize precipitation tiles. Check the network and tile URL.",
        "error"
      );

      return false;
    } finally {
      precipitationLoading = false;

      if (precipitationRefreshButton) {
        precipitationRefreshButton.disabled = false;
        precipitationRefreshButton.textContent = "Refresh map";
        precipitationRefreshButton.style.opacity = "1";
      }
    }
  }

  function startPrecipitationRefreshTimer() {
    if (precipitationRefreshTimer) {
      clearInterval(precipitationRefreshTimer);
    }

    precipitationRefreshTimer = setInterval(() => {
      if (!map || !map.isStyleLoaded()) return;

      const currentKey = getPrecipitationTileTime(new Date()).key;

      // Replace the source only when the UTC tile hour changes.
      if (currentKey !== lastPrecipitationHour) {
        refreshPrecipitationLayer(true);
      }
    }, CONFIG.weatherMap.refreshIntervalMs);
  }

  function stopPrecipitationRefreshTimer() {
    if (precipitationRefreshTimer) {
      clearInterval(precipitationRefreshTimer);
      precipitationRefreshTimer = null;
    }
  }

  // ------------------------------------------------------------
  // 7. BASEMAP
  // ------------------------------------------------------------

  function addBasemap() {
    if (map.getSource("agos-topographic-basemap")) return;

    map.addSource("agos-topographic-basemap", {
      type: "raster",
      tiles: [
        "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
        "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
        "https://c.tile.opentopomap.org/{z}/{x}/{y}.png"
      ],
      tileSize: 256,
      attribution:
        'Map data: © <a href="https://www.openstreetmap.org/copyright">' +
        'OpenStreetMap contributors</a> | ' +
        '<a href="https://opentopomap.org/">OpenTopoMap</a>'
    });

    map.addLayer({
      id: LAYER_IDS.basemap,
      type: "raster",
      source: "agos-topographic-basemap",
      layout: { visibility: "visible" },
      paint: { "raster-opacity": 1 }
    });
  }

  // ------------------------------------------------------------
  // 8. OFFICIAL MGB BASELINE FLOOD SUSCEPTIBILITY
  // ------------------------------------------------------------

  function addBaselineFloodSusceptibilityLayer() {
    const sourceId = ids.baselineFloodSusceptibilitySource;
    const layerId = LAYER_IDS.baselineFloodSusceptibility;

    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, {
        type: "raster",
        tiles: [
          "https://controlmap.mgb.gov.ph/arcgis/rest/services/GeospatialDataInventory_Public/GDI_Detailed_Flood_Susceptibility_Public/MapServer/tile/{z}/{y}/{x}"
        ],
        tileSize: 256,
        minzoom: 6,
        maxzoom: 14,
        attribution:
          'Flood susceptibility: <a href="https://controlmap.mgb.gov.ph/arcgis/rest/services/GeospatialDataInventory_Public/GDI_Detailed_Flood_Susceptibility_Public/MapServer" target="_blank" rel="noopener noreferrer">DENR–MGB Geospatial Data Inventory</a>'
      });
    }

    if (!map.getLayer(layerId)) {
      // Added immediately after the basemap so AGOS evidence, boundaries,
      // markers, and evacuation centers remain visible above this raster.
      map.addLayer({
        id: layerId,
        type: "raster",
        source: sourceId,
        layout: {
          visibility: visibility.baselineFloodSusceptibility ? "visible" : "none"
        },
        paint: {
          "raster-opacity": 0.56,
          "raster-fade-duration": 250
        }
      });
    }

    layerAvailability.baselineFloodSusceptibility = true;
  }

  // ------------------------------------------------------------
  // 9. MUNICIPALITIES AND BOUNDARIES
  // ------------------------------------------------------------

  async function loadMunicipalities() {
    let result = await fetchOptionalGeoJSON(
      CONFIG.data.municipalities
    );

    if (!result.ok) {
      const fallback = await fetchOptionalGeoJSON(
        CONFIG.data.provinceBoundary
      );

      if (fallback.ok) {
        result = fallback;
        layerAvailability.provinceBoundary = true;
      }
    } else {
      layerAvailability.provinceBoundary = false;
    }

    loadedData.municipalities = result.data;
    layerAvailability.municipalities = result.ok;

    addGeoJSONSource(ids.municipalitiesSource, result.data);

    addIfMissing({
      id: "agos-municipality-fill",
      type: "fill",
      source: ids.municipalitiesSource,
      paint: {
        "fill-color": "#4d9cb3",
        "fill-opacity": 0.045
      }
    });

    addIfMissing({
      id: "agos-municipality-outline",
      type: "line",
      source: ids.municipalitiesSource,
      paint: {
        "line-color": COLORS.boundary,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          7, 0.8,
          12, 1.8
        ],
        "line-opacity": 0.9
      }
    });

    if (result.ok) {
      addIfMissing({
        id: "agos-municipality-labels",
        type: "symbol",
        source: ids.municipalitiesSource,
        layout: {
          "text-field": [
            "coalesce",
            ["get", "MUNICIPALITY"],
            ["get", "municipality"],
            ["get", "NAME_2"],
            ["get", "name"],
            ["get", "name_2"],
            ""
          ],
          "text-size": 11,
          "text-font": ["Open Sans Regular"],
          "text-allow-overlap": false
        },
        paint: {
          "text-color": "#163f51",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.4
        }
      });
    }

    setVisibilityGroup(
      LAYER_IDS.municipalities,
      visibility.municipalities
    );
  }

  // ------------------------------------------------------------
  // 9. POPUPS
  // ------------------------------------------------------------

  function showFeaturePopup(
    lngLat,
    feature,
    title,
    disclaimer = ""
  ) {
    const props = feature.properties || {};

    const rows = Object.entries(props)
      .filter(([, value]) =>
        value !== null &&
        value !== undefined &&
        value !== "" &&
        typeof value !== "object"
      )
      .slice(0, 12)
      .map(([key, value]) => `
        <div>
          <strong>${escapeHTML(key.replaceAll("_", " "))}:</strong>
          ${escapeHTML(value)}
        </div>
      `)
      .join("");

    new maplibregl.Popup({ maxWidth: "320px" })
      .setLngLat(lngLat)
      .setHTML(`
        <div class="popup-title">${escapeHTML(title)}</div>
        ${rows || "<div>No descriptive attributes available.</div>"}
        ${disclaimer ? `<p>${escapeHTML(disclaimer)}</p>` : ""}
      `)
      .addTo(map);
  }

  function bindPolygonPopup(
    layerId,
    title,
    fields,
    disclaimer
  ) {
    if (!map.getLayer(layerId)) return;

    map.on("click", layerId, event => {
      const feature = event.features?.[0];
      if (!feature) return;

      const rows = fields
        .map(([label, keys]) => {
          const value = property(feature, keys);
          if (value === null) return "";

          return `
            <div>
              <strong>${escapeHTML(label)}:</strong>
              ${escapeHTML(value)}
            </div>
          `;
        })
        .filter(Boolean)
        .join("");

      new maplibregl.Popup({ maxWidth: "320px" })
        .setLngLat(event.lngLat)
        .setHTML(`
          <div class="popup-title">${escapeHTML(title)}</div>
          ${rows || "<div>No additional attributes available.</div>"}
          <p>${escapeHTML(disclaimer)}</p>
        `)
        .addTo(map);
    });

    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });

    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
  }

  // ------------------------------------------------------------
  // 12. EVACUATION CENTERS
  // ------------------------------------------------------------

  function normalizeEvacuationData(raw) {
    if (raw?.type === "FeatureCollection") {
      return normalizeGeoJSON(raw);
    }

    if (raw?.geojson) {
      return normalizeGeoJSON(raw.geojson);
    }

    const records = Array.isArray(raw)
      ? raw
      : raw?.centers ||
        raw?.evacuation_centers ||
        raw?.data;

    if (!Array.isArray(records)) {
      throw new Error(
        "Expected GeoJSON or a list of evacuation-center records."
      );
    }

    const features = [];

    for (const record of records) {
      const lat = Number(record.latitude ?? record.lat);
      const lon = Number(
        record.longitude ?? record.lon ?? record.lng
      );

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < -90 || lat > 90 ||
        lon < -180 || lon > 180
      ) {
        continue;
      }

      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [lon, lat]
        },
        properties: { ...record }
      });
    }

    return {
      type: "FeatureCollection",
      features
    };
  }

  async function loadEvacuationCenters() {
    let result;

    try {
      const raw = await fetchJSON(
        CONFIG.data.evacuationCenters
      );

      result = {
        ok: true,
        data: normalizeEvacuationData(raw),
        message: "Evacuation locations loaded"
      };
    } catch (error) {
      const alternate = await fetchOptionalGeoJSON(
        "data/evacuation-centers.geojson"
      );

      result = alternate.ok
        ? alternate
        : {
            ok: false,
            data: {
              type: "FeatureCollection",
              features: []
            },
            message: error.message
          };
    }

    loadedData.evacuationCenters = result.data;
    layerAvailability.evacuationCenters = result.ok;

    addGeoJSONSource(ids.evacuationSource, result.data);

    addIfMissing({
      id: "agos-evacuation-centers",
      type: "circle",
      source: ids.evacuationSource,
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          7, 4,
          13, 7
        ],
        "circle-color": COLORS.evacuation,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2
      }
    });

    setLayerVisibility(
      "agos-evacuation-centers",
      visibility.evacuationCenters
    );

    map.on("click", "agos-evacuation-centers", event => {
      const feature = event.features?.[0];
      if (!feature) return;

      showEvacuationCenterPanel(feature, event.lngLat);
    });

    map.on("mouseenter", "agos-evacuation-centers", () => {
      map.getCanvas().style.cursor = "pointer";
    });

    map.on("mouseleave", "agos-evacuation-centers", () => {
      map.getCanvas().style.cursor = "";
    });
  }

  // ------------------------------------------------------------
  // 13. OPTIONAL TERRAIN RASTER TILES
  // ------------------------------------------------------------

  function addTerrainRasterLayers() {
    const terrain = [
      {
        key: "elevation",
        sourceId: "agos-elevation-tiles",
        layerId: "agos-elevation-layer",
        tiles: CONFIG.terrainTiles.elevation,
        opacity: 0.55
      },
      {
        key: "slope",
        sourceId: "agos-slope-tiles",
        layerId: "agos-slope-layer",
        tiles: CONFIG.terrainTiles.slope,
        opacity: 0.65
      },
      {
        key: "flow",
        sourceId: "agos-flow-tiles",
        layerId: "agos-flow-layer",
        tiles: CONFIG.terrainTiles.flow,
        opacity: 0.75
      }
    ];

    terrain.forEach(item => {
      if (!map.getSource(item.sourceId)) {
        map.addSource(item.sourceId, {
          type: "raster",
          tiles: [item.tiles],
          tileSize: 256,
          minzoom: 0,
          maxzoom: 18
        });
      }

      if (!map.getLayer(item.layerId)) {
        map.addLayer({
          id: item.layerId,
          type: "raster",
          source: item.sourceId,
          layout: { visibility: "none" },
          paint: { "raster-opacity": item.opacity }
        });
      }

      layerAvailability[item.key] = false;
    });
  }

  // ------------------------------------------------------------
  // 14. WEATHER GRIDS
  // ------------------------------------------------------------

  async function loadWeatherGrid(
    endpoint,
    sourceId,
    layerId,
    enabled
  ) {
    try {
      const data = normalizeGeoJSON(await fetchJSON(endpoint));

      addGeoJSONSource(sourceId, data);

      addIfMissing({
        id: layerId,
        type: "fill",
        source: sourceId,
        paint: {
          "fill-color": [
            "interpolate",
            ["linear"],
            [
              "to-number",
              [
                "coalesce",
                ["get", "rainfall_mm"],
                ["get", "rainfall"],
                0
              ]
            ],
            0, "#eff6ff",
            5, "#93c5fd",
            15, "#3b82f6",
            30, "#7c3aed",
            50, "#991b1b"
          ],
          "fill-opacity": 0.48,
          "fill-outline-color": "#ffffff"
        }
      });

      setLayerVisibility(layerId, enabled);
      return true;
    } catch (error) {
      console.warn(
        `AGOS: Could not load weather grid ${endpoint}:`,
        error.message
      );

      return false;
    }
  }

  async function refreshWeatherLayers() {
    if (!map || !map.isStyleLoaded()) return;

    const [rainfallOK, forecastOK] = await Promise.all([
      loadWeatherGrid(
        CONFIG.api.rainfallGrid,
        ids.rainfallSource,
        "agos-rainfall-grid-layer",
        visibility.rainfallGrid
      ),
      loadWeatherGrid(
        CONFIG.api.forecastGrid,
        ids.forecastSource,
        "agos-forecast-grid-layer",
        visibility.forecastGrid
      )
    ]);

    layerAvailability.rainfallGrid = rainfallOK;
    layerAvailability.forecastGrid = forecastOK;
  }

  // ------------------------------------------------------------
  // 14A. PHASE 2 — STORM-BASED FLOOD CONCERN OUTLOOK
  // ------------------------------------------------------------
  // This panel reports forecast rainfall at configured municipality
  // reference points. It does NOT claim that rainfall alone predicts
  // flooding, and it does not convert the MGB raster into a numeric score.

  function stormFindRecords(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== "object") return [];
    const preferred = ["municipalities", "locations", "results", "outlook", "items", "data", "records"];
    for (const key of preferred) {
      if (Array.isArray(payload[key])) return payload[key];
      if (payload[key] && typeof payload[key] === "object") {
        const nested = stormFindRecords(payload[key]);
        if (nested.length) return nested;
      }
    }
    return [];
  }

  function stormMunicipalityName(record) {
    const value = record?.municipality ?? record?.municipality_name ?? record?.name ?? record?.location ?? record?.admin_name;
    return value == null ? "Unknown municipality" : String(value);
  }

  function stormRainfallTotal(record) {
    // The AGOS /weather/rainfall-outlook endpoint returns this exact aggregate field.
    const keys = ["precipitation_accumulation_mm", "total_rainfall_mm", "rainfall_total_mm", "total_precipitation_mm", "precipitation_sum_mm", "rainfall_mm", "total_mm", "rainfall_total", "precipitation_mm", "total_precipitation"];
    for (const key of keys) {
      const value = record?.[key];
      if (value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))) return Number(value);
    }
    // Some API versions expose the aggregate under a nested summary.
    for (const obj of [record?.summary, record?.rainfall, record?.precipitation, record?.outlook]) {
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const found = stormRainfallTotal(obj);
        if (found !== null) return found;
      }
    }
    return null;
  }

  function stormRainfallLabel(mm) {
    if (mm === null) return { label: "No data", color: "#94a3b8" };
    // These are display bands for forecast accumulation, not official flood thresholds.
    if (mm < 1) return { label: "Little forecast rain", color: "#93c5fd" };
    if (mm < 10) return { label: "Rain forecast", color: "#38bdf8" };
    if (mm < 30) return { label: "Elevated rainfall", color: "#fbbf24" };
    return { label: "Heavy rainfall outlook", color: "#fb7185" };
  }

  function normalizeMunicipalityKey(value) {
    return String(value || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/\b(municipality|municipal|city|of)\b/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  // Do not infer municipality-wide susceptibility classes from visual estimates.
  // AGOS currently displays the MGB raster separately and
  // does not extract a numeric raster class for the selected municipality.
  function getMunicipalityFloodAssessment(municipality, rainfallRow) {
    const rainfall = rainfallRow?.mm;
    const periodHours = Number(rainfallRow?.record?.accumulation_period_hours) || 6;
    const rainfallAvailable = rainfall != null && Number.isFinite(Number(rainfall));
    const category = rainfallAvailable ? stormRainfallLabel(Number(rainfall)) : null;
    return {
      available: false,
      baselineLabel: "MGB raster shown on map",
      baselineNote: "AGOS does not currently extract a municipality-level susceptibility value from the raster, so no combined score is calculated.",
      outlookLabel: rainfallAvailable ? category.label : "Forecast rainfall unavailable",
      explanation: "The MGB baseline is a mapped susceptibility layer. Forecast rainfall is shown separately; these inputs are not combined into a flood probability or official warning.",
      rainfallMm: rainfallAvailable ? Number(rainfall) : null,
      periodHours
    };
  }

  function createStormAssessmentControl() {
    // Intentionally no standalone panel. Rainfall outlook is integrated into
    // the selected municipality's information panel to prevent control overlap.
    stormAssessmentControl = null;
  }

  function updateStormWarningMarkers(rows) {
    if (!map || !map.isStyleLoaded() || !Array.isArray(rows)) return;
    const known = new Map(MUNICIPALITIES.map(item => [item.name.toLowerCase(), item]));
    const features = rows.map(row => {
      const municipality = known.get(String(row.name || "").toLowerCase());
      if (!municipality) return null;
      const category = stormRainfallLabel(row.mm);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: municipality.coordinates },
        properties: {
          name: municipality.name,
          rainfall_mm: row.mm,
          rainfall_label: category.label,
          rainfall_color: category.color
        }
      };
    }).filter(Boolean);
    const data = { type: "FeatureCollection", features };
    const sourceId = "agos-storm-rainfall-warning-points";
    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, { type: "geojson", data });
      map.addLayer({
        id: "agos-storm-rainfall-warning-circles",
        type: "circle", source: sourceId,
        paint: {
          "circle-radius": ["case", [">=", ["to-number", ["get", "rainfall_mm"], -1], 30], 12,
            [">=", ["to-number", ["get", "rainfall_mm"], -1], 10], 10,
            [">=", ["to-number", ["get", "rainfall_mm"], -1], 1], 8, 6],
          "circle-color": ["case",
            [">=", ["to-number", ["get", "rainfall_mm"], -1], 30], "#fb7185",
            [">=", ["to-number", ["get", "rainfall_mm"], -1], 10], "#fbbf24",
            [">=", ["to-number", ["get", "rainfall_mm"], -1], 1], "#38bdf8", "#93c5fd"],
          "circle-opacity": 0.9,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2
        }
      });
      map.addLayer({
        id: "agos-storm-rainfall-warning-labels",
        type: "symbol", source: sourceId,
        layout: { "text-field": ["concat", ["get", "name"], " · ", ["to-string", ["round", ["to-number", ["get", "rainfall_mm"], 0]]], " mm"],
          "text-size": 10, "text-offset": [0, 1.8], "text-font": ["Open Sans Bold"], "text-allow-overlap": false },
        paint: { "text-color": "#0f172a", "text-halo-color": "#ffffff", "text-halo-width": 1.6 }
      });
      ["agos-storm-rainfall-warning-circles", "agos-storm-rainfall-warning-labels"].forEach(layerId => {
        map.on("click", layerId, event => {
          const feature = event.features?.[0];
          const name = feature?.properties?.name;
          if (name) selectMunicipalityFromMarker(name);
        });
        map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
      });
    } else {
      map.getSource(sourceId).setData(data);
    }
    // Keep warnings visible above the baseline raster while preserving its toggle.
    ["agos-storm-rainfall-warning-circles", "agos-storm-rainfall-warning-labels"].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
    });
  }

  async function refreshStormAssessment(force = false) {
    if (stormAssessmentLoading) return;
    stormAssessmentLoading = true;
    const status = byId("agos-storm-status");
    const list = byId("agos-storm-list");
    if (status && (!stormAssessmentData || force)) status.textContent = "Updating forecast rainfall…";
    try {
      const rainfallPayload = await fetchJSON(CONFIG.api.rainfallOutlook);
      const records = stormFindRecords(rainfallPayload);
      const rows = records.map(record => ({
        name: stormMunicipalityName(record),
        mm: stormRainfallTotal(record),
        record
      })).filter(row => row.name !== "Unknown municipality" || row.mm !== null);
      if (!rows.length) {
        stormAssessmentData = { rainfallPayload, rows: [], unsupportedShape: true };
        if (status) status.textContent = "Rainfall API responded, but its record format was not recognized. Check the backend response in /weather/rainfall-outlook.";
        if (list) list.innerHTML = "";
        if (MUNICIPALITY_PANEL.currentKind === "municipality" && MUNICIPALITY_PANEL.currentRecord) {
          showMunicipalityPanel(MUNICIPALITY_PANEL.currentRecord);
        }
        return;
      }
      rows.sort((a, b) => (b.mm ?? -1) - (a.mm ?? -1));
      stormAssessmentData = { rows, retrievedAt: new Date().toISOString() };
      updateStormWarningMarkers(rows);
      if (status) status.textContent = `Forecast totals for ${rows.length} location${rows.length === 1 ? "" : "s"}.`;
      if (list) list.innerHTML = "";
      if (MUNICIPALITY_PANEL.currentKind === "municipality" && MUNICIPALITY_PANEL.currentRecord) {
        showMunicipalityPanel(MUNICIPALITY_PANEL.currentRecord);
      }
      console.info("AGOS municipality rainfall outlook updated", { count: rows.length, retrievedAt: stormAssessmentData.retrievedAt });
    } catch (error) {
      console.warn("AGOS storm rainfall outlook unavailable:", error);
      if (status) status.textContent = `Rainfall outlook unavailable: ${error.message}. Confirm the FastAPI backend is running and /weather/rainfall-outlook is reachable.`;
      if (list && !stormAssessmentData) list.innerHTML = "";
      if (MUNICIPALITY_PANEL.currentKind === "municipality" && MUNICIPALITY_PANEL.currentRecord) {
        showMunicipalityPanel(MUNICIPALITY_PANEL.currentRecord);
      }
    } finally {
      stormAssessmentLoading = false;
    }
  }

  function startStormAssessmentRefresh() {
    if (stormAssessmentTimer) clearInterval(stormAssessmentTimer);
    stormAssessmentTimer = setInterval(() => refreshStormAssessment(false), 10 * 60 * 1000);
  }


  function removeEvidenceAndCandidateControls() {
    const selectors = [
      "#candidateToggle", "#floodToggle",
      "[data-action=\"evidence\"]", "[data-action=\"risk\"]", "[data-action=\"reports\"]"
    ];
    document.querySelectorAll(selectors.join(",")).forEach(element => {
      const wrapper = element.closest("label, .map-control, .control-item, .layer-control") || element;
      wrapper.remove();
    });
    document.querySelectorAll("button, label, [role=button]").forEach(element => {
      const text = (element.textContent || "").trim().toLowerCase();
      if (/^(evidence|flood evidence|candidate zones|candidate zone)$/.test(text)) {
        element.remove();
      }
    });
  }

  // ------------------------------------------------------------
  // 15. MAP CONTROLS
  // ------------------------------------------------------------

  function bindCheckbox(elementId, callback) {
    const element = byId(elementId);
    if (!element) return;

    element.addEventListener("change", () => {
      callback(element.checked);
    });
  }

  function bindControls() {
    bindCheckbox("boundaryToggle", value => {
      visibility.municipalities = value;

      setVisibilityGroup(LAYER_IDS.municipalities, value);
      setVisibilityGroup(["agos-municipality-marker-circles", "agos-municipality-marker-labels"], value);
    });

    bindCheckbox("evacToggle", value => {
      visibility.evacuationCenters = value;

      setLayerVisibility("agos-evacuation-centers", value);
    });

    bindCheckbox("elevationToggle", value => {
      visibility.elevation = value;
      setLayerVisibility("agos-elevation-layer", value);
    });

    bindCheckbox("slopeToggle", value => {
      visibility.slope = value;
      setLayerVisibility("agos-slope-layer", value);
    });

    bindCheckbox("flowToggle", value => {
      visibility.flow = value;
      setLayerVisibility("agos-flow-layer", value);
    });

    bindCheckbox("terrainToggle", value => {
      setLayerVisibility(LAYER_IDS.basemap, value);
    });

    const fitButton = byId("fitBataan");
    if (fitButton) {
      fitButton.addEventListener("click", fitBataan);
    }

    const resetButton = byId("resetLayers");
    if (resetButton) {
      resetButton.addEventListener("click", resetLayers);
    }

    const coordinateReadout = byId("coordinateReadout");

    if (coordinateReadout) {
      map.on("mousemove", event => {
        coordinateReadout.textContent =
          `${event.lngLat.lat.toFixed(5)}, ` +
          `${event.lngLat.lng.toFixed(5)}`;
      });
    }

    const fitBataanButton = byId("mapFitBataan");
    if (fitBataanButton && fitBataanButton !== fitButton) {
      fitBataanButton.addEventListener("click", fitBataan);
    }

    document.querySelectorAll(".map-control[data-action]").forEach(button => {
      if (button.dataset.agosBound === "true") return;
      button.dataset.agosBound = "true";

      button.addEventListener("click", () => {
        const action = button.dataset.action;

        const groups = {
          centers: LAYER_IDS.evacuation
        };

        if (action === "evidence" || action === "risk" || action === "reports") {
          button.remove();
          return;
        }
        if (!groups[action]) return;

        const layerIds = groups[action];

        const currentlyVisible = layerIds.some(id =>
          map.getLayer(id) &&
          map.getLayoutProperty(id, "visibility") !== "none"
        );

        setVisibilityGroup(layerIds, !currentlyVisible);

        if (action === "centers") {
          visibility.evacuationCenters = !currentlyVisible;
        }

        button.setAttribute(
          "aria-pressed",
          String(!currentlyVisible)
        );
      });
    });
  }

  function resetLayers() {
    Object.keys(visibility).forEach(key => {
      if (
        [
          "elevation",
          "slope",
          "flow",
          "rainfallGrid",
          "forecastGrid",
          "precipitation",
          "baselineFloodSusceptibility"
        ].includes(key)
      ) {
        visibility[key] = false;
      } else {
        visibility[key] = true;
      }
    });

    const checkboxes = {
      boundaryToggle: visibility.municipalities,
      evacToggle: visibility.evacuationCenters,
      elevationToggle: false,
      slopeToggle: false,
      flowToggle: false,
      terrainToggle: true
    };

    Object.entries(checkboxes).forEach(([id, checked]) => {
      const element = byId(id);
      if (element) element.checked = checked;
    });

    if (precipitationToggleElement) {
      precipitationToggleElement.checked = false;
    }

    const baselineFloodToggle = precipitationControl?.querySelector(
      "#agos-baseline-flood-susceptibility-toggle"
    );
    if (baselineFloodToggle) baselineFloodToggle.checked = false;
    setLayerVisibility(LAYER_IDS.baselineFloodSusceptibility, false);

    setVisibilityGroup(
      LAYER_IDS.municipalities,
      visibility.municipalities
    );

    setVisibilityGroup(
      LAYER_IDS.evacuation,
      visibility.evacuationCenters
    );

    setLayerVisibility("agos-elevation-layer", false);
    setLayerVisibility("agos-slope-layer", false);
    setLayerVisibility("agos-flow-layer", false);
    setLayerVisibility(LAYER_IDS.basemap, true);
    setLayerVisibility(LAYER_IDS.precipitation, false);

    setPrecipitationStatus("Precipitation overlay is off.");

    fitBataan();
  }

  function fitBataan() {
    if (!map) return;

    ATMOSPHERE.selected = null;
    ATMOSPHERE.weather = null;
    const municipalitySelect = byId("agos-municipality-select");
    if (municipalitySelect) municipalitySelect.value = "";
    ATMOSPHERE.status = "Province-wide view · choose a municipality for local weather.";
    updateAtmosphereStatus();
    updateAtmosphereVisibility();

    map.fitBounds(CONFIG.bounds, {
      padding: 40,
      duration: 800,
      maxZoom: 11
    });
  }

  // ------------------------------------------------------------
  // 16. DATA STATUS
  // ------------------------------------------------------------

  async function loadAllData() {
    setStatus("Loading Bataan datasets…");

    const results = await Promise.allSettled([
      loadMunicipalities(),
      loadEvacuationCenters()
    ]);

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(
          `AGOS dataset loader ${index + 1} failed:`,
          result.reason
        );
      }
    });

    await refreshWeatherLayers();
    updateDataStatus();
  }

  function updateDataStatus() {
    const checks = [
      ["Municipal boundaries", layerAvailability.municipalities],
      ["Evacuation centers", layerAvailability.evacuationCenters]
    ];

    const available = checks
      .filter(([, ok]) => ok)
      .map(([name]) => name);

    const missing = checks
      .filter(([, ok]) => !ok)
      .map(([name]) => name);

    let message = "";

    if (available.length) {
      message += `Loaded: ${available.join(", ")}. `;
    }

    if (missing.length) {
      message += `Unavailable: ${missing.join(", ")}. `;
    }

    message +=
      "Evidence and candidate-zone overlays are disabled. " +
      "MGB baseline flood susceptibility is a separate geospatial layer, not a live storm prediction. " +
      "Weather precipitation is a separate weather layer.";

    setStatus(
      missing.length === checks.length
        ? "Map ready · local datasets unavailable"
        : "Map ready · check data status",
      missing.length === checks.length ? "error" : "ok"
    );

    const dataState = byId("dataState");
    if (dataState) dataState.textContent = message;

    console.info("AGOS map data status:", {
      available,
      missing,
      terrainTiles: CONFIG.terrainTiles,
      precipitation: {
        available: layerAvailability.precipitation,
        visible: visibility.precipitation,
        currentUTCHour: lastPrecipitationHour
      },
      baselineFloodSusceptibility: {
        available: layerAvailability.baselineFloodSusceptibility,
        visible: visibility.baselineFloodSusceptibility,
        source: "DENR-MGB public detailed flood susceptibility map service"
      }
    });
  }

  // ------------------------------------------------------------
  // 17. INITIALIZATION
  // ------------------------------------------------------------

  function initializeMap() {
    removeEvidenceAndCandidateControls();
    if (initialized) return;

    const container = byId(CONFIG.mapElementId);

    if (!container) {
      console.error("AGOS: Map container #map was not found.");
      setStatus("Map container not found", "error");
      return;
    }

    if (typeof maplibregl === "undefined") {
      console.error(
        "AGOS: MapLibre GL JS is not loaded. Check index.html."
      );
      setStatus("MapLibre library missing", "error");
      return;
    }

    initialized = true;

    map = new maplibregl.Map({
      container: CONFIG.mapElementId,

      style: {
        version: 8,
        sources: {},
        layers: []
      },

      center: CONFIG.center,
      zoom: CONFIG.zoom,
      minZoom: 7,
      maxZoom: 18,
      attributionControl: true
    });

    map.addControl(
      new maplibregl.NavigationControl({
        visualizePitch: true
      }),
      "top-right"
    );

    map.addControl(
      new maplibregl.ScaleControl({
        maxWidth: 120,
        unit: "metric"
      }),
      "bottom-left"
    );

    map.addControl(
      new maplibregl.FullscreenControl(),
      "top-right"
    );

    map.on("error", event => {
      console.warn(
        "AGOS MapLibre event:",
        event.error || event
      );
    });

    map.on("load", async () => {
      try {
        addBasemap();
        addBaselineFloodSusceptibilityLayer();
        addTerrainRasterLayers();
        addMunicipalityMarkers();
        bindControls();

        // Add the real precipitation overlay control.
        createPrecipitationControls(map.getCanvasContainer());
        // Rainfall outlook is integrated into the selected municipality panel;
        // do not create a separate Storm Outlook panel over the layer controls.
        createStormAssessmentControl(map.getCanvasContainer());
        createMunicipalityControl(map.getCanvasContainer());
        createAtmosphereCanvas(map.getCanvasContainer());
        map.on("zoom", updateAtmosphereVisibility);
        map.on("moveend", updateAtmosphereVisibility);
        startAtmosphereWeatherRefresh();

        await loadAllData();
        await refreshStormAssessment(true);
        startStormAssessmentRefresh();

        // Load the current hourly tile even while the overlay
        // is initially off, so the user can enable it immediately.
        await refreshPrecipitationLayer(true);
        startPrecipitationRefreshTimer();

        if (refreshTimer) {
          clearInterval(refreshTimer);
        }

        refreshTimer = setInterval(() => {
          refreshWeatherLayers().catch(error => {
            console.warn(
              "AGOS weather grid refresh failed:",
              error
            );
          });
        }, CONFIG.refreshIntervalMs);

        fitBataan();
        map.resize();

        console.info("AGOS MapLibre map initialized.");
      } catch (error) {
        console.error(
          "AGOS map initialization failed:",
          error
        );

        setStatus("Map initialization failed", "error");
      }
    });

    resizeHandler = () => {
      if (map) map.resize();
      resizeAtmosphereCanvas();
      updateAtmosphereVisibility();
    };

    window.addEventListener("resize", resizeHandler);
  }

  // ------------------------------------------------------------
  // 18. PUBLIC API FOR EXISTING AGOS SCRIPTS
  // ------------------------------------------------------------

  window.AGOSMap = {
    initializeMap,

    getMap() {
      return map;
    },

    invalidateSize() {
      if (map) map.resize();
    },

    fitBataan,

    refresh() {
      if (!map || !map.isStyleLoaded()) {
        return Promise.resolve();
      }

      return loadAllData();
    },

    refreshWeather() {
      return refreshWeatherLayers();
    },

    refreshStormAssessment() {
      return refreshStormAssessment(true);
    },

    getStormAssessment() {
      return stormAssessmentData ? JSON.parse(JSON.stringify(stormAssessmentData)) : null;
    },

    refreshPrecipitation() {
      return refreshPrecipitationLayer(true);
    },

    loadEvacuationCenters,

    setLayerVisibility(name, visible) {
      const key = String(name || "")
        .toLowerCase()
        .replace(/[\s_-]/g, "");

      const aliases = {
        municipality: LAYER_IDS.municipalities,
        municipalities: LAYER_IDS.municipalities,

        evacuation: LAYER_IDS.evacuation,
        evacuationcenters: LAYER_IDS.evacuation,

        elevation: ["agos-elevation-layer"],
        slope: ["agos-slope-layer"],
        flow: ["agos-flow-layer"],
        flowaccumulation: ["agos-flow-layer"],

        precipitation: [LAYER_IDS.precipitation],
        weathermap: [LAYER_IDS.precipitation],
        weatherradar: [LAYER_IDS.precipitation],
        rainfall: [LAYER_IDS.precipitation],

        baselinerisk: [LAYER_IDS.baselineFloodSusceptibility],
        baselinesusceptibility: [LAYER_IDS.baselineFloodSusceptibility],
        floodsusceptibility: [LAYER_IDS.baselineFloodSusceptibility],
        mgbfloodsusceptibility: [LAYER_IDS.baselineFloodSusceptibility],

        terrain: [LAYER_IDS.basemap],
        topographic: [LAYER_IDS.basemap]
      };

      const layerIds = aliases[key];
      if (!layerIds) return false;

      if (key === "precipitation" ||
          key === "weathermap" ||
          key === "weatherradar" ||
          key === "rainfall") {
        visibility.precipitation = Boolean(visible);

        if (precipitationToggleElement) {
          precipitationToggleElement.checked = visibility.precipitation;
        }

        if (visible && !map?.getSource(ids.precipitationSource)) {
          refreshPrecipitationLayer(true);
        } else {
          setVisibilityGroup(layerIds, Boolean(visible));
        }

        if (!visible) {
          setPrecipitationStatus("Precipitation overlay is off.");
        }

        return true;
      }

      if (key === "municipality" || key === "municipalities") {
        visibility.municipalities = Boolean(visible);
      }

      if (
        key === "evacuation" ||
        key === "evacuationcenters"
      ) {
        visibility.evacuationCenters = Boolean(visible);
      }

      if (key === "baselinerisk" || key === "baselinesusceptibility" ||
          key === "floodsusceptibility" || key === "mgbfloodsusceptibility") {
        visibility.baselineFloodSusceptibility = Boolean(visible);
        const baselineFloodToggle = precipitationControl?.querySelector(
          "#agos-baseline-flood-susceptibility-toggle"
        );
        if (baselineFloodToggle) baselineFloodToggle.checked = Boolean(visible);
      }

      if (key === "elevation") visibility.elevation = Boolean(visible);
      if (key === "slope") visibility.slope = Boolean(visible);

      if (key === "flow" || key === "flowaccumulation") {
        visibility.flow = Boolean(visible);
      }

      setVisibilityGroup(layerIds, Boolean(visible));
      return true;
    },

    selectMunicipality(name) {
      const municipality = MUNICIPALITIES.find(item => item.name.toLowerCase() === String(name || "").toLowerCase());
      if (!municipality || !map) return false;
      ATMOSPHERE.selected = municipality;
      const select = byId("agos-municipality-select");
      if (select) select.value = String(MUNICIPALITIES.indexOf(municipality));
      map.flyTo({ center: municipality.coordinates, zoom: 12, duration: 1600, essential: true });
      showMunicipalityMarker(municipality);
      refreshMunicipalityMarkerStyle();
      showMunicipalityPanel(municipality);
      loadMunicipalityWeather(municipality);
      updateAtmosphereVisibility();
      return true;
    },

    getSelectedMunicipality() {
      return ATMOSPHERE.selected ? { ...ATMOSPHERE.selected, weather: ATMOSPHERE.weather ? { ...ATMOSPHERE.weather } : null } : null;
    },

    getDataStatus() {
      return { ...layerAvailability };
    },

    getLoadedData() {
      return { ...loadedData };
    },

    setMapMode(mode) {
      const value = String(mode || "").toLowerCase();

      if (value === "terrain" || value === "topographic") {
        setLayerVisibility(LAYER_IDS.basemap, true);
        return;
      }

      if (value === "default") {
        resetLayers();
      }
    },

    destroy() {
      stopPrecipitationRefreshTimer();

      if (stormAssessmentTimer) {
        clearInterval(stormAssessmentTimer);
        stormAssessmentTimer = null;
      }
      stormAssessmentControl?.remove();
      stormAssessmentControl = null;
      stormAssessmentData = null;
      stormAssessmentLoading = false;

      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }

      if (resizeHandler) {
        window.removeEventListener("resize", resizeHandler);
        resizeHandler = null;
      }

      if (precipitationControl) {
        precipitationControl.remove();
        precipitationControl = null;
      }

      precipitationStatusElement = null;
      precipitationTimestampElement = null;
      precipitationToggleElement = null;
      precipitationRefreshButton = null;

      destroyAtmosphere();
      MUNICIPALITY_PANEL.element?.remove();
      MUNICIPALITY_PANEL.element = null;
      MUNICIPALITY_PANEL.currentKind = null;
      MUNICIPALITY_PANEL.currentRecord = null;

      if (map) {
        map.remove();
        map = null;
      }

      lastPrecipitationHour = null;
      precipitationLoading = false;
      initialized = false;
    }
  };


  // ------------------------------------------------------------
  // 18A. MUNICIPALITY SELECTOR + LOCAL WEATHER ATMOSPHERE
  // ------------------------------------------------------------

  const MUNICIPALITIES = [
    { name: "Abucay", coordinates: [120.5348, 14.7213] },
    { name: "Bagac", coordinates: [120.3922, 14.5967] },
    { name: "Balanga", coordinates: [120.5409, 14.6795] },
    { name: "Dinalupihan", coordinates: [120.4631, 14.8663] },
    { name: "Hermosa", coordinates: [120.5075, 14.8312] },
    { name: "Limay", coordinates: [120.5949, 14.5625] },
    { name: "Mariveles", coordinates: [120.4903, 14.4356] },
    { name: "Morong", coordinates: [120.2652, 14.6779] },
    { name: "Orani", coordinates: [120.5367, 14.8007] },
    { name: "Orion", coordinates: [120.5802, 14.6198] },
    { name: "Pilar", coordinates: [120.5528, 14.6669] },
    { name: "Samal", coordinates: [120.5421, 14.7693] }
  ];

  const ATMOSPHERE = {
    // Let users see the atmosphere at normal municipality-level zoom.
    activationZoom: 9.5,
    fadeRange: 0.5,
    refreshMs: 10 * 60 * 1000,
    weatherEndpoint: "https://api.open-meteo.com/v1/forecast",
    selected: null,
    weather: null,
    status: "Choose a municipality to load its weather.",
    panel: null,
    canvas: null,
    context: null,
    frame: null,
    timer: null,
    particles: [],
    lastFrame: 0,
    visibleAmount: 0,
    active: false,
    destroyed: false
  };

  function createMunicipalityControl(container) {
    if (byId("agos-municipality-control")) return;

    const panel = document.createElement("section");
    panel.id = "agos-municipality-control";
    panel.setAttribute("aria-label", "Bataan municipality selector");
    Object.assign(panel.style, {
      position: "absolute", top: "12px", left: "12px", zIndex: "20",
      width: "230px", maxWidth: "calc(100% - 24px)", boxSizing: "border-box",
      padding: "12px", borderRadius: "10px", background: "rgba(13,31,48,.96)",
      color: "#f8fafc", font: "12px/1.5 system-ui,sans-serif",
      boxShadow: "0 3px 14px rgba(0,0,0,.25)"
    });
    panel.innerHTML = `
      <label for="agos-municipality-select" style="display:block;font-weight:700;font-size:14px;margin-bottom:7px">Explore Bataan</label>
      <select id="agos-municipality-select" style="width:100%;padding:8px;border:1px solid #64748b;border-radius:6px;background:#f8fafc;color:#0f172a">
        <option value="">Choose a municipality…</option>
        ${MUNICIPALITIES.map((m, i) => `<option value="${i}">${escapeHTML(m.name)}</option>`).join("")}
      </select>
      <div id="agos-local-weather-status" role="status" aria-live="polite" style="margin-top:8px;color:#cbd5e1">${escapeHTML(ATMOSPHERE.status)}</div>
      <div style="margin-top:6px;color:#94a3b8;font-size:10px">Weather effects appear when zoomed in. Weather: Open-Meteo.</div>
    `;
    container.appendChild(panel);
    ATMOSPHERE.panel = panel;
    panel.querySelector("#agos-municipality-select").addEventListener("change", event => {
      const index = event.target.value;
      if (index === "") {
        ATMOSPHERE.selected = null;
        ATMOSPHERE.weather = null;
        ATMOSPHERE.status = "Choose a municipality to load its weather.";
        updateAtmosphereStatus();
        updateAtmosphereVisibility();
        return;
      }
      const municipality = MUNICIPALITIES[Number(index)];
      if (!municipality) return;
      ATMOSPHERE.selected = municipality;
      map.flyTo({ center: municipality.coordinates, zoom: 12, duration: 1600, essential: true });
      showMunicipalityMarker(municipality);
      refreshMunicipalityMarkerStyle();
      showMunicipalityPanel(municipality);
      loadMunicipalityWeather(municipality);
      updateAtmosphereVisibility();
    });
  }

  function showMunicipalityMarker(municipality) {
    const feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: municipality.coordinates },
      properties: { name: municipality.name }
    };
    const data = { type: "FeatureCollection", features: [feature] };
    if (!map.getSource("agos-selected-municipality")) {
      map.addSource("agos-selected-municipality", { type: "geojson", data });
      map.addLayer({
        id: "agos-selected-municipality-halo", type: "circle", source: "agos-selected-municipality",
        paint: { "circle-radius": 17, "circle-color": "#38bdf8", "circle-opacity": 0.22,
          "circle-stroke-color": "#e0f2fe", "circle-stroke-width": 2 }
      });
      map.addLayer({
        id: "agos-selected-municipality-dot", type: "circle", source: "agos-selected-municipality",
        paint: { "circle-radius": 6, "circle-color": "#0284c7", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 }
      });
      map.addLayer({
        id: "agos-selected-municipality-label", type: "symbol", source: "agos-selected-municipality",
        layout: { "text-field": ["get", "name"], "text-size": 13, "text-offset": [0, 1.5], "text-font": ["Open Sans Bold"] },
        paint: { "text-color": "#0c4a6e", "text-halo-color": "#ffffff", "text-halo-width": 1.8 }
      });
    } else {
      map.getSource("agos-selected-municipality").setData(data);
    }
    ["agos-selected-municipality-halo", "agos-selected-municipality-dot", "agos-selected-municipality-label"].forEach(id => setLayerVisibility(id, true));
  }

  async function loadMunicipalityWeather(municipality) {
    ATMOSPHERE.status = `Loading ${municipality.name} weather…`;
    updateAtmosphereStatus();
    const [lon, lat] = municipality.coordinates;
    const url = `${ATMOSPHERE.weatherEndpoint}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=temperature_2m,relative_humidity_2m,is_day,precipitation,rain,showers,weather_code,wind_speed_10m&timezone=Asia%2FManila`;
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-cache" });
      if (!response.ok) throw new Error(`Weather request failed (${response.status})`);
      const payload = await response.json();
      if (!payload.current) throw new Error("Current weather data was not returned.");
      if (ATMOSPHERE.selected?.name !== municipality.name) return;
      ATMOSPHERE.weather = payload.current;
      ATMOSPHERE.weatherDescription = describeWeatherCode(Number(payload.current.weather_code));
      ATMOSPHERE.status = `${ATMOSPHERE.weatherDescription} · ${payload.current.temperature_2m ?? "—"}°C · updated ${payload.current.time ?? "recently"}`;
      updateAtmosphereStatus();
      updateAtmosphereVisibility();
      if (MUNICIPALITY_PANEL.currentKind === "municipality" &&
          MUNICIPALITY_PANEL.currentRecord?.name === municipality.name) {
        showMunicipalityPanel(municipality);
      }
    } catch (error) {
      console.warn("AGOS local weather request failed:", error);
      ATMOSPHERE.weather = null;
      ATMOSPHERE.status = `Weather unavailable for ${municipality.name}. Effects remain off until data loads.`;
      updateAtmosphereStatus();
      updateAtmosphereVisibility();
      if (MUNICIPALITY_PANEL.currentKind === "municipality" &&
          MUNICIPALITY_PANEL.currentRecord?.name === municipality.name) {
        showMunicipalityPanel(municipality);
      }
    }
  }

  function describeWeatherCode(code) {
    if (code === 0) return "Clear";
    if ([1, 2].includes(code)) return "Mostly clear / partly cloudy";
    if (code === 3) return "Overcast";
    if ([45, 48].includes(code)) return "Foggy";
    if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle";
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Rain";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
    if ([95, 96, 99].includes(code)) return "Thunderstorm";
    return "Current conditions";
  }

  function updateAtmosphereStatus() {
    const status = byId("agos-local-weather-status");
    if (status) status.textContent = ATMOSPHERE.status;
  }

  // Homemade canvas clouds/rain/stars were removed because they looked
  // artificial and were not real imagery. Weather conditions remain in the
  // municipality information panel; precipitation is shown only by the
  // separate WeatherAPI tile overlay when the user enables it.
  function createAtmosphereCanvas() {
    // Intentionally no canvas overlay. Do not fabricate weather visuals.
  }

  function resizeAtmosphereCanvas() {
    // No atmosphere canvas is used.
  }

  function updateAtmosphereVisibility() {
    if (ATMOSPHERE.canvas) {
      ATMOSPHERE.canvas.style.display = "none";
      ATMOSPHERE.canvas.style.opacity = "0";
    }
    ATMOSPHERE.visibleAmount = 0;
    ATMOSPHERE.active = false;
  }

  function animateAtmosphere() {
    // Disabled: no synthetic clouds, rain streaks, stars, or sunlight.
  }

  function startAtmosphereWeatherRefresh() {
    if (ATMOSPHERE.timer) clearInterval(ATMOSPHERE.timer);
    ATMOSPHERE.timer = setInterval(() => {
      if (ATMOSPHERE.selected) loadMunicipalityWeather(ATMOSPHERE.selected);
    }, ATMOSPHERE.refreshMs);
  }

  function destroyAtmosphere() {
    if (ATMOSPHERE.timer) clearInterval(ATMOSPHERE.timer);
    if (ATMOSPHERE.frame) cancelAnimationFrame(ATMOSPHERE.frame);
    ATMOSPHERE.timer = null;
    ATMOSPHERE.frame = null;
    ATMOSPHERE.canvas?.remove();
    ATMOSPHERE.panel?.remove();
    ATMOSPHERE.canvas = null;
    ATMOSPHERE.panel = null;
    ATMOSPHERE.context = null;
    ATMOSPHERE.selected = null;
    ATMOSPHERE.weather = null;
  }

  // ------------------------------------------------------------
  // 18B. END MUNICIPALITY + ATMOSPHERE FEATURES
  // ------------------------------------------------------------


  // ------------------------------------------------------------
  // 18C. CLICKABLE MUNICIPALITY MARKERS + INFORMATION PANEL
  // ------------------------------------------------------------

  const MUNICIPALITY_PANEL = {
    element: null,
    currentKind: null,
    currentRecord: null
  };

  function ensureInfoPanel() {
    if (MUNICIPALITY_PANEL.element) return MUNICIPALITY_PANEL.element;

    const panel = document.createElement("aside");
    panel.id = "agos-feature-panel";
    panel.setAttribute("aria-label", "Selected map feature details");
    Object.assign(panel.style, {
      position: "absolute",
      left: "12px",
      bottom: "18px",
      zIndex: "8",
      width: "330px",
      maxWidth: "calc(100% - 24px)",
      maxHeight: "min(58vh, 520px)",
      overflowY: "auto",
      boxSizing: "border-box",
      padding: "14px",
      borderRadius: "12px",
      background: "rgba(13,31,48,.97)",
      color: "#f8fafc",
      font: "12px/1.55 system-ui,sans-serif",
      boxShadow: "0 5px 20px rgba(0,0,0,.3)",
      display: "none"
    });
    panel.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:10px;justify-content:space-between">
        <div id="agos-feature-panel-content" style="min-width:0;flex:1"></div>
        <button id="agos-feature-panel-close" type="button" aria-label="Close details"
          style="flex:0 0 auto;border:0;border-radius:6px;padding:4px 8px;background:#334155;color:#fff;cursor:pointer">✕</button>
      </div>`;
    map.getCanvasContainer().appendChild(panel);
    panel.querySelector("#agos-feature-panel-close").addEventListener("click", () => {
      panel.style.display = "none";
    });
    MUNICIPALITY_PANEL.element = panel;
    return panel;
  }

  function showInfoPanel(kind, record, html) {
    const panel = ensureInfoPanel();
    MUNICIPALITY_PANEL.currentKind = kind;
    MUNICIPALITY_PANEL.currentRecord = record;
    panel.querySelector("#agos-feature-panel-content").innerHTML = html;
    panel.style.display = "block";
  }

  function displayValue(value) {
    return value === null || value === undefined || value === ""
      ? "Not available in dataset"
      : escapeHTML(value);
  }

  function buildMunicipalityMarkerData() {
    return {
      type: "FeatureCollection",
      features: MUNICIPALITIES.map((municipality, index) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: municipality.coordinates
        },
        properties: {
          name: municipality.name,
          index
        }
      }))
    };
  }

  function addMunicipalityMarkers() {
    const data = buildMunicipalityMarkerData();
    addGeoJSONSource(ids.municipalityMarkersSource, data);

    addIfMissing({
      id: "agos-municipality-marker-circles",
      type: "circle",
      source: ids.municipalityMarkersSource,
      paint: {
        "circle-radius": [
          "case",
          ["==", ["get", "name"], ATMOSPHERE.selected?.name || ""], 9,
          6
        ],
        "circle-color": [
          "case",
          ["==", ["get", "name"], ATMOSPHERE.selected?.name || ""], "#0284c7",
          "#f8fafc"
        ],
        "circle-stroke-color": [
          "case",
          ["==", ["get", "name"], ATMOSPHERE.selected?.name || ""], "#bae6fd",
          "#0f766e"
        ],
        "circle-stroke-width": 2.5
      }
    });

    addIfMissing({
      id: "agos-municipality-marker-labels",
      type: "symbol",
      source: ids.municipalityMarkersSource,
      layout: {
        "text-field": ["get", "name"],
        "text-size": 11,
        "text-offset": [0, 1.25],
        "text-font": ["Open Sans Bold"],
        "text-allow-overlap": false
      },
      paint: {
        "text-color": "#0f3b4a",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.5
      }
    });

    setVisibilityGroup(
      ["agos-municipality-marker-circles", "agos-municipality-marker-labels"],
      visibility.municipalities
    );

    ["agos-municipality-marker-circles", "agos-municipality-marker-labels"].forEach(layerId => {
      map.on("click", layerId, event => {
        const feature = event.features?.[0];
        const name = feature?.properties?.name;
        if (name) selectMunicipalityFromMarker(name);
      });
      map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
    });
  }

  function refreshMunicipalityMarkerStyle() {
    if (!map || !map.getLayer("agos-municipality-marker-circles")) return;
    map.setPaintProperty("agos-municipality-marker-circles", "circle-radius", [
      "case", ["==", ["get", "name"], ATMOSPHERE.selected?.name || ""], 9, 6
    ]);
    map.setPaintProperty("agos-municipality-marker-circles", "circle-color", [
      "case", ["==", ["get", "name"], ATMOSPHERE.selected?.name || ""], "#0284c7", "#f8fafc"
    ]);
    map.setPaintProperty("agos-municipality-marker-circles", "circle-stroke-color", [
      "case", ["==", ["get", "name"], ATMOSPHERE.selected?.name || ""], "#bae6fd", "#0f766e"
    ]);
  }

  function showMunicipalityPanel(municipality) {
    const weather = ATMOSPHERE.weather;
    const weatherDescription = weather
      ? describeWeatherCode(Number(weather.weather_code))
      : "Weather not loaded";
    const weatherRows = weather ? `
      <div style="margin-top:10px;padding:10px;border-radius:8px;background:rgba(30,64,85,.65)">
        <div style="font-weight:700;font-size:13px;margin-bottom:6px">Current weather</div>
        <div><strong>Conditions:</strong> ${escapeHTML(weatherDescription)}</div>
        <div><strong>Temperature:</strong> ${displayValue(weather.temperature_2m)}${weather.temperature_2m == null ? "" : " °C"}</div>
        <div><strong>Humidity:</strong> ${displayValue(weather.relative_humidity_2m)}${weather.relative_humidity_2m == null ? "" : "%"}</div>
        <div><strong>Rain:</strong> ${displayValue(weather.precipitation)}${weather.precipitation == null ? "" : " mm"}</div>
        <div><strong>Wind:</strong> ${displayValue(weather.wind_speed_10m)}${weather.wind_speed_10m == null ? "" : " km/h"}</div>
        <div style="color:#cbd5e1;font-size:10px;margin-top:5px">Open-Meteo · ${displayValue(weather.time)}</div>
      </div>` : `
      <div style="margin-top:10px;padding:10px;border-radius:8px;background:rgba(30,64,85,.65)">
        <div style="font-weight:700;font-size:13px">Current weather</div>
        <div>${escapeHTML(ATMOSPHERE.status)}</div>
      </div>`;
    const rainfallRow = stormAssessmentData?.rows?.find(row =>
      normalizeMunicipalityKey(row.name) === normalizeMunicipalityKey(municipality.name) ||
      (normalizeMunicipalityKey(municipality.name) === "balanga" && normalizeMunicipalityKey(row.name) === "balangacity")
    );
    const rainfallCategory = rainfallRow ? stormRainfallLabel(rainfallRow.mm) : null;
    const rainfallAmount = rainfallRow?.mm == null ? "Not available" : `${Number(rainfallRow.mm).toFixed(1)} mm`;
    const rainfallRecord = rainfallRow?.record;
    const rainfallPoints = Array.isArray(rainfallRecord?.points) ? rainfallRecord.points : [];
    const rainfallTimeline = rainfallPoints.slice(0, 6).map(point => {
      const time = point?.time ? String(point.time).replace("T", " ").slice(0, 16) : "Forecast hour";
      const value = point?.precipitation_mm ?? point?.rain_mm;
      return `<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px solid rgba(148,163,184,.12)"><span>${escapeHTML(time)}</span><strong>${value == null ? "—" : `${Number(value).toFixed(1)} mm`}</strong></div>`;
    }).join("");
    const floodAssessment = getMunicipalityFloodAssessment(municipality, rainfallRow);
    const assessmentColor = rainfallCategory?.color || "#cbd5e1";
    const monitoringSummary = `
      <div style="margin-top:10px;padding:10px;border:1px solid rgba(148,163,184,.35);border-radius:8px;background:rgba(30,64,85,.65)">
        <strong style="font-size:13px;color:#f8fafc">Flood risk information</strong>
        <div style="margin-top:8px;font-size:10px;color:#cbd5e1">Baseline susceptibility</div>
        <div style="font-size:14px;font-weight:800;color:#fde68a;margin-top:2px">MGB raster shown on map</div>
        <div style="font-size:10px;line-height:1.4;color:#cbd5e1;margin-top:4px">AGOS does not currently extract a municipality-level susceptibility value from the raster, so no combined score is calculated.</div>
        <div style="height:1px;background:rgba(148,163,184,.25);margin:9px 0"></div>
        <div style="font-size:10px;color:#cbd5e1">Forecast-based outlook · ${escapeHTML(String(floodAssessment.periodHours))}-hour forecast</div>
        <div style="font-size:14px;font-weight:800;color:${assessmentColor};margin-top:3px">${escapeHTML(floodAssessment.outlookLabel)}</div>
        ${floodAssessment.rainfallMm != null ? `<div style="font-size:10px;color:#cbd5e1;margin-top:4px">Forecast rainfall: ${floodAssessment.rainfallMm.toFixed(1)} mm</div>` : `<div style="font-size:10px;color:#cbd5e1;margin-top:4px">Forecast rainfall is unavailable for this municipality.</div>`}
        <div style="font-size:10px;line-height:1.4;color:#e2e8f0;margin-top:7px">${escapeHTML(floodAssessment.explanation)}</div>
      </div>`;
    const outlookRows = `
      <div style="margin-top:10px;padding:10px;border-radius:8px;background:rgba(30,64,85,.65)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px">
          <strong style="font-size:13px">Rainfall outlook</strong>
          <button id="agos-municipality-rainfall-refresh" type="button" style="border:1px solid #64748b;border-radius:6px;padding:3px 7px;background:#1e293b;color:#f8fafc;cursor:pointer;font-size:10px">Refresh</button>
        </div>
        <div style="font-size:10px;color:#cbd5e1;margin-bottom:6px">Open-Meteo · ${escapeHTML(rainfallRecord?.accumulation_period_hours ? `${rainfallRecord.accumulation_period_hours}-hour forecast` : "forecast accumulation")}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><span>Forecast accumulation</span><strong style="font-size:16px;color:${rainfallCategory?.color || "#cbd5e1"}">${escapeHTML(rainfallAmount)}</strong></div>
        <div style="font-size:10px;color:${rainfallCategory?.color || "#cbd5e1"};margin-top:3px">${escapeHTML(rainfallCategory?.label || (stormAssessmentLoading ? "Loading forecast…" : "Forecast unavailable"))}</div>
        ${rainfallTimeline ? `<div style="margin-top:7px;font-size:10px;color:#cbd5e1">Hourly forecast samples</div><div style="font-size:10px;margin-top:3px">${rainfallTimeline}</div>` : ""}
        <div style="font-size:10px;color:#cbd5e1;margin-top:7px">Forecast rainfall at a municipality reference point—not measured flood depth, confirmed flooding, or an official warning.</div>
      </div>`;
    showInfoPanel("municipality", municipality, `
      <div style="font-size:10px;letter-spacing:.08em;color:#7dd3fc;text-transform:uppercase">Municipality intelligence</div>
      <h3 style="font-size:18px;line-height:1.25;margin:3px 0 0">${escapeHTML(municipality.name)}</h3>
      ${weatherRows}
      ${monitoringSummary}
      ${outlookRows}
      <div style="font-size:10px;color:#cbd5e1;margin-top:8px">Marker coordinates are municipality reference points, not official boundaries or evacuation locations.</div>
    `);
    byId("agos-municipality-rainfall-refresh")?.addEventListener("click", () => refreshStormAssessment(true));
  }

  function selectMunicipalityFromMarker(name) {
    const municipality = MUNICIPALITIES.find(item => item.name.toLowerCase() === String(name).toLowerCase());
    if (!municipality) return;
    ATMOSPHERE.selected = municipality;
    const select = byId("agos-municipality-select");
    if (select) select.value = String(MUNICIPALITIES.indexOf(municipality));
    map.flyTo({ center: municipality.coordinates, zoom: 12, duration: 1200, essential: true });
    refreshMunicipalityMarkerStyle();
    showSelectedMunicipalityMarker(municipality);
    showMunicipalityPanel(municipality);
    loadMunicipalityWeather(municipality);
    updateAtmosphereVisibility();
  }

  function showSelectedMunicipalityMarker(municipality) {
    // Keep the selected marker source for compatibility with the earlier feature.
    const data = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: municipality.coordinates },
        properties: { name: municipality.name }
      }]
    };
    if (!map.getSource("agos-selected-municipality")) {
      map.addSource("agos-selected-municipality", { type: "geojson", data });
      map.addLayer({
        id: "agos-selected-municipality-halo", type: "circle", source: "agos-selected-municipality",
        paint: { "circle-radius": 17, "circle-color": "#38bdf8", "circle-opacity": 0.22,
          "circle-stroke-color": "#e0f2fe", "circle-stroke-width": 2 }
      });
      map.addLayer({
        id: "agos-selected-municipality-dot", type: "circle", source: "agos-selected-municipality",
        paint: { "circle-radius": 6, "circle-color": "#0284c7", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 }
      });
    } else {
      map.getSource("agos-selected-municipality").setData(data);
    }
    ["agos-selected-municipality-halo", "agos-selected-municipality-dot"].forEach(id => setLayerVisibility(id, true));
  }

  function showEvacuationCenterPanel(feature, lngLat) {
    const p = feature.properties || {};
    showInfoPanel("evacuation-center", p, `
      <div style="font-size:10px;letter-spacing:.08em;color:#86efac;text-transform:uppercase">Evacuation facility</div>
      <h3 style="font-size:17px;line-height:1.25;margin:3px 0 8px">${displayValue(p.name)}</h3>
      <div><strong>Municipality:</strong> ${displayValue(p.municipality)}</div>
      <div><strong>Barangay:</strong> ${displayValue(p.barangay)}</div>
      <div><strong>Type:</strong> ${displayValue(p.type)}</div>
      <div><strong>Dataset status:</strong> ${displayValue(p.status)}</div>
      <div><strong>Capacity (families):</strong> ${displayValue(p.capacity_families)}</div>
      <div><strong>Latitude:</strong> ${displayValue(p.latitude ?? lngLat?.lat)}</div>
      <div><strong>Longitude:</strong> ${displayValue(p.longitude ?? lngLat?.lng)}</div>
      <div><strong>Plus code:</strong> ${displayValue(p.plus_code)}</div>
      <div><strong>Coordinates verified:</strong> ${p.verified_coordinates === true ? "Yes" : "No"}</div>
      <div><strong>Source:</strong> ${displayValue(p.source)}</div>
      <div><strong>Source date:</strong> ${displayValue(p.source_date)}</div>
      <div style="margin-top:9px;padding:8px;border-radius:7px;background:rgba(127,29,29,.22);color:#fecaca">
        A mapped location or source status does not confirm current operation, available space, or emergency capacity. Contact local authorities before relying on this facility.
      </div>
    `);
  }

  // ------------------------------------------------------------
  // 19. STARTUP
  // ------------------------------------------------------------

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      initializeMap,
      { once: true }
    );
  } else {
    initializeMap();
  }
})();
