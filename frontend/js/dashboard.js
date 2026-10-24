
/*
 * AGOS — Dashboard and Forecast Integration
 * Complete replacement for frontend/js/dashboard.js
 *
 * Fixes:
 * - Reads map datasets through AGOSMap.getLoadedData()
 * - Loads weather for the selected municipality
 * - Requests forecasts for the selected municipality
 * - Prevents older requests overwriting newer selections
 * - Uses Asia/Manila time for forecast date and hour
 * - Removes duplicate navigation handlers
 * - Removes unnecessary 5-second metric polling
 * - Keeps forecast values separate from flood observations
 *
 * Data source:
 * - AGOS FastAPI backend
 * - Existing AGOSMap GeoJSON data
 *
 * IMPORTANT:
 * This file does not manufacture flood observations or weather values.
 */

(() => {
  "use strict";

  const API_BASE = "http://127.0.0.1:8000";
  const TIME_ZONE = "Asia/Manila";
  const WEATHER_REFRESH_MS = 5 * 60 * 1000;

  const $ = (id) => document.getElementById(id);

  const safeArray = (value) =>
    Array.isArray(value) ? value : [];

  const fmt = (value, digits = 1) => {
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      !Number.isFinite(Number(value))
    ) {
      return "—";
    }

    return Number(value).toFixed(digits);
  };

  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (character) => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      };

      return entities[character];
    });

  let weatherRequestId = 0;
  let forecastRequestId = 0;
  let weatherTimer = null;
  let initialized = false;
  let latestWeather = null;
  let latestForecast = null;

  const state = {
    municipality: "Balanga",
    weatherLoaded: false,
    forecastLoaded: false,
    mapDataLoaded: false
  };

  /*
   * Municipality helpers
   */

  function getSelectedMunicipality() {
    const selector = $("municipalitySelect");
    const value = selector?.value?.trim();

    return value || state.municipality || "Balanga";
  }

  function getMunicipalityCoordinates() {
    /*
     * These coordinates are for map viewing only.
     * Actual forecast coordinates come from the backend's
     * municipality configuration.
     */
    const locations = {
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

    return locations[getSelectedMunicipality()] || locations.Balanga;
  }

  /*
   * Time helpers
   *
   * Avoid relying on the computer's configured timezone.
   */

  function getManilaDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);

    const result = {};

    for (const part of parts) {
      if (part.type !== "literal") {
        result[part.type] = part.value;
      }
    }

    return result;
  }

  function getManilaDateString(date = new Date()) {
    const parts = getManilaDateParts(date);

    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function getManilaHour(date = new Date()) {
    const hour = new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      hour: "2-digit",
      hourCycle: "h23"
    }).format(date);

    return Number(hour);
  }

  function formatDateTime(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return String(value);
    }

    return new Intl.DateTimeFormat("en-PH", {
      timeZone: TIME_ZONE,
      dateStyle: "medium",
      timeStyle: "short"
    }).format(date);
  }

  /*
   * Header and weather status
   */

  function setWeatherStatus(label, status = "loading") {
    const statusLabel = $("weatherStatus");
    const statusDot = $("weatherStatusDot");

    if (statusLabel) {
      statusLabel.textContent = label;
    }

    if (statusDot) {
      statusDot.classList.remove(
        "is-loading",
        "is-success",
        "is-error",
        "is-warning"
      );

      statusDot.classList.add(`is-${status}`);
      statusDot.setAttribute("aria-label", label);
    }
  }

  function setForecastStatus(message, status = "loading") {
    const element = $("forecastStatus");

    if (!element) return;

    element.textContent = message;
    element.dataset.status = status;
  }

  function weatherIcon(condition) {
    const text = String(condition || "").toLowerCase();

    if (text.includes("thunder")) return "⛈️";
    if (text.includes("storm")) return "⛈️";
    if (text.includes("snow")) return "🌨️";
    if (text.includes("sleet")) return "🌨️";
    if (text.includes("rain")) return "🌧️";
    if (text.includes("drizzle")) return "🌦️";
    if (text.includes("shower")) return "🌦️";
    if (text.includes("fog")) return "🌫️";
    if (text.includes("mist")) return "🌫️";
    if (text.includes("overcast")) return "☁️";
    if (text.includes("cloud")) return "⛅";
    if (text.includes("clear")) return "☀️";
    if (text.includes("sunny")) return "☀️";

    return "🌤️";
  }

  function renderWeather(data) {
    if (!data || typeof data !== "object") {
      throw new Error("The weather response is empty.");
    }

    /*
     * These aliases accommodate common response field names.
     * They do not create missing weather observations.
     */
    const temperature =
      data.temperature_c ??
      data.temperature ??
      data.temperature_2m;

    const condition =
      data.condition ??
      data.weather_description ??
      data.description ??
      "Current conditions";

    const rainfall =
      data.rainfall_mm ??
      data.rainfall ??
      data.precipitation_mm ??
      data.precipitation;

    const humidity =
      data.humidity_percent ??
      data.humidity ??
      data.relative_humidity_2m;

    const wind =
      data.wind_speed_kmh ??
      data.wind_speed ??
      data.wind_speed_10m;

    const icon = weatherIcon(condition);

    if ($("temperature")) {
      $("temperature").textContent =
        temperature == null ? "—" : `${fmt(temperature)}°`;
    }

    if ($("condition")) {
      $("condition").textContent = String(condition);
    }

    if ($("conditionSmall")) {
      $("conditionSmall").textContent = String(condition);
    }

    if ($("rainfallToday")) {
      $("rainfallToday").textContent =
        rainfall == null ? "—" : `${fmt(rainfall)} mm`;
    }

    if ($("humidity")) {
      $("humidity").textContent =
        humidity == null ? "—" : `${fmt(humidity, 0)}%`;
    }

    if ($("windSpeed")) {
      $("windSpeed").textContent =
        wind == null ? "—" : `${fmt(wind)} km/h`;
    }

    if ($("weatherIcon")) {
      $("weatherIcon").textContent = icon;
      $("weatherIcon").setAttribute("aria-label", String(condition));
    }

    const updatedAt =
      data.last_updated ??
      data.updated_at ??
      data.time ??
      data.observation_time;

    if ($("lastUpdated")) {
      $("lastUpdated").textContent = updatedAt
        ? formatDateTime(updatedAt)
        : "Timestamp unavailable";
    }

    if ($("weatherFreshness")) {
      $("weatherFreshness").textContent =
        data.is_live === false
          ? "Cached weather data"
          : "Latest available weather";
    }

    if ($("dashboardUpdated")) {
      $("dashboardUpdated").textContent = updatedAt
        ? `Weather updated ${formatDateTime(updatedAt)}`
        : "Weather timestamp unavailable";
    }

    latestWeather = data;
    state.weatherLoaded = true;
  }

  /*
   * Current weather
   */

  async function loadWeather() {
    const requestId = ++weatherRequestId;
    const municipality = getSelectedMunicipality();

    state.municipality = municipality;

    setWeatherStatus("Loading weather…", "loading");

    const query = new URLSearchParams({
      municipality
    });

    try {
      const response = await fetch(
        `${API_BASE}/weather?${query.toString()}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json"
          }
        }
      );

      if (!response.ok) {
        let detail = `Weather request failed (${response.status}).`;

        try {
          const body = await response.json();
          if (body?.detail) detail = body.detail;
        } catch {
          // Keep the HTTP error message.
        }

        throw new Error(detail);
      }

      const data = await response.json();

      /*
       * Ignore a response if the user changed municipalities
       * while the request was in progress.
       */
      if (requestId !== weatherRequestId) return;

      if (municipality !== getSelectedMunicipality()) return;

      renderWeather(data);
      setWeatherStatus("Weather available", "success");
    } catch (error) {
      if (requestId !== weatherRequestId) return;

      console.error("[AGOS Dashboard] Weather error:", error);

      setWeatherStatus("Weather unavailable", "error");

      if ($("weatherFreshness")) {
        $("weatherFreshness").textContent =
          "Could not retrieve current weather.";
      }

      if ($("dashboardUpdated")) {
        $("dashboardUpdated").textContent =
          `Weather request failed: ${error.message}`;
      }
    }
  }

  /*
   * Forecast controls
   */

  function populateForecastHours() {
    const hourSelect = $("forecastHour");

    if (!hourSelect) return;

    const previousValue = hourSelect.value;
    const existingOptions = Array.from(hourSelect.options);

    /*
     * Keep existing options if index.html already defines them.
     */
    if (existingOptions.length === 0) {
      for (let hour = 0; hour < 24; hour += 1) {
        const option = document.createElement("option");

        option.value = String(hour);
        option.textContent = `${String(hour).padStart(2, "0")}:00`;

        hourSelect.appendChild(option);
      }
    }

    const hourValues = Array.from(hourSelect.options).map(
      (option) => String(option.value)
    );

    if (hourValues.includes(previousValue)) {
      hourSelect.value = previousValue;
    } else {
      hourSelect.value = String(getManilaHour());
    }
  }

  function initializeForecastDate() {
    const dateInput = $("forecastDate");

    if (!dateInput) return;

    if (!dateInput.value) {
      dateInput.value = getManilaDateString();
    }

    /*
     * Open-Meteo supports forecasts for a limited future period.
     * Keep the date input from selecting a past date.
     */
    dateInput.min = getManilaDateString();
  }

  function getForecastVariable() {
    return $("forecastVariable")?.value || "precipitation";
  }

  function getForecastDate() {
    return $("forecastDate")?.value || getManilaDateString();
  }

  function getForecastHour() {
    const value = Number($("forecastHour")?.value ?? getManilaHour());

    if (!Number.isInteger(value) || value < 0 || value > 23) {
      return getManilaHour();
    }

    return value;
  }

  function renderForecast(data, municipality, variable, selectedDate, selectedHour) {
    const cells = safeArray(data?.cells);
    const tableBody = $("forecastTableBody");

    if (tableBody) {
      tableBody.replaceChildren();
    }

    const validCells = cells.filter((cell) =>
      cell &&
      cell.value !== null &&
      cell.value !== undefined &&
      Number.isFinite(Number(cell.value))
    );

    if (validCells.length === 0) {
      if (tableBody) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");

        cell.colSpan = 3;
        cell.textContent = "No forecast value returned for this selection.";

        row.appendChild(cell);
        tableBody.appendChild(row);
      }

      if ($("forecastPointCount")) {
        $("forecastPointCount").textContent = "0";
      }

      if ($("forecastAverage")) {
        $("forecastAverage").textContent = "—";
      }

      if ($("forecastSelectedTime")) {
        $("forecastSelectedTime").textContent =
          `${municipality} · ${selectedDate} ${String(selectedHour).padStart(2, "0")}:00`;
      }

      latestForecast = data;
      state.forecastLoaded = true;

      setForecastStatus("No forecast value available", "warning");
      return;
    }

    for (const item of validCells) {
      const row = document.createElement("tr");

      const nameCell = document.createElement("td");
      const valueCell = document.createElement("td");
      const timeCell = document.createElement("td");

      nameCell.textContent =
        item.municipality ||
        item.name ||
        municipality;

      const unit = item.unit ? ` ${item.unit}` : "";

      valueCell.textContent = `${fmt(item.value, 2)}${unit}`;

      timeCell.textContent =
        item.forecast_time ||
        `${selectedDate} ${String(selectedHour).padStart(2, "0")}:00`;

      row.append(nameCell, valueCell, timeCell);

      if (tableBody) {
        tableBody.appendChild(row);
      }
    }

    /*
     * The current backend may return only one municipality point.
     * Average only the actual values returned by the API.
     */
    const average =
      validCells.reduce((sum, item) => sum + Number(item.value), 0) /
      validCells.length;

    if ($("forecastPointCount")) {
      $("forecastPointCount").textContent = String(validCells.length);
    }

    if ($("forecastAverage")) {
      const unit = validCells[0]?.unit
        ? ` ${validCells[0].unit}`
        : "";

      $("forecastAverage").textContent =
        `${fmt(average, 2)}${unit}`;
    }

    if ($("forecastSelectedTime")) {
      $("forecastSelectedTime").textContent =
        `${municipality} · ${selectedDate} ${String(selectedHour).padStart(2, "0")}:00`;
    }

    latestForecast = data;
    state.forecastLoaded = true;

    setForecastStatus(
      `Forecast loaded for ${municipality}`,
      "success"
    );
  }

  /*
   * Request the forecast for the currently selected municipality.
   */

  async function loadForecast() {
    const requestId = ++forecastRequestId;
    const municipality = getSelectedMunicipality();
    const variable = getForecastVariable();
    const selectedDate = getForecastDate();
    const selectedHour = getForecastHour();

    if (!selectedDate) {
      setForecastStatus("Select a forecast date.", "warning");
      return;
    }

    setForecastStatus("Loading forecast…", "loading");

    if ($("loadForecastButton")) {
      $("loadForecastButton").disabled = true;
    }

    const query = new URLSearchParams({
      municipality,
      variable,
      date: selectedDate,
      hour: String(selectedHour)
    });

    try {
      const response = await fetch(
        `${API_BASE}/weather/forecast-grid?${query.toString()}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json"
          }
        }
      );

      if (!response.ok) {
        let detail = `Forecast request failed (${response.status}).`;

        try {
          const body = await response.json();
          if (body?.detail) detail = body.detail;
        } catch {
          // Keep the HTTP error message.
        }

        throw new Error(detail);
      }

      const data = await response.json();

      if (requestId !== forecastRequestId) return;
      if (municipality !== getSelectedMunicipality()) return;

      renderForecast(
        data,
        municipality,
        variable,
        selectedDate,
        selectedHour
      );
    } catch (error) {
      if (requestId !== forecastRequestId) return;

      console.error("[AGOS Dashboard] Forecast error:", error);

      setForecastStatus(error.message, "error");

      const tableBody = $("forecastTableBody");

      if (tableBody) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");

        cell.colSpan = 3;
        cell.textContent = `Forecast unavailable: ${error.message}`;

        row.appendChild(cell);
        tableBody.replaceChildren(row);
      }

      if ($("forecastPointCount")) {
        $("forecastPointCount").textContent = "—";
      }

      if ($("forecastAverage")) {
        $("forecastAverage").textContent = "—";
      }
    } finally {
      if (requestId === forecastRequestId && $("loadForecastButton")) {
        $("loadForecastButton").disabled = false;
      }
    }
  }

  function setupForecastControls() {
    initializeForecastDate();
    populateForecastHours();

    $("loadForecastButton")?.addEventListener("click", () => {
      loadForecast();
    });

    $("forecastVariable")?.addEventListener("change", () => {
      loadForecast();
    });

    $("forecastDate")?.addEventListener("change", () => {
      loadForecast();
    });

    $("forecastHour")?.addEventListener("change", () => {
      loadForecast();
    });
  }

  /*
   * Map dataset access
   */

  function getMapData() {
    const api = window.AGOSMap;

    if (!api || typeof api.getLoadedData !== "function") {
      return {};
    }

    try {
      const data = api.getLoadedData();

      return data && typeof data === "object" ? data : {};
    } catch (error) {
      console.warn("[AGOS Dashboard] Could not read map data:", error);
      return {};
    }
  }

  function getFeatures(collection) {
    if (Array.isArray(collection)) {
      return collection;
    }

    if (collection && Array.isArray(collection.features)) {
      return collection.features;
    }

    return [];
  }

  function getFeatureProperties(feature) {
    return feature?.properties && typeof feature.properties === "object"
      ? feature.properties
      : {};
  }

  function validCoordinate(value) {
    if (value == null || value === "") return false;

    const number = Number(value);

    return Number.isFinite(number);
  }

  function getFeatureCoordinates(feature) {
    const geometry = feature?.geometry;

    if (!geometry) return [];

    const coordinates = [];

    function walk(value) {
      if (!Array.isArray(value)) return;

      if (
        value.length >= 2 &&
        validCoordinate(value[0]) &&
        validCoordinate(value[1]) &&
        typeof value[0] === "number" &&
        typeof value[1] === "number"
      ) {
        coordinates.push([value[0], value[1]]);
        return;
      }

      for (const child of value) {
        walk(child);
      }
    }

    walk(geometry.coordinates);

    return coordinates;
  }

  function isMapped(feature) {
    if (!feature?.geometry) return false;

    return getFeatureCoordinates(feature).some(([longitude, latitude]) =>
      longitude >= 119 &&
      longitude <= 122 &&
      latitude >= 13 &&
      latitude <= 16
    );
  }

  function getRisk(feature) {
    const properties = getFeatureProperties(feature);

    const raw =
      properties.risk_level ??
      properties.risk ??
      properties.risk_class ??
      properties.priority ??
      properties.severity ??
      "";

    const text = String(raw).toLowerCase();

    if (
      text.includes("high") ||
      text.includes("severe") ||
      text.includes("critical")
    ) {
      return "high";
    }

    if (text.includes("medium") || text.includes("moderate")) {
      return "medium";
    }

    if (text.includes("low")) {
      return "low";
    }

    return "unknown";
  }

  function findCollection(data, possibleNames) {
    for (const name of possibleNames) {
      if (data[name]) {
        return data[name];
      }
    }

    return null;
  }

  /*
   * Dashboard and supporting view metrics
   *
   * The five removed dashboard summary cards are intentionally
   * not referenced here. Map, analytics, and evacuation metrics
   * are still updated if their corresponding HTML elements exist.
   */

  function updateMetrics() {
    const data = getMapData();

    const floodEvidenceCollection = findCollection(data, [
      "floodEvidence",
      "floodEvidenceResults",
      "evidence",
      "evidenceCases",
      "floodObservations"
    ]);

    const reportsCollection = findCollection(data, [
      "floodReports",
      "reports"
    ]);

    const evacuationCollection = findCollection(data, [
      "evacuationCenters",
      "evacuation",
      "centers"
    ]);

    const candidateCollection = findCollection(data, [
      "candidateZones",
      "floodCandidateZones",
      "riskZones"
    ]);

    const evidence = getFeatures(floodEvidenceCollection);
    const reports = getFeatures(reportsCollection);
    const centers = getFeatures(evacuationCollection);
    const candidates = getFeatures(candidateCollection);

    const mappedCenters = centers.filter(isMapped);
    const unmappedCenters = centers.length - mappedCenters.length;

    const highRiskEvidence = evidence.filter(
      (feature) => getRisk(feature) === "high"
    );

    const highRiskCandidates = candidates.filter(
      (feature) => getRisk(feature) === "high"
    );

    /*
     * Map view metrics
     */

    if ($("mapFloodCount")) {
      $("mapFloodCount").textContent = String(evidence.length);
    }

    if ($("mapEvacuationCount")) {
      $("mapEvacuationCount").textContent = String(centers.length);
    }

    if ($("mapMappedCount")) {
      $("mapMappedCount").textContent = String(mappedCenters.length);
    }

    if ($("mapEvidenceCount")) {
      $("mapEvidenceCount").textContent = String(evidence.length);
    }

    /*
     * Analytics view metrics
     */

    if ($("analyticsFloodTotal")) {
      $("analyticsFloodTotal").textContent = String(evidence.length);
    }

    if ($("analyticsHighTotal")) {
      $("analyticsHighTotal").textContent = String(highRiskEvidence.length);
    }

    if ($("analyticsEvidenceTotal")) {
      $("analyticsEvidenceTotal").textContent = String(evidence.length);
    }

    if ($("analyticsCandidateZoneTotal")) {
      $("analyticsCandidateZoneTotal").textContent =
        String(candidates.length);
    }

    /*
     * Evacuation view metrics
     */

    if ($("evacuationTotal")) {
      $("evacuationTotal").textContent = String(centers.length);
    }

    if ($("evacuationMapped")) {
      $("evacuationMapped").textContent = String(mappedCenters.length);
    }

    if ($("evacuationUnmapped")) {
      $("evacuationUnmapped").textContent = String(unmappedCenters);
    }

    /*
     * Risk distribution
     */

    renderRiskBars(evidence);

    /*
     * Candidate-zone table
     */

    renderSimpleRows(
      $("candidateZonesTable"),
      candidates,
      [
        {
          label: "Candidate zone",
          get: (feature, index) => {
            const properties = getFeatureProperties(feature);

            return (
              properties.name ??
              properties.zone_name ??
              properties.id ??
              `Candidate zone ${index + 1}`
            );
          }
        },
        {
          label: "Risk",
          get: (feature) => {
            const risk = getRisk(feature);

            return risk === "unknown"
              ? "Not classified"
              : risk.toUpperCase();
          }
        }
      ]
    );

    /*
     * Evidence validation table
     */

    renderSimpleRows(
      $("validationTable"),
      evidence,
      [
        {
          label: "Evidence",
          get: (feature, index) => {
            const properties = getFeatureProperties(feature);

            return (
              properties.name ??
              properties.id ??
              properties.report_id ??
              `Evidence ${index + 1}`
            );
          }
        },
        {
          label: "Risk",
          get: (feature) => {
            const risk = getRisk(feature);

            return risk === "unknown"
              ? "Not classified"
              : risk.toUpperCase();
          }
        },
        {
          label: "Location",
          get: (feature) => {
            const properties = getFeatureProperties(feature);

            return (
              properties.municipality ??
              properties.city ??
              properties.barangay ??
              "Not specified"
            );
          }
        }
      ]
    );

    /*
     * Evacuation centers table
     */

    renderSimpleRows(
      $("evacuationTable"),
      centers,
      [
        {
          label: "Center",
          get: (feature, index) => {
            const properties = getFeatureProperties(feature);

            return (
              properties.name ??
              properties.center_name ??
              properties.facility_name ??
              `Evacuation center ${index + 1}`
            );
          }
        },
        {
          label: "Municipality",
          get: (feature) => {
            const properties = getFeatureProperties(feature);

            return (
              properties.municipality ??
              properties.city ??
              "Not specified"
            );
          }
        },
        {
          label: "Mapped",
          get: (feature) => isMapped(feature) ? "Yes" : "No"
        }
      ]
    );

    state.mapDataLoaded = true;

    /*
     * Retain references for debugging without making them the
     * source of truth for any displayed measurements.
     */
    window.AGOSDashboardData = {
      evidence,
      reports,
      centers,
      candidates,
      updatedAt: new Date().toISOString()
    };
  }

  function renderRiskBars(features) {
    const container = $("riskBars");

    if (!container) return;

    const counts = {
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0
    };

    for (const feature of features) {
      counts[getRisk(feature)] += 1;
    }

    const total = features.length;

    const rows = [
      ["High", counts.high, "high"],
      ["Medium", counts.medium, "medium"],
      ["Low", counts.low, "low"],
      ["Unclassified", counts.unknown, "unknown"]
    ];

    container.innerHTML = rows.map(([label, count, key]) => {
      const percentage = total > 0
        ? Math.round((count / total) * 100)
        : 0;

      return `
        <div class="risk-bar-row">
          <div class="risk-bar-label">
            <span>${escapeHtml(label)}</span>
            <strong>${count}</strong>
          </div>
          <div
            class="risk-bar-track"
            role="progressbar"
            aria-label="${escapeHtml(label)} risk observations"
            aria-valuemin="0"
            aria-valuemax="${Math.max(total, 1)}"
            aria-valuenow="${count}"
          >
            <div
              class="risk-bar-fill risk-${escapeHtml(key)}"
              style="width: ${percentage}%"
            ></div>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderSimpleRows(container, features, columns) {
    if (!container) return;

    const tbody = container.tagName === "TBODY"
      ? container
      : container.querySelector("tbody");

    if (!tbody) return;

    tbody.replaceChildren();

    if (!features.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");

      cell.colSpan = columns.length;
      cell.textContent = "No records available in the loaded dataset.";

      row.appendChild(cell);
      tbody.appendChild(row);

      return;
    }

    features.forEach((feature, index) => {
      const row = document.createElement("tr");

      for (const column of columns) {
        const cell = document.createElement("td");
        cell.textContent = String(column.get(feature, index) ?? "—");
        row.appendChild(cell);
      }

      tbody.appendChild(row);
    });
  }

  /*
   * Municipality selection
   */

  function handleMunicipalityChange() {
    const municipality = getSelectedMunicipality();

    state.municipality = municipality;

    /*
     * Increment request IDs immediately. Any pending response
     * for the previous municipality becomes obsolete.
     */
    weatherRequestId += 1;
    forecastRequestId += 1;

    loadWeather();
    loadForecast();

    /*
     * Optional companion preview module. It is safe for this
     * dashboard to run when that module has not been installed.
     */
    if (
      window.AGOSDashboardMapPreview &&
      typeof window.AGOSDashboardMapPreview.setMunicipality === "function"
    ) {
      window.AGOSDashboardMapPreview.setMunicipality(municipality);
    }

    document.dispatchEvent(
      new CustomEvent("agos:municipality-change", {
        detail: { municipality }
      })
    );
  }

  /*
   * Data and view events
   *
   * Navigation itself is owned by index.html/app.js. This module
   * intentionally does not attach another navigation handler.
   */

  function setupEvents() {
    $("municipalitySelect")?.addEventListener(
      "change",
      handleMunicipalityChange
    );

    document.addEventListener("agos:data-ready", () => {
      updateMetrics();
    });

    document.addEventListener("agos:data-updated", () => {
      updateMetrics();
    });

    document.addEventListener("agos:viewchange", (event) => {
      if (event.detail?.view === "dashboard") {
        updateMetrics();
      }
    });

    /*
     * Map modules may use different readiness events.
     * This listener provides a single fallback without polling.
     */
    document.addEventListener("DOMContentLoaded", updateMetrics);
  }

  /*
   * Initialization
   */

  function initialize() {
    if (initialized) return;
    initialized = true;

    state.municipality = getSelectedMunicipality();

    setupForecastControls();
    setupEvents();

    loadWeather();
    loadForecast();
    updateMetrics();

    /*
     * Match the backend's 15-minute cache more closely than a
     * one-minute timer. Changing municipalities still reloads
     * weather immediately.
     */
    weatherTimer = window.setInterval(() => {
      loadWeather();
    }, WEATHER_REFRESH_MS);

    /*
     * Forecast data is refreshed by user selection rather than
     * by a repeating timer, avoiding unnecessary API requests.
     */
    window.setTimeout(updateMetrics, 1000);

    console.info("[AGOS Dashboard] Initialized.", {
      municipality: state.municipality,
      apiBase: API_BASE,
      timezone: TIME_ZONE
    });
  }

  /*
   * Public API
   */

  window.AGOSDashboard = {
    initialize,
    loadWeather,
    loadForecast,
    updateMetrics,
    getSelectedMunicipality,
    getMunicipalityCoordinates,
    getLatestWeather: () => latestWeather,
    getLatestForecast: () => latestForecast,
    getState: () => ({ ...state }),

    destroy() {
      if (weatherTimer !== null) {
        window.clearInterval(weatherTimer);
        weatherTimer = null;
      }

      weatherRequestId += 1;
      forecastRequestId += 1;
      initialized = false;
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, {
      once: true
    });
  } else {
    initialize();
  }
})();
