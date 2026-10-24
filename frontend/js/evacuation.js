
/*
 * ============================================================
 * AGOS — EVACUATION CENTER DIRECTORY
 * File: frontend/js/evacuation.js
 * ============================================================
 *
 * Complete replacement.
 *
 * Preserves:
 * - All 12 tracked evacuation centers and coordinates
 * - Search by name, municipality, or ID
 * - Municipality and operating-status filters
 * - Directory metrics and last-updated display
 * - Show on AGOS Map integration
 * - Open Google Maps buttons
 * - Emergency contact disclaimer without fabricated numbers
 *
 * UI FIX:
 * - Dark navy cards
 * - High-contrast white headings and values
 * - Brighter secondary text
 * - Readable status badges and buttons
 *
 * DATA POLICY:
 * Coordinates are based on supplied Google Maps listings.
 * Capacity, availability, and operating status are unverified.
 * A mapped center is not proof that it is open or safe.
 * ============================================================
 */

(() => {
  "use strict";

  // ------------------------------------------------------------
  // 1. CONFIGURATION
  // ------------------------------------------------------------

  const CONFIG = {
    viewId: "view-evacuation",
    directoryId: "evacuation-directory",

    searchId: "evacuationSearch",
    municipalityFilterId: "evacuationMunicipalityFilter",
    statusFilterId: "evacuationStatusFilter",
    resetButtonId: "evacuationResetFilters",
    refreshButtonId: "evacuationRefreshButton",

    totalMetricId: "evacuationTotal",
    mappedMetricId: "evacuationMapped",
    unmappedMetricId: "evacuationUnmapped",
    resultCountId: "evacuationResultCount",
    mapNoticeId: "evacuationMapNotice",
    lastUpdatedId: "evacuationLastUpdated",
    municipalityCountId: "evacuationMunicipalityCount",

    mapZoom: 14,
    mapFlyDuration: 1200
  };

  // ------------------------------------------------------------
  // 2. EVACUATION CENTER DATA
  // ------------------------------------------------------------

  const EVACUATION_CENTERS = [
    {
      id: "EC-001",
      name: "Colo Evacuation Center",
      municipality: "Dinalupihan",
      latitude: 14.8463056,
      longitude: 120.4115833,
      googleMapsUrl:
        "https://www.google.com/maps/search/?api=1&query=14.8463056%2C120.4115833",
      capacity: null,
      availability: "Not provided",
      operatingStatus: "Not provided"
    },
    {
      id: "EC-002",
      name: "Hermosa Multipurpose Covered Court",
      municipality: "Hermosa",
      latitude: 14.8297701,
      longitude: 120.5093926,
      googleMapsUrl:
        "https://www.google.com/maps/place/Hermosa+Multipurpose+Covered+Court/@14.8297701,120.5068123,17z/data=!3m1!4b1!4m6!3m5!1s0x339668140c7cce91:0xb71010d7ccc3f25a!8m2!3d14.8297701!4d120.5093926!16s%2Fg%2F1tfnqjlv",
      capacity: null,
      availability: "Not provided",
      operatingStatus: "Not provided"
    },
    {
      id: "EC-003",
      name: "Multi-purpose Hall and Evacuation Center",
      municipality: "Orani",
      latitude: 14.8060647,
      longitude: 120.5337888,
      googleMapsUrl:
        "https://www.google.com/maps/place/Multi-purpose+Hall+and+Evacuation+Center/@14.8059765,120.5325738,18z/data=!4m6!3m5!1s0x339643da1457becd:0x2ba321281e309e46!8m2!3d14.8060647!4d120.5337888!16s%2Fg%2F11qpzp81s3",
      capacity: null,
      availability: "Not provided",
      operatingStatus: "Not provided"
    },
    {
      id: "EC-004",
      name: "Command Center (Municipality of Samal)",
      municipality: "Samal",
      latitude: 14.7688624,
      longitude: 120.543458,
      googleMapsUrl:
        "https://www.google.com/maps/place/Command+Center+(Municipality+of+Samal)/@14.7688624,120.543458,17z/data=!3m1!4b1!4m6!3m5!1s0x339643035aa6075b:0x699b2dc7b3c3d507!8m2!3d14.7688624!4d120.543458!16s%2Fg%2F11r8mdbcv5",
      capacity: null,
      availability: "Not provided",
      operatingStatus: "Not provided"
    },
    {
      id: "EC-005",
      name: "Abucay Evacuation Center",
      municipality: "Abucay",
      latitude: 14.714787,
      longitude: 120.5256037,
      googleMapsUrl:
        "https://www.google.com/maps/place/Abucay+Evacuation+Center/@14.714787,120.5256037,17z/data=!3m1!4b1!4m6!3m5!1s0x33966b839fde3997:0x87aab8c9127c0446!8m2!3d14.714787!4d120.5256037!16s%2Fg%2F11l2_0rz_x",
      capacity: null,
      availability: "Not provided",
      operatingStatus: "Not provided"
    },
    {
      id: "EC-006",
      name: "Bataan People's Center",
      municipality: "Balanga City",
      latitude: 14.6748468,
      longitude: 120.5299984,
      googleMapsUrl:
        "https://www.google.com/maps/place/Bataan+People's+Center/@14.6748196,120.5301815,20z/data=!4m6!3m5!1s0x33963f1ee283aa4d:0xd1f9342bee889409!8m2!3d14.6748468!4d120.5299984!16s%2Fg%2F11pv2rpg9x",
      capacity: null,
      availability: "Not provided",
      operatingStatus: "Not provided"
    },
    {
      id: "EC-007",
      name: "Pilar Government Center",
      municipality: "Pilar",
      latitude: 14.6560086,
      longitude: 120.5435607,
      googleMapsUrl:
        "https://www.google.com/maps/place/Pilar+Government+Center/@14.6560086,120.5435607,17z/data=!3m1!4b1!4m6!3m5!1s0x33963fe9a0555555:0x7829c57852cf9a4a!8m2!3d14.6560086!4d120.5435607!16s%2Fg%2F11tgg7nv3m",
      capacity: null,
      availability: "Not provided",
      operatingStatus: "Not provided"
    },
    {
      id: "EC-008",
      name: "KAMALIG (Orion Sports Complex)",
      municipality: "Orion",
      latitude: 14.6244387,
      longitude: 120.5865591,
      googleMapsUrl:
        "https://www.google.com/maps/place/KAMALIG+(Orion+Sports+Complex)/@14.6231371,120.5837742,18z/data=!4m6!3m5!1s0x33963f141497cb97:0xcfd789836b3c2784!8m2!3d14.6244387!4d120.5865591!16s%2Fg%2F11q465dggv",
      capacity: null,
      availability: "Not provided",
      operatingStatus: "Not provided"
    },
    {
      id: "EC-009",
      name: "Limay Sports Complex",
      municipality: "Limay",
      latitude: 14.563348,
      longitude: 120.5933632,
      googleMapsUrl:
        "https://www.google.com/maps/place/Limay+Sports+Complex/@14.563348,120.5933632,17z/data=!3m1!4b1!4m6!3m5!1s0x33963d2a6ad71e53:0x25733005ff91a3af!8m2!3d14.563348!4d120.5933632!16s%2Fg%2F11rkgnz8qp",
      capacity: null,
      availability: "Not provided",
      operatingStatus: "Not provided"
    },
    {
      id: "EC-010",
      name: "Mariveles Sports Complex",
      municipality: "Mariveles",
      latitude: 14.4367421,
      longitude: 120.4889534,
      googleMapsUrl:
        "https://www.google.com/maps/place/Mariveles+Sports+Complex/@14.4367421,120.4863731,17z/data=!3m1!4b1!4m6!3m5!1s0x339618d3956aaaab:0xba269636e2539808!8m2!3d14.4367421!4d120.4889534!16s%2Fg%2F11sskrfl4r",
      capacity: null,
      availability: "Not provided",
      operatingStatus: "Not provided"
    },
    {
      id: "EC-011",
      name: "Emilio C. Bernabe Bagac National High School",
      municipality: "Bagac",
      latitude: 14.6055262,
      longitude: 120.4019701,
      googleMapsUrl:
        "https://www.google.com/maps/place/Emilio+C.+Bernabe+Bagac+National+High+School/@14.6055262,120.4019701,17z/data=!3m1!4b1!4m6!3m5!1s0x3396116313606f15:0xb08e84add041e650!8m2!3d14.6055262!4d120.4019701!16s%2Fg%2F1tcy1v6y",
      capacity: null,
      availability: "Not provided",
      operatingStatus: "Not provided"
    },
    {
      id: "EC-012",
      name: "Morong Bataan Evacuation Center",
      municipality: "Morong",
      latitude: 14.6870596,
      longitude: 120.2635574,
      googleMapsUrl:
        "https://www.google.com/maps/place/Morong+Bataan+Evacuation+Center/@14.6870596,120.2609771,17z/data=!3m1!4b1!4m6!3m5!1s0x33960d5aed11b319:0x8de9186103924cef!8m2!3d14.6870596!4d120.2635574!16s%2Fg%2F11qnttx3b8",
      capacity: null,
      availability: "Not provided",
      operatingStatus: "Not provided"
    }
  ];

  // ------------------------------------------------------------
  // 3. STATE
  // ------------------------------------------------------------

  let initialized = false;
  let lastUpdated = null;

  const state = {
    search: "",
    municipality: "",
    status: ""
  };

  // ------------------------------------------------------------
  // 4. HELPERS
  // ------------------------------------------------------------

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHTML(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalize(value) {
    return String(value ?? "").trim().toLowerCase();
  }

  function hasCoordinates(center) {
    if (!center) return false;

    const latitude = Number(center.latitude);
    const longitude = Number(center.longitude);

    return (
      center.latitude !== null &&
      center.longitude !== null &&
      center.latitude !== undefined &&
      center.longitude !== undefined &&
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180
    );
  }

  function getKnownMunicipalities() {
    return [
      ...new Set(
        EVACUATION_CENTERS
          .map(center => center.municipality)
          .filter(Boolean)
      )
    ].sort((a, b) => a.localeCompare(b));
  }

  function getKnownStatuses() {
    return [
      ...new Set(
        EVACUATION_CENTERS
          .map(center => center.operatingStatus)
          .filter(Boolean)
      )
    ].sort((a, b) => a.localeCompare(b));
  }

  function getMapInstance() {
    try {
      if (window.AGOSMap?.getMap) {
        return window.AGOSMap.getMap();
      }

      if (
        window.AGOSMap &&
        typeof window.AGOSMap.flyTo === "function"
      ) {
        return window.AGOSMap;
      }

      return null;
    } catch (error) {
      console.warn(
        "[AGOS Evacuation] Could not access map:",
        error
      );

      return null;
    }
  }

  function setText(id, value) {
    const element = byId(id);

    if (element) {
      element.textContent = String(value);
    }
  }

  function formatLastUpdated(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      return "Not available";
    }

    return date.toLocaleString("en-PH", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    });
  }

  function openExternalMap(center) {
    if (!center) return;

    if (center.googleMapsUrl) {
      window.open(
        center.googleMapsUrl,
        "_blank",
        "noopener,noreferrer"
      );
      return;
    }

    if (!hasCoordinates(center)) return;

    const query = encodeURIComponent(
      `${center.latitude},${center.longitude}`
    );

    window.open(
      `https://www.google.com/maps/search/?api=1&query=${query}`,
      "_blank",
      "noopener,noreferrer"
    );
  }

  // ------------------------------------------------------------
  // 5. FILTERING
  // ------------------------------------------------------------

  function getFilteredCenters() {
    return EVACUATION_CENTERS.filter(center => {
      const searchableText = normalize([
        center.id,
        center.name,
        center.municipality
      ].join(" "));

      const matchesSearch =
        !state.search ||
        searchableText.includes(normalize(state.search));

      const matchesMunicipality =
        !state.municipality ||
        center.municipality === state.municipality;

      const matchesStatus =
        !state.status ||
        normalize(center.operatingStatus) === normalize(state.status);

      return (
        matchesSearch &&
        matchesMunicipality &&
        matchesStatus
      );
    });
  }

  // ------------------------------------------------------------
  // 6. METRICS
  // ------------------------------------------------------------

  function renderMetrics(filteredCenters = EVACUATION_CENTERS) {
    const total = EVACUATION_CENTERS.length;

    const mapped = EVACUATION_CENTERS.filter(
      hasCoordinates
    ).length;

    const unmapped = total - mapped;
    const municipalityCount = getKnownMunicipalities().length;

    setText(CONFIG.totalMetricId, total);
    setText(CONFIG.mappedMetricId, mapped);
    setText(CONFIG.unmappedMetricId, unmapped);
    setText(CONFIG.municipalityCountId, municipalityCount);

    setText(
      CONFIG.resultCountId,
      `${filteredCenters.length} of ${total} centers`
    );

    const mapNotice = byId(CONFIG.mapNoticeId);

    if (mapNotice) {
      mapNotice.textContent =
        "Mapped locations are based on supplied Google Maps listings. " +
        "Current operating status, capacity, and availability have not " +
        "been verified.";
    }

    setText(
      CONFIG.lastUpdatedId,
      lastUpdated
        ? formatLastUpdated(lastUpdated)
        : "Initial directory load"
    );
  }

  // ------------------------------------------------------------
  // 7. STATUS LABELS
  // ------------------------------------------------------------

  function getStatusPresentation(center) {
    const status = normalize(center.operatingStatus);

    if (
      status === "open" ||
      status === "operational" ||
      status === "available"
    ) {
      return {
        label: center.operatingStatus,
        className: "status-open"
      };
    }

    if (
      status === "closed" ||
      status === "unavailable" ||
      status === "not operational"
    ) {
      return {
        label: center.operatingStatus,
        className: "status-closed"
      };
    }

    if (status === "full") {
      return {
        label: center.operatingStatus,
        className: "status-full"
      };
    }

    return {
      label: "Status not verified",
      className: "status-unknown"
    };
  }

  // ------------------------------------------------------------
  // 8. CENTER CARD
  // ------------------------------------------------------------

  function renderCenterCard(center) {
    const coordinatesAvailable = hasCoordinates(center);
    const status = getStatusPresentation(center);

    const coordinatesText = coordinatesAvailable
      ? `${Number(center.latitude).toFixed(6)}, ` +
        `${Number(center.longitude).toFixed(6)}`
      : "Coordinates unavailable";

    const capacityText =
      center.capacity !== null &&
      center.capacity !== undefined
        ? escapeHTML(center.capacity)
        : "Not provided";

    const mapButton = coordinatesAvailable
      ? `
        <button
          type="button"
          class="agos-evacuation-map-button"
          data-action="show-map"
          data-center-id="${escapeHTML(center.id)}"
        >
          <span aria-hidden="true">⌖</span>
          Show on AGOS Map
        </button>
      `
      : `
        <button
          type="button"
          class="agos-evacuation-map-button"
          disabled
        >
          Location unavailable
        </button>
      `;

    const externalMapButton = `
      <button
        type="button"
        class="agos-evacuation-external-button"
        data-action="open-google-maps"
        data-center-id="${escapeHTML(center.id)}"
      >
        Open Google Maps
        <span aria-hidden="true">↗</span>
      </button>
    `;

    return `
      <article
        class="agos-evacuation-card"
        data-center-id="${escapeHTML(center.id)}"
      >
        <div class="agos-evacuation-card-header">
          <div class="agos-evacuation-heading">
            <span class="agos-evacuation-id">
              ${escapeHTML(center.id)}
            </span>

            <h3 class="agos-evacuation-name">
              ${escapeHTML(center.name)}
            </h3>

            <p class="agos-evacuation-municipality">
              <span aria-hidden="true">⌖</span>
              ${escapeHTML(center.municipality)}
            </p>
          </div>

          <span
            class="agos-evacuation-status ${status.className}"
            title="Operating status has not been independently verified"
          >
            ${escapeHTML(status.label)}
          </span>
        </div>

        <div class="agos-evacuation-divider"></div>

        <div class="agos-evacuation-details">
          <div class="agos-evacuation-detail">
            <span class="agos-evacuation-detail-label">
              COORDINATES
            </span>

            <span class="agos-evacuation-detail-value agos-evacuation-coordinates">
              ${escapeHTML(coordinatesText)}
            </span>
          </div>

          <div class="agos-evacuation-detail">
            <span class="agos-evacuation-detail-label">
              CAPACITY
            </span>

            <span class="agos-evacuation-detail-value">
              ${capacityText}
            </span>
          </div>

          <div class="agos-evacuation-detail">
            <span class="agos-evacuation-detail-label">
              AVAILABILITY
            </span>

            <span class="agos-evacuation-detail-value agos-evacuation-availability">
              ${escapeHTML(center.availability || "Not provided")}
            </span>
          </div>
        </div>

        <div class="agos-evacuation-actions">
          ${mapButton}
          ${externalMapButton}
        </div>

        <p class="agos-evacuation-disclaimer">
          <span aria-hidden="true">ⓘ</span>
          Location listed; current shelter availability is unverified.
        </p>
      </article>
    `;
  }

  // ------------------------------------------------------------
  // 9. DIRECTORY RENDERING
  // ------------------------------------------------------------

  function renderCenters() {
    const container = byId(CONFIG.directoryId);

    if (!container) {
      console.warn(
        `[AGOS Evacuation] Missing #${CONFIG.directoryId}. ` +
        "Check the evacuation page HTML."
      );
      return;
    }

    const centers = getFilteredCenters();

    if (centers.length === 0) {
      container.innerHTML = `
        <div class="agos-evacuation-empty" role="status">
          <h3>No evacuation centers found</h3>
          <p>Try another search term or reset your filters.</p>
        </div>
      `;

      renderMetrics(centers);
      return;
    }

    container.innerHTML = `
      <div class="agos-evacuation-grid">
        ${centers.map(renderCenterCard).join("")}
      </div>
    `;

    renderMetrics(centers);
  }

  // ------------------------------------------------------------
  // 10. MUNICIPALITY FILTER
  // ------------------------------------------------------------

  function populateMunicipalityFilter() {
    const select = byId(CONFIG.municipalityFilterId);

    if (!select) return;

    const previousValue = select.value;

    select.innerHTML = `
      <option value="">All municipalities</option>
      ${getKnownMunicipalities()
        .map(municipality => `
          <option value="${escapeHTML(municipality)}">
            ${escapeHTML(municipality)}
          </option>
        `)
        .join("")}
    `;

    if (getKnownMunicipalities().includes(previousValue)) {
      select.value = previousValue;
    }
  }

  // ------------------------------------------------------------
  // 11. STATUS FILTER
  // ------------------------------------------------------------

  function populateStatusFilter() {
    const select = byId(CONFIG.statusFilterId);

    if (!select) return;

    const previousValue = select.value;
    const statuses = getKnownStatuses();

    select.innerHTML = `
      <option value="">All status values</option>
      ${statuses.map(status => `
        <option value="${escapeHTML(status)}">
          ${escapeHTML(status)}
        </option>
      `).join("")}
    `;

    if (statuses.includes(previousValue)) {
      select.value = previousValue;
    }
  }

  // ------------------------------------------------------------
  // 12. SHOW CENTER ON AGOS MAP
  // ------------------------------------------------------------

  function showCenterOnMap(center) {
    const notice = byId(CONFIG.mapNoticeId);

    if (!center || !hasCoordinates(center)) {
      if (notice) {
        notice.textContent =
          "This center does not have valid coordinates.";
      }

      return false;
    }

    const map = getMapInstance();

    if (!map) {
      if (notice) {
        notice.textContent =
          "The AGOS map is not available. Open Google Maps instead.";
      }

      return false;
    }

    const longitude = Number(center.longitude);
    const latitude = Number(center.latitude);

    try {
      if (typeof map.flyTo === "function") {
        map.flyTo({
          center: [longitude, latitude],
          zoom: CONFIG.mapZoom,
          duration: CONFIG.mapFlyDuration
        });
      } else if (typeof map.setView === "function") {
        map.setView(
          [latitude, longitude],
          CONFIG.mapZoom
        );
      } else {
        if (notice) {
          notice.textContent =
            "The connected map does not expose a supported navigation method.";
        }

        return false;
      }

      if (notice) {
        notice.textContent =
          `Navigating to ${center.name}, ${center.municipality}. ` +
          "The mapped location does not confirm current shelter availability.";
      }

      return true;
    } catch (error) {
      console.error(
        "[AGOS Evacuation] Map navigation failed:",
        error
      );

      if (notice) {
        notice.textContent =
          "Unable to navigate the AGOS map. Try opening Google Maps.";
      }

      return false;
    }
  }

  // ------------------------------------------------------------
  // 13. CARD BUTTON EVENTS
  // ------------------------------------------------------------

  function handleDirectoryClick(event) {
    const target = event.target;

    if (!(target instanceof Element)) return;

    const button = target.closest("button[data-action]");

    if (!button) return;

    const action = button.dataset.action;
    const centerId = button.dataset.centerId;

    const center = EVACUATION_CENTERS.find(
      item => item.id === centerId
    );

    if (!center) return;

    if (action === "show-map") {
      const success = showCenterOnMap(center);

      if (!success) {
        openExternalMap(center);
      }

      return;
    }

    if (action === "open-google-maps") {
      openExternalMap(center);
    }
  }

  // ------------------------------------------------------------
  // 14. FILTER EVENTS
  // ------------------------------------------------------------

  function handleSearchChange(event) {
    state.search = event.target.value || "";
    renderCenters();
  }

  function handleMunicipalityChange(event) {
    state.municipality = event.target.value || "";
    renderCenters();
  }

  function handleStatusChange(event) {
    state.status = event.target.value || "";
    renderCenters();
  }

  function resetFilters() {
    state.search = "";
    state.municipality = "";
    state.status = "";

    const search = byId(CONFIG.searchId);
    const municipality = byId(CONFIG.municipalityFilterId);
    const status = byId(CONFIG.statusFilterId);

    if (search) search.value = "";
    if (municipality) municipality.value = "";
    if (status) status.value = "";

    renderCenters();
  }

  // ------------------------------------------------------------
  // 15. HOTLINE DIRECTORY
  // ------------------------------------------------------------

  function getHotlineContainer() {
    let container = byId("evacuation-hotlines");

    if (container) return container;

    const view = byId(CONFIG.viewId);

    if (!view) return null;

    container = document.createElement("section");
    container.id = "evacuation-hotlines";
    container.className = "agos-evacuation-hotlines";

    view.appendChild(container);

    return container;
  }

  function renderHotlines() {
    const container = getHotlineContainer();

    if (!container) return;

    container.innerHTML = `
      <h2>Emergency Contacts</h2>

      <p>
        Contact details have not yet been verified for this directory.
        Please consult official Bataan provincial or municipal
        government channels for current emergency instructions.
      </p>

      <p class="agos-evacuation-hotline-note">
        This directory does not confirm which evacuation centers
        are open or accepting evacuees.
      </p>
    `;
  }

  // ------------------------------------------------------------
  // 16. REFRESH
  // ------------------------------------------------------------

  function refreshDirectory() {
    lastUpdated = new Date();

    populateMunicipalityFilter();
    populateStatusFilter();
    renderCenters();
    renderHotlines();

    setText(
      CONFIG.lastUpdatedId,
      formatLastUpdated(lastUpdated)
    );
  }

  // ------------------------------------------------------------
  // 17. HIGH-CONTRAST STYLES
  // ------------------------------------------------------------

  function injectStyles() {
    if (byId("agos-evacuation-styles")) return;

    const style = document.createElement("style");
    style.id = "agos-evacuation-styles";

    style.textContent = `
      /*
       * Use fixed, high-contrast colors inside the evacuation
       * cards instead of relying on the page's theme variables.
       */
      #${CONFIG.viewId} .agos-evacuation-grid {
        display: grid;
        grid-template-columns:
          repeat(auto-fit, minmax(min(100%, 290px), 1fr));
        gap: 18px;
        width: 100%;
        align-items: stretch;
      }

      #${CONFIG.viewId} .agos-evacuation-card {
        box-sizing: border-box;
        min-width: 0;
        padding: 20px;
        overflow: hidden;

        color: #f8fafc !important;
        background: linear-gradient(
          145deg,
          #142b43 0%,
          #0c1d30 100%
        ) !important;

        border: 1px solid #304b66 !important;
        border-radius: 16px;

        box-shadow:
          0 8px 22px rgba(0, 0, 0, 0.18),
          inset 0 1px 0 rgba(255, 255, 255, 0.035);

        transition:
          transform 180ms ease,
          border-color 180ms ease,
          box-shadow 180ms ease;
      }

      #${CONFIG.viewId} .agos-evacuation-card:hover {
        transform: translateY(-2px);
        border-color: #4d789b !important;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.24);
      }

      #${CONFIG.viewId} .agos-evacuation-card,
      #${CONFIG.viewId} .agos-evacuation-card * {
        box-sizing: border-box;
      }

      #${CONFIG.viewId} .agos-evacuation-card-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }

      #${CONFIG.viewId} .agos-evacuation-heading {
        flex: 1 1 auto;
        min-width: 0;
      }

      #${CONFIG.viewId} .agos-evacuation-id {
        display: inline-block;
        margin-bottom: 8px;
        color: #77d9e8 !important;
        font-size: 0.75rem;
        font-weight: 800;
        letter-spacing: 0.09em;
      }

      #${CONFIG.viewId} .agos-evacuation-name {
        margin: 0;
        color: #ffffff !important;
        font-size: 1.04rem;
        font-weight: 750;
        line-height: 1.45;
        overflow-wrap: anywhere;
        text-shadow: none;
      }

      #${CONFIG.viewId} .agos-evacuation-municipality {
        margin: 8px 0 0;
        color: #c5d6e7 !important;
        font-size: 0.9rem;
        line-height: 1.5;
      }

      #${CONFIG.viewId} .agos-evacuation-status {
        flex: 0 0 auto;
        max-width: 145px;
        padding: 7px 10px;
        border: 1px solid transparent;
        border-radius: 8px;

        font-size: 0.72rem;
        font-weight: 800;
        line-height: 1.35;
        text-align: center;
        overflow-wrap: anywhere;
      }

      #${CONFIG.viewId} .agos-evacuation-status.status-unknown {
        color: #ffe9a6 !important;
        background: #493c1c !important;
        border-color: #806c35 !important;
      }

      #${CONFIG.viewId} .agos-evacuation-status.status-open {
        color: #a7f3d0 !important;
        background: #123e37 !important;
        border-color: #287766 !important;
      }

      #${CONFIG.viewId} .agos-evacuation-status.status-closed {
        color: #fecaca !important;
        background: #512b35 !important;
        border-color: #984453 !important;
      }

      #${CONFIG.viewId} .agos-evacuation-status.status-full {
        color: #fed7aa !important;
        background: #51351f !important;
        border-color: #98633a !important;
      }

      #${CONFIG.viewId} .agos-evacuation-divider {
        height: 1px;
        margin: 18px 0;
        background: #30465d;
      }

      #${CONFIG.viewId} .agos-evacuation-details {
        display: grid;
        gap: 15px;
      }

      #${CONFIG.viewId} .agos-evacuation-detail {
        display: grid;
        gap: 5px;
        min-width: 0;
      }

      #${CONFIG.viewId} .agos-evacuation-detail-label {
        color: #a9c0d5 !important;
        font-size: 0.72rem;
        font-weight: 800;
        letter-spacing: 0.075em;
      }

      #${CONFIG.viewId} .agos-evacuation-detail-value {
        display: block;
        color: #ffffff !important;
        font-size: 0.9rem;
        font-weight: 550;
        line-height: 1.55;
        overflow-wrap: anywhere;
        word-break: normal;
      }

      #${CONFIG.viewId} .agos-evacuation-coordinates {
        color: #b9e7ff !important;
        font-variant-numeric: tabular-nums;
      }

      #${CONFIG.viewId} .agos-evacuation-availability {
        color: #f8e7b0 !important;
      }

      #${CONFIG.viewId} .agos-evacuation-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 20px;
      }

      #${CONFIG.viewId} .agos-evacuation-actions button {
        display: inline-flex;
        flex: 1 1 auto;
        align-items: center;
        justify-content: center;
        gap: 7px;

        min-width: 0;
        min-height: 42px;
        padding: 10px 13px;

        border: 1px solid transparent;
        border-radius: 9px;

        font-family: inherit;
        font-size: 0.82rem;
        font-weight: 750;
        line-height: 1.35;
        text-align: center;

        cursor: pointer;
        transition:
          background 160ms ease,
          border-color 160ms ease,
          transform 160ms ease;
      }

      #${CONFIG.viewId} .agos-evacuation-actions button:hover:not(:disabled) {
        transform: translateY(-1px);
      }

      #${CONFIG.viewId} .agos-evacuation-map-button {
        color: #ffffff !important;
        background: #087e8b !important;
        border-color: #35bdc8 !important;
      }

      #${CONFIG.viewId} .agos-evacuation-map-button:hover:not(:disabled) {
        background: #0a98a6 !important;
      }

      #${CONFIG.viewId} .agos-evacuation-external-button {
        color: #e8f4ff !important;
        background: #203c57 !important;
        border-color: #52718e !important;
      }

      #${CONFIG.viewId} .agos-evacuation-external-button:hover:not(:disabled) {
        background: #2b4d6c !important;
        border-color: #7da6c8 !important;
      }

      #${CONFIG.viewId} .agos-evacuation-actions button:focus-visible {
        outline: 3px solid #facc15;
        outline-offset: 3px;
      }

      #${CONFIG.viewId} .agos-evacuation-actions button:disabled {
        color: #cbd5e1 !important;
        background: #334155 !important;
        border-color: #475569 !important;
        opacity: 0.7;
        cursor: not-allowed;
      }

      #${CONFIG.viewId} .agos-evacuation-disclaimer {
        display: flex;
        align-items: flex-start;
        gap: 7px;

        margin: 16px 0 0;
        padding-top: 13px;

        color: #b9cadd !important;
        border-top: 1px solid #30465d;

        font-size: 0.78rem;
        line-height: 1.6;
      }

      #${CONFIG.viewId} .agos-evacuation-disclaimer span {
        flex: 0 0 auto;
        color: #f6d47a !important;
      }

      #${CONFIG.viewId} .agos-evacuation-empty {
        padding: 30px 18px;
        color: #f8fafc !important;
        background: #12263b !important;
        border: 1px dashed #52718e !important;
        border-radius: 14px;
        text-align: center;
      }

      #${CONFIG.viewId} .agos-evacuation-empty h3 {
        margin-top: 0;
        color: #ffffff !important;
      }

      #${CONFIG.viewId} .agos-evacuation-empty p {
        color: #c5d6e7 !important;
        line-height: 1.6;
      }

      #${CONFIG.viewId} .agos-evacuation-hotlines {
        margin-top: 28px;
        padding: 20px;

        color: #f8fafc !important;
        background: #12263b !important;

        border: 1px solid #304b66 !important;
        border-radius: 14px;
      }

      #${CONFIG.viewId} .agos-evacuation-hotlines h2 {
        margin-top: 0;
        color: #ffffff !important;
      }

      #${CONFIG.viewId} .agos-evacuation-hotlines p {
        color: #d2deeb !important;
        line-height: 1.7;
      }

      #${CONFIG.viewId} .agos-evacuation-hotlines .agos-evacuation-hotline-note {
        color: #b9cadd !important;
        font-size: 0.85rem;
      }

      @media (max-width: 600px) {
        #${CONFIG.viewId} .agos-evacuation-card {
          padding: 16px;
        }

        #${CONFIG.viewId} .agos-evacuation-card-header {
          flex-direction: column;
          align-items: flex-start;
        }

        #${CONFIG.viewId} .agos-evacuation-status {
          max-width: 100%;
        }

        #${CONFIG.viewId} .agos-evacuation-actions {
          flex-direction: column;
        }

        #${CONFIG.viewId} .agos-evacuation-actions button {
          width: 100%;
          flex-basis: auto;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        #${CONFIG.viewId} .agos-evacuation-card,
        #${CONFIG.viewId} .agos-evacuation-actions button {
          transition: none;
        }

        #${CONFIG.viewId} .agos-evacuation-card:hover,
        #${CONFIG.viewId} .agos-evacuation-actions button:hover:not(:disabled) {
          transform: none;
        }
      }
    `;

    document.head.appendChild(style);
  }

  // ------------------------------------------------------------
  // 18. INITIALIZATION
  // ------------------------------------------------------------

  function initialize() {
    if (initialized) return;

    const view = byId(CONFIG.viewId);
    const directory = byId(CONFIG.directoryId);

    if (!view || !directory) {
      console.warn(
        "[AGOS Evacuation] Required HTML elements were not found. " +
        `Expected #${CONFIG.viewId} and #${CONFIG.directoryId}.`
      );

      return;
    }

    initialized = true;

    injectStyles();
    populateMunicipalityFilter();
    populateStatusFilter();

    const search = byId(CONFIG.searchId);
    const municipality = byId(CONFIG.municipalityFilterId);
    const status = byId(CONFIG.statusFilterId);
    const reset = byId(CONFIG.resetButtonId);
    const refresh = byId(CONFIG.refreshButtonId);

    if (search) {
      search.addEventListener("input", handleSearchChange);
    }

    if (municipality) {
      municipality.addEventListener(
        "change",
        handleMunicipalityChange
      );
    }

    if (status) {
      status.addEventListener("change", handleStatusChange);
    }

    if (reset) {
      reset.addEventListener("click", resetFilters);
    }

    if (refresh) {
      refresh.addEventListener("click", refreshDirectory);
    }

    directory.addEventListener("click", handleDirectoryClick);

    refreshDirectory();

    console.info(
      `[AGOS Evacuation] Initialized with ` +
      `${EVACUATION_CENTERS.length} tracked centers.`
    );
  }

  // ------------------------------------------------------------
  // 19. PUBLIC API
  // ------------------------------------------------------------

  window.AGOSEvacuationDirectory = {
    initialize,
    refresh: refreshDirectory,

    getAll() {
      return EVACUATION_CENTERS.map(center => ({ ...center }));
    },

    getById(id) {
      const center = EVACUATION_CENTERS.find(
        item => item.id === id
      );

      return center ? { ...center } : null;
    },

    getByMunicipality(municipality) {
      return EVACUATION_CENTERS
        .filter(
          center =>
            normalize(center.municipality) ===
            normalize(municipality)
        )
        .map(center => ({ ...center }));
    },

    search(query) {
      const term = normalize(query);

      return EVACUATION_CENTERS
        .filter(center =>
          normalize([
            center.id,
            center.name,
            center.municipality
          ].join(" ")).includes(term)
        )
        .map(center => ({ ...center }));
    },

    showOnMap(id) {
      const center = EVACUATION_CENTERS.find(
        item => item.id === id
      );

      return showCenterOnMap(center);
    }
  };

  // Backwards-compatible namespace.
  window.AGOS = window.AGOS || {};
  window.AGOS.Evacuation = window.AGOSEvacuationDirectory;

  // ------------------------------------------------------------
  // 20. STARTUP
  // ------------------------------------------------------------

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      initialize,
      { once: true }
    );
  } else {
    initialize();
  }

})();
