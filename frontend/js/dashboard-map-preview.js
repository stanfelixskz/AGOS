
/*
 * AGOS — Dashboard Map Preview
 * NEW FILE: frontend/js/dashboard-map-preview.js
 *
 * Requirements:
 * - MapLibre GL JS loaded in index.html
 * - Existing frontend/js/map.js exposes AGOSMap.getLoadedData()
 * - Dashboard contains <div id="dashboardMapPreview"></div>
 *
 * This module:
 * - Creates a separate interactive preview map
 * - Reuses existing AGOS GeoJSON data
 * - Recenters when the selected municipality changes
 * - Displays flood evidence, candidate zones, and evacuation centers
 * - Does not create or fabricate flood data
 */

(() => {
  "use strict";

  const CONFIG = {
    containerId: "dashboardMapPreview",
    initialCenter: [120.45, 14.62],
    initialZoom: 8.4,
    municipalityZoom: 10.2
  };

  // Camera centers are used for navigation only, not as flood observations.
  const MUNICIPALITY_CENTERS = {
    Balanga: [120.5363, 14.6760],
    Abucay: [120.5333, 14.7222],
    Bagac: [120.5431, 14.5967],
    Dinalupihan: [120.4628, 14.8783],
    Hermosa: [120.5072, 14.8314],
    Limay: [120.5983, 14.5619],
    Mariveles: [120.4850, 14.4333],
    Morong: [120.2708, 14.6781],
    Orani: [120.5361, 14.8000],
    Orion: [120.5375, 14.6208],
    Pilar: [120.5653, 14.6653],
    Samal: [120.5436, 14.7678]
  };

  const SOURCES = {
    boundary: "agos-preview-boundary",
    candidates: "agos-preview-candidates",
    evidence: "agos-preview-evidence",
    centers: "agos-preview-centers"
  };

  const LAYERS = {
    boundaryFill: "agos-preview-boundary-fill",
    boundaryLine: "agos-preview-boundary-line",
    candidatesFill: "agos-preview-candidates-fill",
    candidatesLine: "agos-preview-candidates-line",
    evidencePoints: "agos-preview-evidence-points",
    centersPoints: "agos-preview-centers-points"
  };

  let map = null;
  let started = false;
  let retries = 0;
  let resizeObserver = null;
  let currentMunicipality = "Balanga";
  let retryTimer = null;

  const EMPTY = () => ({
    type: "FeatureCollection",
    features: []
  });

  function log(...args) {
    console.info("[AGOS Preview]", ...args);
  }

  function warn(...args) {
    console.warn("[AGOS Preview]", ...args);
  }

  function getContainer() {
    return document.getElementById(CONFIG.containerId);
  }

  function getMapAPI() {
    return window.AGOSMap &&
      typeof window.AGOSMap.getLoadedData === "function"
      ? window.AGOSMap
      : null;
  }

  function getLoadedData() {
    const api = getMapAPI();

    if (!api) return {};

    try {
      return api.getLoadedData() || {};
    } catch (error) {
      warn("Unable to read loaded map data.", error);
      return {};
    }
  }

  function asFeatureCollection(value) {
    if (
      value &&
      value.type === "FeatureCollection" &&
      Array.isArray(value.features)
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      return {
        type: "FeatureCollection",
        features: value.filter(
          (feature) => feature && feature.type === "Feature"
        )
      };
    }

    return EMPTY();
  }

  function findCollection(data, keys) {
    for (const key of keys) {
      if (data && data[key] != null) {
        return asFeatureCollection(data[key]);
      }
    }

    return EMPTY();
  }

  function getBoundary(data) {
    return findCollection(data, [
      "provinceBoundary",
      "bataanProvinceBoundary",
      "boundary",
      "municipalities"
    ]);
  }

  function getCandidates(data) {
    return findCollection(data, [
      "candidateZones",
      "floodCandidateZones",
      "riskZones"
    ]);
  }

  function getEvidence(data) {
    return findCollection(data, [
      "floodEvidence",
      "floodEvidenceResults",
      "evidenceCases",
      "floodObservations",
      "evidenceHeatmap"
    ]);
  }

  function getCenters(data) {
    return findCollection(data, [
      "evacuationCenters",
      "centers",
      "evacuation"
    ]);
  }

  function addGeoJsonSource(sourceId) {
    if (map.getSource(sourceId)) return;

    map.addSource(sourceId, {
      type: "geojson",
      data: EMPTY()
    });
  }

  function addPreviewLayers() {
    if (!map) return;

    addGeoJsonSource(SOURCES.boundary);
    addGeoJsonSource(SOURCES.candidates);
    addGeoJsonSource(SOURCES.evidence);
    addGeoJsonSource(SOURCES.centers);

    if (!map.getLayer(LAYERS.boundaryFill)) {
      map.addLayer({
        id: LAYERS.boundaryFill,
        type: "fill",
        source: SOURCES.boundary,
        filter: [
          "in",
          ["geometry-type"],
          ["literal", ["Polygon", "MultiPolygon"]]
        ],
        paint: {
          "fill-color": "#36b9d8",
          "fill-opacity": 0.04
        }
      });
    }

    if (!map.getLayer(LAYERS.boundaryLine)) {
      map.addLayer({
        id: LAYERS.boundaryLine,
        type: "line",
        source: SOURCES.boundary,
        paint: {
          "line-color": "#62d5ec",
          "line-width": 1.5,
          "line-opacity": 0.85
        }
      });
    }

    if (!map.getLayer(LAYERS.candidatesFill)) {
      map.addLayer({
        id: LAYERS.candidatesFill,
        type: "fill",
        source: SOURCES.candidates,
        paint: {
          "fill-color": [
            "match",
            [
              "downcase",
              [
                "to-string",
                [
                  "coalesce",
                  ["get", "risk_level"],
                  ["get", "risk"],
                  ["get", "risk_class"],
                  ""
                ]
              ]
            ],
            "high", "#f16e78",
            "severe", "#f16e78",
            "critical", "#f16e78",
            "medium", "#f2b95c",
            "moderate", "#f2b95c",
            "low", "#45c995",
            "#a3b1c2"
          ],
          "fill-opacity": 0.24
        }
      });
    }

    if (!map.getLayer(LAYERS.candidatesLine)) {
      map.addLayer({
        id: LAYERS.candidatesLine,
        type: "line",
        source: SOURCES.candidates,
        paint: {
          "line-color": [
            "match",
            [
              "downcase",
              [
                "to-string",
                [
                  "coalesce",
                  ["get", "risk_level"],
                  ["get", "risk"],
                  ["get", "risk_class"],
                  ""
                ]
              ]
            ],
            "high", "#f16e78",
            "severe", "#f16e78",
            "critical", "#f16e78",
            "medium", "#f2b95c",
            "moderate", "#f2b95c",
            "low", "#45c995",
            "#a3b1c2"
          ],
          "line-width": 1.3
        }
      });
    }

    if (!map.getLayer(LAYERS.evidencePoints)) {
      map.addLayer({
        id: LAYERS.evidencePoints,
        type: "circle",
        source: SOURCES.evidence,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6, 3,
            11, 5,
            15, 7
          ],
          "circle-color": "#f16e78",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
          "circle-opacity": 0.92
        }
      });
    }

    if (!map.getLayer(LAYERS.centersPoints)) {
      map.addLayer({
        id: LAYERS.centersPoints,
        type: "circle",
        source: SOURCES.centers,
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6, 3,
            11, 5,
            15, 7
          ],
          "circle-color": "#36b9d8",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.2
        }
      });
    }

    bindPopup(LAYERS.evidencePoints, "evidence");
    bindPopup(LAYERS.centersPoints, "center");
    bindPopup(LAYERS.candidatesFill, "candidate");
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function formatLabel(value) {
    return String(value)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function popupTitle(properties, type) {
    if (type === "evidence") {
      return properties.name ||
        properties.id ||
        properties.report_id ||
        "Flood evidence";
    }

    if (type === "center") {
      return properties.name ||
        properties.center_name ||
        properties.facility_name ||
        "Evacuation center";
    }

    return properties.name ||
      properties.zone_name ||
      properties.id ||
      "Candidate flood zone";
  }

  function bindPopup(layerId, type) {
    if (!map || !map.getLayer(layerId)) return;

    map.on("click", layerId, (event) => {
      const feature = event.features?.[0];

      if (!feature) return;

      const properties = feature.properties || {};
      const title = popupTitle(properties, type);
      const detailRows = [];

      for (const [key, value] of Object.entries(properties)) {
        if (
          value == null ||
          value === "" ||
          ["name", "center_name", "facility_name", "zone_name"].includes(key)
        ) {
          continue;
        }

        detailRows.push(`
          <div class="agos-preview-popup-row">
            <span>${escapeHtml(formatLabel(key))}</span>
            <strong>${escapeHtml(value)}</strong>
          </div>
        `);

        if (detailRows.length >= 5) break;
      }

      const note = type === "candidate"
        ? '<p class="agos-preview-popup-note">Candidate zone only; not a confirmed flood extent.</p>'
        : "";

      const html = `
        <div class="agos-preview-popup">
          <strong>${escapeHtml(title)}</strong>
          ${detailRows.join("")}
          ${note}
        </div>
      `;

      new window.maplibregl.Popup({
        closeButton: true,
        closeOnClick: true,
        maxWidth: "270px"
      })
        .setLngLat(event.lngLat)
        .setHTML(html)
        .addTo(map);
    });

    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });

    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
  }

  function updateSource(sourceId, collection) {
    if (!map) return;

    const source = map.getSource(sourceId);

    if (source && typeof source.setData === "function") {
      source.setData(asFeatureCollection(collection));
    }
  }

  function updateStatus(data) {
    const container = getContainer();

    if (!container) return;

    const status = container.querySelector("[data-preview-status]");
    if (!status) return;

    const evidenceCount = getEvidence(data).features.length;
    const candidateCount = getCandidates(data).features.length;
    const centerCount = getCenters(data).features.length;

    if (evidenceCount + candidateCount + centerCount === 0) {
      status.textContent = "Waiting for AGOS map datasets…";
      return;
    }

    status.textContent =
      `${evidenceCount} evidence · ` +
      `${candidateCount} candidate zones · ` +
      `${centerCount} centers`;
  }

  function refreshData() {
    if (!map || !map.isStyleLoaded()) return;

    const data = getLoadedData();

    updateSource(SOURCES.boundary, getBoundary(data));
    updateSource(SOURCES.candidates, getCandidates(data));
    updateSource(SOURCES.evidence, getEvidence(data));
    updateSource(SOURCES.centers, getCenters(data));

    updateStatus(data);
  }

  function centerOnMunicipality(name, animate = true) {
    if (!map) return;

    const municipality = MUNICIPALITY_CENTERS[name]
      ? name
      : "Balanga";

    currentMunicipality = municipality;

    const center = MUNICIPALITY_CENTERS[municipality];

    if (animate) {
      map.easeTo({
        center,
        zoom: CONFIG.municipalityZoom,
        duration: 650,
        essential: true
      });
    } else {
      map.jumpTo({
        center,
        zoom: CONFIG.municipalityZoom
      });
    }

    const label = getContainer()?.querySelector(
      "[data-preview-municipality]"
    );

    if (label) {
      label.textContent = municipality;
    }
  }

  function addMapControls() {
    map.addControl(
      new window.maplibregl.NavigationControl({
        showCompass: false,
        visualizePitch: false
      }),
      "top-right"
    );

    map.addControl(
      new window.maplibregl.ScaleControl({
        maxWidth: 100,
        unit: "metric"
      }),
      "bottom-left"
    );
  }

  function ensurePreviewStatus() {
    const container = getContainer();

    if (!container) return;

    let status = container.querySelector("[data-preview-status]");

    if (!status) {
      status = document.createElement("div");
      status.className = "agos-preview-status";
      status.setAttribute("data-preview-status", "");
      status.textContent = "Loading map data…";
      container.appendChild(status);
    }

    let municipalityLabel = container.querySelector(
      "[data-preview-municipality]"
    );

    if (!municipalityLabel) {
      municipalityLabel = document.createElement("span");
      municipalityLabel.className = "agos-preview-municipality";
      municipalityLabel.setAttribute("data-preview-municipality", "");
      municipalityLabel.textContent = currentMunicipality;
      container.appendChild(municipalityLabel);
    }
  }

  function installResizeObserver() {
    const container = getContainer();

    if (!container || !window.ResizeObserver) return;

    resizeObserver = new ResizeObserver(() => {
      if (!map) return;

      if (resizeTimer !== null) {
        window.clearTimeout(resizeTimer);
      }

      resizeTimer = window.setTimeout(() => {
        map?.resize();
      }, 80);
    });

    resizeObserver.observe(container);
  }

  function initialize() {
    if (started) return;

    const container = getContainer();

    if (!container) {
      warn(
        `Missing #${CONFIG.containerId}. Add the preview container to index.html.`
      );
      return;
    }

    if (!window.maplibregl) {
      warn("MapLibre GL JS is not loaded yet.");
      return;
    }

    if (!getMapAPI()) {
      if (retries >= 30) {
        warn("AGOSMap.getLoadedData() was not available after retries.");
        return;
      }

      retries += 1;

      retryTimer = window.setTimeout(initialize, 400);
      return;
    }

    started = true;
    currentMunicipality = getSelectedMunicipality();

    ensurePreviewStatus();

    try {
      map = new window.maplibregl.Map({
        container,
        style: CONFIG.style,
        center: CONFIG.initialCenter,
        zoom: CONFIG.initialZoom,
        minZoom: 6,
        maxZoom: 16,
        attributionControl: true,
        cooperativeGestures: true
      });

      map.addControl(
        new window.maplibregl.AttributionControl({
          compact: true
        }),
        "bottom-right"
      );

      map.on("load", () => {
        addPreviewLayers();
        addMapControls();
        refreshData();
        centerOnMunicipality(currentMunicipality, false);
        installResizeObserver();

        log("Map preview initialized.");
      });

      map.on("error", (event) => {
        if (event?.error) {
          warn("MapLibre preview error:", event.error.message || event.error);
        }
      });

      /*
       * The dashboard map is a separate MapLibre instance.
       * It never moves or replaces the full map's DOM element.
       */
      window.AGOSDashboardMapPreview = {
        getMap: () => map,

        setMunicipality(name) {
          centerOnMunicipality(name, true);
        },

        refreshData,

        resize() {
          map?.resize();
        },

        getMunicipality() {
          return currentMunicipality;
        },

        destroy() {
          if (retryTimer !== null) {
            window.clearTimeout(retryTimer);
            retryTimer = null;
          }

          if (resizeTimer !== null) {
            window.clearTimeout(resizeTimer);
            resizeTimer = null;
          }

          if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
          }

          if (map) {
            map.remove();
            map = null;
          }

          started = false;
        }
      };
    } catch (error) {
      started = false;
      warn("Failed to initialize map preview.", error);
    }
  }

  /*
   * Listen for data refreshes from the existing map module.
   * Multiple event names are supported because AGOS modules may
   * dispatch different readiness/update events.
   */
  function setupEvents() {
    const refreshEvents = [
      "agos:data-ready",
      "agos:data-updated",
      "agos:map-ready",
      "agos:map-data-loaded"
    ];

    refreshEvents.forEach((eventName) => {
      document.addEventListener(eventName, () => {
        refreshData();
      });
    });

    document.addEventListener("agos:municipality-change", (event) => {
      const name = event.detail?.municipality;

      if (name) {
        centerOnMunicipality(name, true);
      }
    });

    document.addEventListener("agos:viewchange", (event) => {
      if (event.detail?.view === "dashboard") {
        window.setTimeout(() => {
          map?.resize();
          refreshData();
        }, 100);
      }
    });

    const selector = document.getElementById("municipalitySelect");

    selector?.addEventListener("change", () => {
      centerOnMunicipality(selector.value, true);
    });
  }

  function start() {
    setupEvents();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initialize, {
        once: true
      });
    } else {
      initialize();
    }
  }

  start();
})();
