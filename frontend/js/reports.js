
/*
 * AGOS — Community Flood Reports
 * Complete replacement for frontend/js/reports.js
 *
 * Community reporting only.
 * No satellite-assessment workflow.
 *
 * API:
 *   POST /reports/community
 *   GET  /reports
 *   GET  /reports/{report_id}
 *
 * Matches the supplied frontend/index.html and the
 * community-report backend contract.
 */

(() => {
  "use strict";

  // ------------------------------------------------------------
  // 1. CONFIGURATION
  // ------------------------------------------------------------

  const CONFIG = {
    // Backend address comes from js/config.js.
    apiBase: window.AGOS_CONFIG
      ? window.AGOS_CONFIG.apiBase
      : "http://127.0.0.1:8000",
    endpoints: {
      submit: "/reports/community",
      list: "/reports"
    },
    requestTimeoutMs: 30000,
    maxPhotoBytes: 8 * 1024 * 1024,
    allowedPhotoTypes: [
      "image/jpeg",
      "image/png",
      "image/webp"
    ],
    municipalities: [
      "Abucay",
      "Bagac",
      "Balanga",
      "Dinalupihan",
      "Hermosa",
      "Limay",
      "Mariveles",
      "Morong",
      "Orani",
      "Orion",
      "Pilar",
      "Samal"
    ]
  };

  // ------------------------------------------------------------
  // 2. STATE
  // ------------------------------------------------------------

  let isSubmitting = false;
  let latestReports = [];
  let latestReport = null;
  let photoObjectUrl = null;

  // ------------------------------------------------------------
  // 3. DOM HELPERS
  // ------------------------------------------------------------

  const byId = id => document.getElementById(id);

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = value ?? "";
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getValue(id) {
    const element = byId(id);
    return element ? String(element.value ?? "").trim() : "";
  }

  function getNumber(id) {
    const value = getValue(id);
    if (value === "") return null;

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function getSelectedFile(id) {
    const input = byId(id);
    return input?.files?.[0] || null;
  }

  function formatDate(value) {
    if (!value) return "Not provided";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }

    return date.toLocaleString("en-PH", {
      dateStyle: "medium",
      timeStyle: "short"
    });
  }

  function formatDepth(value) {
    if (value === null || value === undefined || value === "") {
      return "Not provided";
    }

    const number = Number(value);
    return Number.isFinite(number)
      ? `${number} cm`
      : String(value);
  }

  function normalizeSeverity(value) {
    const severity = String(value ?? "").trim().toLowerCase();

    const allowed = [
      "low",
      "moderate",
      "high",
      "critical"
    ];

    return allowed.includes(severity) ? severity : "";
  }

  function titleCase(value) {
    const text = String(value ?? "").trim();
    if (!text) return "Not provided";

    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // ------------------------------------------------------------
  // 4. STATUS MESSAGES
  // ------------------------------------------------------------

  function showStatus(message, state = "info") {
    const element = byId("reportProcessingStatus");

    if (!element) {
      console.info(`AGOS Reports: ${message}`);
      return;
    }

    element.hidden = false;
    element.textContent = message;

    element.classList.remove(
      "ok",
      "error",
      "success",
      "loading"
    );

    if (state === "success") {
      element.classList.add("ok", "success");
    } else if (state === "error") {
      element.classList.add("error");
    } else if (state === "loading") {
      element.classList.add("loading");
    }
  }

  function clearStatus() {
    const element = byId("reportProcessingStatus");
    if (!element) return;

    element.hidden = true;
    element.textContent = "";
    element.classList.remove(
      "ok",
      "error",
      "success",
      "loading"
    );
  }

  function setLocationStatus(message) {
    setText("reportLocationStatus", message);
  }

  // ------------------------------------------------------------
  // 5. API REQUEST HELPER
  // ------------------------------------------------------------

  async function apiRequest(path, options = {}) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      CONFIG.requestTimeoutMs
    );

    try {
      const response = await fetch(
        `${CONFIG.apiBase}${path}`,
        {
          ...options,
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            ...(options.headers || {})
          }
        }
      );

      const contentType =
        response.headers.get("content-type") || "";

      let data = null;

      if (contentType.includes("application/json")) {
        data = await response.json();
      } else {
        const body = await response.text();
        data = body ? { detail: body } : null;
      }

      if (!response.ok) {
        const detail = data?.detail;

        let message = "";

        if (typeof detail === "string") {
          message = detail;
        } else if (Array.isArray(detail)) {
          message = detail
            .map(item => item.msg || JSON.stringify(item))
            .join("; ");
        } else if (detail) {
          message = JSON.stringify(detail);
        }

        message =
          message ||
          data?.message ||
          data?.error ||
          `The server returned HTTP ${response.status}.`;

        throw new Error(message);
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(
          "The request timed out. Please check that the backend is running and try again."
        );
      }

      if (error instanceof TypeError) {
        throw new Error(
          `Cannot connect to the AGOS backend. Check that FastAPI is running at ${CONFIG.apiBase || window.location.origin} and that CORS is configured.`
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ------------------------------------------------------------
  // 6. FORM VALIDATION
  // ------------------------------------------------------------

  function validateForm() {
    const requiredFields = [
      ["reportAddress", "Enter the specific location or address."],
      ["reportMunicipality", "Select a municipality."],
      ["reportWaterDepth", "Enter the estimated water depth."],
      ["reportDate", "Choose the date and time observed."],
      ["reportDescription", "Describe the flooding."]
    ];

    for (const [id, message] of requiredFields) {
      const element = byId(id);

      if (!element || !String(element.value ?? "").trim()) {
        if (element) element.focus();
        throw new Error(message);
      }
    }

    const municipality = getValue("reportMunicipality");

    if (!CONFIG.municipalities.includes(municipality)) {
      byId("reportMunicipality")?.focus();
      throw new Error("Select a valid Bataan municipality.");
    }

    const description = getValue("reportDescription");

    if (description.length < 10) {
      byId("reportDescription")?.focus();
      throw new Error(
        "Please provide at least 10 characters describing the observed flooding."
      );
    }

    const waterDepth = getNumber("reportWaterDepth");

    if (
      waterDepth === null ||
      waterDepth < 0 ||
      waterDepth > 1000
    ) {
      byId("reportWaterDepth")?.focus();
      throw new Error(
        "Water depth must be between 0 and 1,000 cm."
      );
    }

    const observedAt = getValue("reportDate");

    if (Number.isNaN(new Date(observedAt).getTime())) {
      byId("reportDate")?.focus();
      throw new Error("Enter a valid observation date and time.");
    }

    const severityInput = document.querySelector(
      '#reportForm input[name="severity"]:checked'
    );

    if (!severityInput || !normalizeSeverity(severityInput.value)) {
      throw new Error("Select the observed flood severity.");
    }

    const accuracy = byId("reportAccuracy");

    if (!accuracy?.checked) {
      accuracy?.focus();
      throw new Error(
        "Confirm that the information reflects your observations."
      );
    }

    const latitude = getNumber("reportLatitude");
    const longitude = getNumber("reportLongitude");

    if ((latitude === null) !== (longitude === null)) {
      throw new Error(
        "Both GPS coordinates are required when providing a location."
      );
    }

    if (
      latitude !== null &&
      (latitude < -90 || latitude > 90)
    ) {
      throw new Error("The latitude is outside the valid range.");
    }

    if (
      longitude !== null &&
      (longitude < -180 || longitude > 180)
    ) {
      throw new Error("The longitude is outside the valid range.");
    }

    const photo = getSelectedFile("reportPhoto");

    if (photo) {
      if (!CONFIG.allowedPhotoTypes.includes(photo.type)) {
        throw new Error(
          "Use a JPEG, PNG, or WebP photo."
        );
      }

      if (photo.size > CONFIG.maxPhotoBytes) {
        throw new Error(
          "The photo exceeds 8 MB. Choose a smaller image."
        );
      }
    }
  }

  // ------------------------------------------------------------
  // 7. BUILD REQUEST DATA
  // ------------------------------------------------------------

  function buildCommunityReportFormData() {
    const formData = new FormData();

    /*
     * Names below match the FastAPI community-report endpoint.
     *
     * HTML field              API field
     * ----------------------------------------------------
     * reportAddress           location
     * reportMunicipality      municipality
     * reportBarangay          barangay
     * severity radio          severity (lowercase)
     * reportWaterDepth        water_level_cm
     * reportDate              reported_at
     * reportDescription       description
     * reportContact           contact_number
     * reportLatitude          latitude
     * reportLongitude         longitude
     * reportAccuracy          accuracy_confirmed
     * reportPhoto             photo
     */

    const severityInput = document.querySelector(
      '#reportForm input[name="severity"]:checked'
    );

    const fields = {
      location: getValue("reportAddress"),
      municipality: getValue("reportMunicipality"),
      barangay: getValue("reportBarangay"),
      severity: normalizeSeverity(severityInput?.value),
      water_level_cm: getNumber("reportWaterDepth"),
      reported_at: getValue("reportDate"),
      description: getValue("reportDescription"),
      contact_number: getValue("reportContact"),
      latitude: getNumber("reportLatitude"),
      longitude: getNumber("reportLongitude"),
      accuracy_confirmed: "true",

      // This HTML form is specifically for flood reports.
      report_type: "flooding"
    };

    for (const [key, value] of Object.entries(fields)) {
      if (
        value !== null &&
        value !== undefined &&
        value !== ""
      ) {
        formData.append(key, String(value));
      }
    }

    const photo = getSelectedFile("reportPhoto");

    if (photo) {
      formData.append("photo", photo, photo.name);
    }

    return formData;
  }

  // ------------------------------------------------------------
  // 8. SUBMIT REPORT
  // ------------------------------------------------------------

  async function handleCommunityReportSubmit(event) {
    event.preventDefault();

    if (isSubmitting) return;

    clearStatus();

    try {
      validateForm();

      isSubmitting = true;
      setSubmitButtonState(true);

      showStatus(
        "Submitting your flood report… Please wait.",
        "loading"
      );

      const formData = buildCommunityReportFormData();

      const result = await apiRequest(
        CONFIG.endpoints.submit,
        {
          method: "POST",
          body: formData
        }
      );

      const savedReport =
        result?.report ||
        result?.data ||
        result;

      if (!savedReport || typeof savedReport !== "object") {
        throw new Error(
          "The server response did not contain the saved report."
        );
      }

      latestReport = savedReport;

      renderLatestReport(savedReport);

      const reference = getReportId(savedReport);
      const verification = getVerificationStatus(savedReport);

      showStatus(
        `Report submitted successfully. Reference: ${reference}. Review status: ${titleCase(verification)}. A submitted report is not yet a verified flood observation.`,
        "success"
      );

      const form = byId("reportForm");

      if (form) {
        form.reset();
      }

      setDefaultDateTime();
      clearPhotoPreview();

      setLocationStatus(
        "GPS is optional. You can enter the location manually."
      );

      // Reload records, but do not overwrite the success message
      // with a background-list error.
      await loadReports({ silent: true });

      // Restore the just-submitted report summary in case the
      // GET endpoint has not included it in its response yet.
      renderLatestReport(savedReport);

      document.dispatchEvent(
        new CustomEvent("agos:community-report-submitted", {
          detail: { report: savedReport }
        })
      );

      console.info(
        "AGOS community report submitted:",
        savedReport
      );
    } catch (error) {
      console.error(
        "AGOS community report submission failed:",
        error
      );

      showStatus(
        error.message ||
          "Unable to submit the flood report. Please try again.",
        "error"
      );
    } finally {
      isSubmitting = false;
      setSubmitButtonState(false);
    }
  }

  function setSubmitButtonState(disabled) {
    const button = byId("submitFloodReport");

    if (!button) return;

    if (disabled) {
      if (button.dataset.originalText === undefined) {
        button.dataset.originalText = button.textContent;
      }

      button.disabled = true;
      button.textContent = "Submitting…";
    } else {
      button.disabled = false;

      if (button.dataset.originalText !== undefined) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
      }
    }
  }

  // ------------------------------------------------------------
  // 9. DEFAULT DATE AND TIME
  // ------------------------------------------------------------

  function setDefaultDateTime(force = false) {
    const input = byId("reportDate");

    if (!input || (input.value && !force)) return;

    const now = new Date();
    const localDate = new Date(
      now.getTime() - now.getTimezoneOffset() * 60000
    );

    input.value = localDate.toISOString().slice(0, 16);
  }

  // ------------------------------------------------------------
  // 10. OPTIONAL GPS
  // ------------------------------------------------------------

  function bindLocationButton() {
    const button = byId("reportGetLocation");

    if (!button || button.dataset.agosBound === "true") {
      return;
    }

    button.dataset.agosBound = "true";

    button.addEventListener("click", () => {
      if (!navigator.geolocation) {
        setLocationStatus(
          "This browser does not support GPS. Enter the location manually."
        );
        return;
      }

      const originalText = button.textContent;

      button.disabled = true;
      button.textContent = "Getting location…";

      setLocationStatus(
        "Waiting for browser location permission…"
      );

      navigator.geolocation.getCurrentPosition(
        position => {
          const latitude = position.coords.latitude;
          const longitude = position.coords.longitude;

          const latInput = byId("reportLatitude");
          const lngInput = byId("reportLongitude");

          if (latInput) {
            latInput.value = latitude.toFixed(6);
          }

          if (lngInput) {
            lngInput.value = longitude.toFixed(6);
          }

          button.disabled = false;
          button.textContent = originalText;

          setLocationStatus(
            `Coordinates captured: ${latitude.toFixed(5)}, ${longitude.toFixed(5)}. Confirm they match the reported location.`
          );
        },
        error => {
          button.disabled = false;
          button.textContent = originalText;

          let message =
            "Unable to get your location. Enter it manually instead.";

          if (error.code === error.PERMISSION_DENIED) {
            message =
              "Location permission was denied. You can still submit the report manually.";
          } else if (error.code === error.TIMEOUT) {
            message =
              "GPS timed out. Try again or enter the location manually.";
          }

          setLocationStatus(message);
        },
        {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 60000
        }
      );
    });
  }

  // ------------------------------------------------------------
  // 11. PHOTO SELECTION FEEDBACK
  // ------------------------------------------------------------

  function bindPhotoFeedback() {
    const input = byId("reportPhoto");

    if (!input || input.dataset.agosBound === "true") {
      return;
    }

    input.dataset.agosBound = "true";

    const label = input.closest("label");

    const feedback = document.createElement("div");
    feedback.id = "reportPhotoFeedback";
    feedback.setAttribute("aria-live", "polite");
    feedback.style.marginTop = "8px";
    feedback.style.color = "var(--muted, #9aadc2)";
    feedback.style.fontSize = "0.82rem";
    feedback.style.lineHeight = "1.6";

    input.insertAdjacentElement("afterend", feedback);

    input.addEventListener("change", () => {
      clearPhotoPreview();

      const file = input.files?.[0];

      if (!file) {
        feedback.textContent = "";
        return;
      }

      if (!CONFIG.allowedPhotoTypes.includes(file.type)) {
        feedback.textContent = "Unsupported image type.";
        return;
      }

      if (file.size > CONFIG.maxPhotoBytes) {
        feedback.textContent = "File exceeds the 8 MB limit.";
        return;
      }

      const sizeMB = (file.size / (1024 * 1024)).toFixed(2);

      feedback.textContent =
        `${file.name} · ${sizeMB} MB`;

      const preview = ensurePhotoPreview(label);

      if (preview) {
        const image = document.createElement("img");
        image.alt = "Preview of selected flood report photo";
        image.style.display = "block";
        image.style.maxWidth = "100%";
        image.style.maxHeight = "220px";
        image.style.marginTop = "12px";
        image.style.borderRadius = "10px";
        image.style.objectFit = "contain";

        photoObjectUrl = URL.createObjectURL(file);
        image.src = photoObjectUrl;

        preview.appendChild(image);
        preview.hidden = false;
      }
    });
  }

  function ensurePhotoPreview(label) {
    if (!label) return null;

    let preview = byId("reportPhotoPreview");

    if (!preview) {
      preview = document.createElement("div");
      preview.id = "reportPhotoPreview";
      preview.hidden = true;
      preview.style.marginTop = "10px";

      const feedback = byId("reportPhotoFeedback");

      if (feedback) {
        feedback.insertAdjacentElement("afterend", preview);
      } else {
        label.appendChild(preview);
      }
    }

    return preview;
  }

  function clearPhotoPreview() {
    const preview = byId("reportPhotoPreview");

    if (preview) {
      preview.replaceChildren();
      preview.hidden = true;
    }

    if (photoObjectUrl) {
      URL.revokeObjectURL(photoObjectUrl);
      photoObjectUrl = null;
    }

    const feedback = byId("reportPhotoFeedback");

    if (feedback) {
      feedback.textContent = "";
    }
  }

  // ------------------------------------------------------------
  // 12. NORMALIZE API RESPONSES
  // ------------------------------------------------------------

  function normalizeReportList(data) {
    if (Array.isArray(data)) return data;

    if (Array.isArray(data?.reports)) return data.reports;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.data)) return data.data;

    return [];
  }

  function getReportId(report) {
    return (
      report?.report_id ??
      report?.id ??
      report?.reference_id ??
      "Reference unavailable"
    );
  }

  function getReportDate(report) {
    return (
      report?.reported_at ??
      report?.observed_at ??
      report?.created_at ??
      report?.report_date ??
      report?.date ??
      null
    );
  }

  function getReportMunicipality(report) {
    return (
      report?.municipality ??
      report?.city ??
      "Not specified"
    );
  }

  function getReportLocation(report) {
    return (
      report?.location ??
      report?.address ??
      report?.specific_location ??
      "Location not provided"
    );
  }

  function getReportSeverity(report) {
    return report?.severity ?? "Unclassified";
  }

  function getReportDepth(report) {
    return (
      report?.water_level_cm ??
      report?.water_depth_cm ??
      report?.water_level ??
      null
    );
  }

  function getVerificationStatus(report) {
    return (
      report?.verification_status ??
      report?.review_status ??
      report?.status ??
      "submitted"
    );
  }

  function getReportLocationLabel(report) {
    const municipality = getReportMunicipality(report);
    const barangay = report?.barangay;
    const location = getReportLocation(report);

    const parts = [
      location,
      barangay,
      municipality
    ].filter(Boolean);

    return [...new Set(parts)].join(", ");
  }

  // ------------------------------------------------------------
  // 13. LATEST REPORT SUMMARY
  // ------------------------------------------------------------

  function renderLatestReport(report) {
    const container = byId("latestReportSummary");
    if (!container) return;

    container.replaceChildren();

    if (!report || typeof report !== "object") {
      container.textContent =
        "No community report has been submitted in this session.";
      return;
    }

    const entries = [
      ["Reference ID", getReportId(report)],
      ["Observed", formatDate(getReportDate(report))],
      ["Municipality", getReportMunicipality(report)],
      ["Barangay", report?.barangay || "Not provided"],
      ["Specific location", getReportLocation(report)],
      ["Severity", titleCase(getReportSeverity(report))],
      ["Estimated water depth", formatDepth(getReportDepth(report))],
      ["Review status", titleCase(getVerificationStatus(report))],
      [
        "Description",
        report?.description || "No description provided."
      ]
    ];

    const grid = document.createElement("div");
    grid.className = "report-summary-details";

    for (const [label, value] of entries) {
      const item = document.createElement("div");
      item.className = "report-summary-item";

      const heading = document.createElement("strong");
      heading.textContent = label;

      const detail = document.createElement("span");
      detail.textContent = String(value ?? "Not provided");

      item.append(heading, detail);
      grid.appendChild(item);
    }

    container.appendChild(grid);
  }

  // ------------------------------------------------------------
  // 14. COMMUNITY REPORT TABLE
  // ------------------------------------------------------------

  function renderReportsTable(reports) {
    const tbody = byId("reportsTable");
    if (!tbody) return;

    tbody.replaceChildren();

    if (!reports.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");

      cell.colSpan = 5;
      cell.className = "empty-state";
      cell.textContent = "No community reports have been submitted yet.";

      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }

    const sorted = [...reports].sort((a, b) => {
      const aTime = new Date(getReportDate(a) || 0).getTime();
      const bTime = new Date(getReportDate(b) || 0).getTime();

      return bTime - aTime;
    });

    for (const report of sorted) {
      const row = document.createElement("tr");

      const observedCell = document.createElement("td");
      observedCell.textContent = formatDate(getReportDate(report));

      const locationCell = document.createElement("td");
      locationCell.textContent = getReportLocationLabel(report);

      const severityCell = document.createElement("td");
      severityCell.textContent = titleCase(getReportSeverity(report));

      const depthCell = document.createElement("td");
      depthCell.textContent = formatDepth(getReportDepth(report));

      const statusCell = document.createElement("td");
      const status = document.createElement("span");

      status.className = "report-status";
      status.textContent = titleCase(getVerificationStatus(report));

      const verification = String(
        getVerificationStatus(report)
      ).toLowerCase();

      if (verification.includes("pending") ||
          verification.includes("submitted")) {
        status.classList.add("pending");
      } else if (verification.includes("verified")) {
        status.classList.add("verified");
      } else if (verification.includes("rejected")) {
        status.classList.add("rejected");
      }

      statusCell.appendChild(status);

      row.append(
        observedCell,
        locationCell,
        severityCell,
        depthCell,
        statusCell
      );

      tbody.appendChild(row);
    }
  }

  // ------------------------------------------------------------
  // 15. LOAD REPORTS FROM API
  // ------------------------------------------------------------

  async function loadReports(options = {}) {
    const { silent = false } = options;

    try {
      const data = await apiRequest(
        CONFIG.endpoints.list,
        {
          method: "GET",
          cache: "no-store"
        }
      );

      latestReports = normalizeReportList(data);

      renderReportsTable(latestReports);

      if (latestReports.length) {
        const sorted = [...latestReports].sort((a, b) => {
          const aTime = new Date(getReportDate(a) || 0).getTime();
          const bTime = new Date(getReportDate(b) || 0).getTime();

          return bTime - aTime;
        });

        latestReport = sorted[0];
        renderLatestReport(latestReport);
      } else {
        latestReport = null;
        renderLatestReport(null);
      }

      if (!silent) {
        console.info(
          `AGOS: Loaded ${latestReports.length} community reports.`
        );
      }

      return latestReports;
    } catch (error) {
      console.error("AGOS: Failed to load community reports:", error);

      const tbody = byId("reportsTable");

      if (tbody) {
        tbody.replaceChildren();

        const row = document.createElement("tr");
        const cell = document.createElement("td");

        cell.colSpan = 5;
        cell.className = "empty-state";
        cell.textContent =
          "Could not load community reports. Check the backend connection and try refreshing.";

        row.appendChild(cell);
        tbody.appendChild(row);
      }

      if (!silent) {
        showStatus(
          `Could not load community reports: ${error.message}`,
          "error"
        );
      }

      return [];
    }
  }

  // ------------------------------------------------------------
  // 16. INITIALIZATION
  // ------------------------------------------------------------

  function bindForm() {
    const form = byId("reportForm");

    if (!form || form.dataset.agosBound === "true") {
      return;
    }

    form.dataset.agosBound = "true";
    form.addEventListener("submit", handleCommunityReportSubmit);
  }

  function initializeReports() {
    bindForm();
    bindLocationButton();
    bindPhotoFeedback();
    setDefaultDateTime();

    loadReports({ silent: true });

    console.info("AGOS community reporting initialized.");
  }

  // ------------------------------------------------------------
  // 17. PUBLIC API
  // ------------------------------------------------------------

  window.AGOSReports = {
    loadReports,

    refresh() {
      return loadReports();
    },

    getReports() {
      return [...latestReports];
    },

    getLatestReport() {
      return latestReport;
    }
  };

  // ------------------------------------------------------------
  // 18. STARTUP
  // ------------------------------------------------------------

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      initializeReports,
      { once: true }
    );
  } else {
    initializeReports();
  }
})();
