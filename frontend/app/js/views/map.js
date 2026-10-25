/*
 * Map page: full-screen map, layers + legend + rain time control on the left,
 * municipality / evacuation / report details in a drawer on the right.
 * On phones both panels become bottom sheets.
 */

import { icon } from "../core/icons.js";
import { t, getLang } from "../core/i18n.js";
import { getJSON } from "../core/api.js";
import { escapeHTML, num, formatTime, isNumber, distanceKm, relativeTime, parseTime, PH_TZ } from "../core/format.js";
import { LEVELS, LEVEL_IDS, levelLabel, levelRange } from "../core/levels.js";
import { effectiveTheme } from "../core/theme.js";
import { EXPLAIN } from "../core/explain.js";
import { buildHash } from "../core/router.js";
import { createAgosMap } from "../map/engine.js";
import { renderDetail, hydrateDetail } from "./parts/muni-detail.js";
import { loadingState, errorState, onRetry } from "../core/ui.js";

export const layout = "flush";

const OVERVIEW_TTL = 10 * 60 * 1000;

const LAYERS = [
  { id: "rain", group: "hazard", why: "rainLevels", always: false },
  { id: "mgb", group: "hazard", why: "mgb" },
  { id: "precip", group: "hazard", why: "precipitation" },
  { id: "evacuation", group: "places", why: "evacuation" },
  { id: "reports", group: "places", why: "reports" },
  { id: "boundaries", group: "places", why: "boundaries" },
];

const LAYER_SWATCHES = {
  rain: () => LEVEL_IDS.filter((id) => id !== "nodata").map((id) => [LEVELS[id].color, `${levelLabel(id, getLang())} · ${levelRange(id, getLang())}`]),
  mgb: () => [["#002673", t("mgb.veryHigh")], ["#5900ff", t("mgb.high")], ["#b045ff", t("mgb.moderate")], ["#e3d1ff", t("mgb.low")]],
  precip: () => [],
  evacuation: () => [["#16a34a", t("map.swatch.center")]],
  reports: () => [["#7c3aed", t("map.swatch.report")]],
  boundaries: () => [["#0b63c4", t("map.swatch.boundary")]],
};

function hourLabel(time, index) {
  return `${formatTime(time)}${index > 0 ? ` (+${index} h)` : ""}`;
}

export async function mount(container, route) {
  container.innerHTML = `
    <h1 class="visually-hidden">${escapeHTML(t("title.map"))}</h1>
    <div class="mapview" id="mapview">
      <div class="map-canvas" id="mapCanvas" role="region" aria-label="${escapeHTML(t("map.aria"))}">
        <div class="map-loading" id="mapLoading">${loadingState(t("map.loading"))}</div>
      </div>

      <aside class="map-panel map-panel-left" id="leftPanel" aria-label="${escapeHTML(t("map.panel"))}">
        <button class="sheet-handle" type="button" id="leftHandle" aria-expanded="false" aria-controls="leftBody">
          <span class="sheet-grip" aria-hidden="true"></span>
          <span class="row" style="gap:8px">${icon("layers", { size: 18 })}<strong>${escapeHTML(t("map.panelShort"))}</strong></span>
          <span id="handleSummary" class="subtle"></span>
        </button>
        <div class="map-panel-body" id="leftBody">
          <div class="map-search">
            <label class="visually-hidden" for="mapSearch">${escapeHTML(t("map.search"))}</label>
            <div class="search-box">
              ${icon("search", { size: 18 })}
              <input id="mapSearch" class="input" type="search" autocomplete="off" placeholder="${escapeHTML(t("map.search"))}" role="combobox" aria-expanded="false" aria-controls="searchResults" aria-autocomplete="list">
            </div>
            <ul class="search-results" id="searchResults" role="listbox" hidden></ul>
            <button class="btn btn-sm btn-block" type="button" id="locateBtn" style="margin-top:8px">${icon("locate", { size: 16 })} ${escapeHTML(t("map.locate"))}</button>
          </div>

          <section class="panel-section" aria-labelledby="timeHeading">
            <div class="detail-head"><h3 id="timeHeading">${escapeHTML(t("map.rainForecast"))}</h3><button class="why" type="button" data-why="rainLevels" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button></div>
            <div class="segmented" role="group" aria-label="${escapeHTML(t("map.mode"))}">
              <button type="button" data-mode="peak" aria-pressed="true">${escapeHTML(t("map.modePeak"))}</button>
              <button type="button" data-mode="hour" aria-pressed="false">${escapeHTML(t("map.modeHour"))}</button>
            </div>
            <div id="hourControls" hidden>
              <div class="row" style="margin-top:10px;gap:8px">
                <button class="btn btn-sm btn-icon" type="button" id="playBtn" aria-label="${escapeHTML(t("map.play"))}">${icon("play", { size: 16 })}</button>
                <input type="range" id="hourSlider" min="0" max="47" value="0" step="1" aria-label="${escapeHTML(t("map.hour"))}" style="flex:1">
              </div>
            </div>
            <p class="subtle" id="timeLabel" style="margin-top:6px" aria-live="polite"></p>
            <p class="subtle" id="rainStatus"></p>
          </section>

          <section class="panel-section" aria-labelledby="typhoonHeading">
            <div class="detail-head"><h3 id="typhoonHeading">${escapeHTML(t("typhoon.heading"))}</h3><button class="why" type="button" data-why="typhoon" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button></div>
            <form class="typhoon-form" id="typhoonForm" novalidate>
              <label class="visually-hidden" for="typhoonUrl">${escapeHTML(t("typhoon.urlLabel"))}</label>
              <input id="typhoonUrl" class="input" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="${escapeHTML(t("typhoon.placeholder"))}">
              <button class="btn btn-sm btn-primary" type="submit" id="typhoonRead">${escapeHTML(t("typhoon.read"))}</button>
            </form>
            <p class="subtle" id="typhoonStatus" aria-live="polite"></p>
            <div class="row" id="typhoonActions" style="gap:8px" hidden>
              <button class="btn btn-sm" type="button" id="typhoonDetails">${escapeHTML(t("typhoon.details"))}</button>
              <button class="btn btn-sm btn-ghost" type="button" id="typhoonRemove">${icon("close", { size: 14 })} ${escapeHTML(t("typhoon.remove"))}</button>
            </div>
          </section>

          <section class="panel-section" aria-labelledby="layersHeading">
            <h3 id="layersHeading">${escapeHTML(t("map.layers"))}</h3>
            <div id="layerList" class="layer-list"></div>
          </section>

          <p class="subtle panel-foot">${escapeHTML(t("map.basemap"))}: <span id="basemapName">—</span></p>
        </div>
      </aside>

      <aside class="map-panel map-drawer" id="drawer" aria-label="${escapeHTML(t("common.details"))}" hidden>
        <button class="sheet-handle drawer-grip" type="button" id="drawerGrip" aria-expanded="false" aria-label="${escapeHTML(t("map.sheetExpand"))}"><span class="sheet-grip" aria-hidden="true"></span></button>
        <div class="drawer-head">
          <div id="drawerTitle" class="drawer-title"></div>
          <button class="btn btn-ghost btn-icon btn-sm" type="button" id="drawerClose" aria-label="${escapeHTML(t("common.close"))}">${icon("close", { size: 18 })}</button>
        </div>
        <div class="drawer-body" id="drawerBody"></div>
      </aside>
    </div>`;

  const $ = (sel) => container.querySelector(sel);
  const ui = {
    view: $("#mapview"), canvas: $("#mapCanvas"), loading: $("#mapLoading"), left: $("#leftPanel"), leftHandle: $("#leftHandle"),
    handleSummary: $("#handleSummary"), search: $("#mapSearch"), results: $("#searchResults"), locate: $("#locateBtn"),
    hourControls: $("#hourControls"), slider: $("#hourSlider"), play: $("#playBtn"), timeLabel: $("#timeLabel"),
    rainStatus: $("#rainStatus"), layerList: $("#layerList"), basemap: $("#basemapName"),
    drawer: $("#drawer"), drawerTitle: $("#drawerTitle"), drawerBody: $("#drawerBody"), drawerClose: $("#drawerClose"), drawerGrip: $("#drawerGrip"),
    tyForm: $("#typhoonForm"), tyUrl: $("#typhoonUrl"), tyRead: $("#typhoonRead"), tyStatus: $("#typhoonStatus"),
    tyActions: $("#typhoonActions"), tyDetails: $("#typhoonDetails"), tyRemove: $("#typhoonRemove"),
  };

  const state = {
    alive: true, engine: null, overview: null, overviewError: null, centers: [], reports: [], typhoon: null,
    mode: "peak", hour: 0, playTimer: null, selected: null, drawerCleanup: null, refreshTimer: null, detailToken: 0,
  };

  // ------------------------------------------------------------ layers panel
  function renderLayers(states = state.engine?.layerStates() || {}) {
    ui.layerList.innerHTML = LAYERS.map((layer) => {
      const s = states[layer.id] || {};
      const unavailable = s.available === false;
      const swatches = LAYER_SWATCHES[layer.id]();
      return `<div class="layer${unavailable ? " is-unavailable" : ""}">
        <div class="layer-row">
          <label class="switch">
            <input type="checkbox" data-layer="${layer.id}" ${s.visible && !unavailable ? "checked" : ""} ${unavailable ? "disabled" : ""}>
            <span>${escapeHTML(t(`map.layer.${layer.id}`))}</span>
          </label>
          <button class="why" type="button" data-why="${layer.why}" aria-label="${escapeHTML(t("common.why"))}: ${escapeHTML(t(`map.layer.${layer.id}`))}">${icon("info", { size: 16 })}</button>
        </div>
        ${s.visible && swatches.length && !unavailable ? `<ul class="swatches">${swatches.map(([color, label]) => `<li><span class="swatch" style="background:${color}"></span>${escapeHTML(label)}</li>`).join("")}</ul>` : ""}
        ${layer.id === "boundaries" && s.visible && state.engine?.boundarySource() === "psgc2023" ? `<p class="subtle">${escapeHTML(t("map.boundarySource"))} <a href="https://github.com/faeldon/philippines-json-maps" target="_blank" rel="noopener noreferrer">philippines-json-maps</a> (MIT) · <a href="#/sources?s=boundaries">${escapeHTML(t("explain.details"))}</a></p>` : ""}
        ${layer.id === "precip" && s.visible ? `<p class="subtle">${escapeHTML(t("map.precipTime"))}: ${escapeHTML(state.engine?.precipTime() || "")}</p>` : ""}
        ${unavailable || s.message ? `<p class="subtle layer-msg">${icon(unavailable ? "alert" : "info", { size: 14 })} ${escapeHTML(s.message || t("common.notAvailable"))}</p>` : ""}
      </div>`;
    }).join("");
  }

  ui.layerList.addEventListener("change", (event) => {
    const input = event.target.closest("[data-layer]");
    if (input) state.engine?.setLayer(input.dataset.layer, input.checked);
  });
  container.addEventListener("click", (event) => {
    const why = event.target.closest("[data-why]");
    if (why && !ui.drawer.contains(why)) EXPLAIN[why.dataset.why]?.();
  });

  // ------------------------------------------------------------ rain markers
  function rainRows() {
    const munis = state.overview?.municipalities || [];
    return munis.map((m) => {
      if (state.mode === "hour") {
        const p = m.series?.[state.hour];
        const mm = p?.precipitation_mm;
        return {
          name: m.name, point: m.point, level: p?.level || "nodata",
          levelText: levelLabel(p?.level || "nodata", getLang()),
          modeText: hourLabel(p?.time, state.hour),
          valueText: isNumber(mm) ? `${num(mm, 1)} mm/h` : "—",
          labelText: `${levelLabel(p?.level || "nodata", getLang())}, ${isNumber(mm) ? `${num(mm, 1)} mm per hour` : "no data"}`,
        };
      }
      const w = m.windows?.next_24h || {};
      return {
        name: m.name, point: m.point, level: m.level_24h,
        levelText: levelLabel(m.level_24h, getLang()),
        modeText: t("map.hoverPeak"),
        valueText: isNumber(w.peak_mm_h) ? `${num(w.peak_mm_h, 1)} mm/h` : "—",
        labelText: `${levelLabel(m.level_24h, getLang())}, peak ${isNumber(w.peak_mm_h) ? `${num(w.peak_mm_h, 1)} mm per hour` : "not available"} in the next 24 hours`,
      };
    });
  }

  function updateRain() {
    if (!state.engine) return;
    if (state.overviewError) {
      state.engine.setRain([], false, state.overviewError.message);
      ui.rainStatus.textContent = state.overviewError.message;
      ui.timeLabel.textContent = "";
      ui.handleSummary.textContent = t("common.notAvailable");
      return;
    }
    if (!state.overview) return;
    state.engine.setRain(rainRows(), true, "");
    const steps = state.overview.municipalities?.[0]?.series || [];
    ui.slider.max = String(Math.max(0, steps.length - 1));
    ui.timeLabel.textContent = state.mode === "hour"
      ? hourLabel(steps[state.hour]?.time, state.hour)
      : t("map.peakLabel");
    ui.rainStatus.textContent = `${t("common.updated")} ${formatTime(state.overview.generated_at)} · Open-Meteo · ${t("common.notOfficial")}`;
    const warn = (state.overview.municipalities || []).filter((m) => ["yellow", "orange", "red"].includes(m.level_24h)).length;
    ui.handleSummary.textContent = warn ? t("map.summaryWarn", { n: warn }) : levelLabel(state.overview.highest_level_24h, getLang());
  }

  async function loadOverview() {
    try {
      state.overview = await getJSON("/api/overview?hours=48", { ttlMs: OVERVIEW_TTL, timeoutMs: 30000 });
      state.overviewError = null;
    } catch (error) {
      state.overviewError = error;
    }
    if (state.alive) updateRain();
  }

  async function loadCenters() {
    try {
      const data = await getJSON("/api/evacuation-centers", { ttlMs: OVERVIEW_TTL });
      state.centers = data.centers || [];
      state.engine?.setCenters(state.centers, true, data.note ? "" : "");
    } catch (error) {
      state.engine?.setCenters([], false, error.message);
    }
  }

  async function loadReports() {
    try {
      const data = await getJSON("/reports", { ttlMs: 60000 });
      state.reports = (data.reports || []).filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
      const message = (data.reports || []).length > state.reports.length ? t("map.reportsNoLocation") : "";
      state.engine?.setReports(state.reports, true, message);
    } catch (error) {
      state.engine?.setReports([], false, error.message);
    }
  }

  // ------------------------------------------------------------ mode / time
  container.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    container.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    ui.hourControls.hidden = state.mode !== "hour";
    stopPlay();
    updateRain();
  }));
  ui.slider.addEventListener("input", () => {
    state.hour = Number(ui.slider.value);
    updateRain();
  });
  function stopPlay() {
    clearInterval(state.playTimer);
    state.playTimer = null;
    ui.play.innerHTML = icon("play", { size: 16 });
    ui.play.setAttribute("aria-label", t("map.play"));
  }
  ui.play.addEventListener("click", () => {
    if (state.playTimer) return stopPlay();
    ui.play.innerHTML = icon("pause", { size: 16 });
    ui.play.setAttribute("aria-label", t("map.pause"));
    state.playTimer = setInterval(() => {
      const max = Number(ui.slider.max);
      state.hour = state.hour >= max ? 0 : state.hour + 1;
      ui.slider.value = String(state.hour);
      updateRain();
    }, 800);
  });

  // ------------------------------------------------------------ drawer
  function openDrawer(titleHTML, bodyHTML) {
    state.drawerCleanup?.();
    state.drawerCleanup = null;
    ui.drawerTitle.innerHTML = titleHTML;
    ui.drawerBody.innerHTML = bodyHTML;
    ui.drawer.hidden = false;
    setSheet(false);
    ui.view.classList.add("has-drawer");
    ui.drawerBody.scrollTop = 0;
  }

  function closeDrawer() {
    state.drawerCleanup?.();
    state.drawerCleanup = null;
    ui.drawer.hidden = true;
    ui.view.classList.remove("has-drawer");
    state.selected = null;
    state.engine?.select(null);
    history.replaceState(null, "", buildHash("map"));
  }
  ui.drawerClose.addEventListener("click", closeDrawer);

  // Phone bottom sheet: tap the grip to switch between half and full height;
  // swipe up to expand, swipe down to collapse (or close when already half).
  function setSheet(expanded) {
    ui.drawer.classList.toggle("is-expanded", expanded);
    ui.drawerGrip.setAttribute("aria-expanded", String(expanded));
    ui.drawerGrip.setAttribute("aria-label", t(expanded ? "map.sheetCollapse" : "map.sheetExpand"));
  }
  let gripStart = null;
  ui.drawerGrip.addEventListener("pointerdown", (event) => { gripStart = event.clientY; });
  ui.drawerGrip.addEventListener("pointerup", (event) => {
    const dy = gripStart === null ? 0 : event.clientY - gripStart;
    gripStart = null;
    const expanded = ui.drawer.classList.contains("is-expanded");
    if (dy < -30) setSheet(true);
    else if (dy > 30) { if (expanded) setSheet(false); else closeDrawer(); }
    else setSheet(!expanded);
  });
  ui.drawerGrip.addEventListener("pointercancel", () => { gripStart = null; });
  // Keyboard (Enter/Space) arrives as a click with no pointer movement.
  ui.drawerGrip.addEventListener("click", (event) => { if (event.detail === 0) setSheet(!ui.drawer.classList.contains("is-expanded")); });
  container.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !ui.drawer.hidden) closeDrawer();
  });

  async function selectMunicipality(name, { fly = true } = {}) {
    const muni = state.overview?.municipalities?.find((m) => m.name.toLowerCase() === name.toLowerCase());
    const canonical = muni?.name || name;
    state.selected = canonical;
    state.engine?.select(canonical);
    if (fly && muni?.point) state.engine?.flyTo(muni.point.longitude, muni.point.latitude, 10.6);
    history.replaceState(null, "", buildHash("map", [], { m: canonical }));
    const token = ++state.detailToken;
    openDrawer(`<span class="eyebrow">${escapeHTML(t("common.municipality"))}</span><h2>${escapeHTML(canonical)}</h2>`, loadingState());
    try {
      const data = await getJSON(`/api/municipalities/${encodeURIComponent(canonical)}`, { ttlMs: 5 * 60 * 1000, timeoutMs: 30000 });
      if (!state.alive || token !== state.detailToken) return;
      const reports = { status: "ok", data: state.reports.filter((r) => String(r.municipality || "").toLowerCase() === canonical.toLowerCase()) };
      ui.drawerBody.innerHTML = renderDetail(data, { reports, collapsible: true, banner: true });
      state.drawerCleanup = hydrateDetail(ui.drawerBody, data);
    } catch (error) {
      if (!state.alive || token !== state.detailToken) return;
      ui.drawerBody.innerHTML = errorState(error);
      onRetry(ui.drawerBody, () => selectMunicipality(canonical, { fly: false }));
    }
  }

  function selectCenter(center) {
    state.selected = null;
    state.engine?.select(null);
    if (center.has_coordinates) state.engine?.flyTo(center.longitude, center.latitude, 12.5);
    openDrawer(
      `<span class="eyebrow">${escapeHTML(t("detail.center"))}</span><h2>${escapeHTML(center.name)}</h2><span class="badge badge-warning">${escapeHTML(t("common.unverified"))}</span>`,
      `<section class="detail-section">
        <dl class="kv">
          <dt>${escapeHTML(t("common.municipality"))}</dt><dd>${escapeHTML(center.municipality || "—")}</dd>
          <dt>${escapeHTML(t("detail.capacity"))}</dt><dd>${escapeHTML(isNumber(center.capacity) ? String(center.capacity) : t("common.notAvailable"))}</dd>
          <dt>${escapeHTML(t("detail.status"))}</dt><dd>${escapeHTML(center.operating_status || t("common.notAvailable"))}</dd>
        </dl>
        <div class="notice notice-warning" style="margin-top:12px">${icon("alert", { size: 18 })}<div>${escapeHTML(t("detail.centerWarning"))}</div></div>
        ${center.google_maps_url ? `<a class="btn btn-primary btn-block" style="margin-top:12px" href="${escapeHTML(center.google_maps_url)}" target="_blank" rel="noopener noreferrer">${icon("navigation", { size: 16 })} ${escapeHTML(t("detail.directions"))}</a>` : ""}
        <p class="source-line" style="margin-top:12px">${escapeHTML(t("detail.centerSource"))}</p>
      </section>`);
  }

  function selectReport(report) {
    state.selected = null;
    state.engine?.select(null);
    openDrawer(
      `<span class="eyebrow">${escapeHTML(t("detail.report"))}</span><h2>${escapeHTML(report.barangay || report.location || "")}</h2><span class="badge badge-warning">${escapeHTML(t("common.unverified"))}</span>`,
      `<section class="detail-section">
        <dl class="kv">
          <dt>${escapeHTML(t("common.municipality"))}</dt><dd>${escapeHTML(report.municipality || "—")}</dd>
          <dt>${escapeHTML(t("detail.severity"))}</dt><dd>${escapeHTML(report.severity || "—")}</dd>
          <dt>${escapeHTML(t("detail.depth"))}</dt><dd>${escapeHTML(isNumber(report.water_level_cm) ? `${report.water_level_cm} cm (${t("detail.estimate")})` : t("common.notAvailable"))}</dd>
          <dt>${escapeHTML(t("detail.observed"))}</dt><dd>${escapeHTML(formatTime(report.reported_at))}</dd>
        </dl>
        ${report.description ? `<p style="margin-top:12px">${escapeHTML(report.description)}</p>` : ""}
        <p class="source-line" style="margin-top:12px">${escapeHTML(t("detail.reportSource"))} · ${escapeHTML(relativeTime(report.submitted_at || report.reported_at))}</p>
      </section>`);
  }

  // ------------------------------------------------------------ typhoon from an article
  function typhoonLabel(ty) {
    const name = ty.storm?.name || t("typhoon.unnamed");
    return ty.storm?.category ? t("typhoon.label", { category: ty.storm.category, name }) : name;
  }

  /** Article dates keep the year (an article may be from a past season); unparsed text is shown as written. */
  function articleDate(value) {
    const date = parseTime(value);
    return date
      ? date.toLocaleString("en-PH", { timeZone: PH_TZ, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : String(value);
  }

  function kmh(field) {
    return field ? `${field.value} km/h` : t("common.notAvailable");
  }

  function selectTyphoon(ty = state.typhoon) {
    if (!ty) return;
    state.selected = null;
    state.engine?.select(null);
    const p = ty.position;
    const rel = p?.relative;
    let position = escapeHTML(t("common.notAvailable"));
    if (p) {
      const coords = `${num(p.latitude, 2)}°N, ${num(p.longitude, 2)}°E`;
      const how = p.method === "coordinates"
        ? t("typhoon.posCoords")
        : t("typhoon.posRelative", {
          km: num(rel.distance_km, 0), dir: rel.direction, place: rel.place,
          match: [p.geocode?.name, p.geocode?.admin1].filter(Boolean).join(", "),
        });
      position = `<span class="num">${escapeHTML(coords)}</span><br><span class="subtle">${escapeHTML(how)}</span>`;
    }
    const m = ty.movement;
    const movement = !m ? t("common.notAvailable")
      : m.stationary ? t("typhoon.stationary")
      : isNumber(m.speed_kmh) ? `${m.direction} · ${m.speed_kmh} km/h` : m.direction;
    const radius = ty.radius_km ? `${num(ty.radius_km.value, 0)} km (${ty.radius_km.basis})` : t("typhoon.radiusNone");
    const evidence = [
      [t("typhoon.category"), ty.storm], [t("typhoon.position"), p], [t("typhoon.maxWind"), ty.max_wind_kmh],
      [t("typhoon.gust"), ty.gust_kmh], [t("typhoon.movement"), m], [t("typhoon.radius"), ty.radius_km],
      [t("typhoon.pressure"), ty.pressure_hpa], [t("typhoon.bulletinTime"), ty.bulletin_time],
    ].filter(([, field]) => field?.evidence);
    const seen = new Set();
    const quotes = evidence.filter(([, field]) => !seen.has(field.evidence) && seen.add(field.evidence));
    const article = ty.article || {};
    const link = /^https?:\/\//.test(ty.final_url || "") ? ty.final_url : null;

    openDrawer(
      `<span class="eyebrow">${escapeHTML(t("typhoon.eyebrow"))}</span><h2>${escapeHTML(ty.storm?.name || t("typhoon.unnamed"))}</h2><span class="badge badge-warning">${escapeHTML(t("common.unverified"))}</span>`,
      `<section class="detail-section">
        <dl class="kv">
          <dt>${escapeHTML(t("typhoon.category"))}</dt><dd>${escapeHTML(ty.storm?.category || t("common.notAvailable"))}${ty.storm?.international_name ? ` (${escapeHTML(ty.storm.international_name)})` : ""}</dd>
          <dt>${escapeHTML(t("typhoon.position"))}</dt><dd>${position}</dd>
          <dt>${escapeHTML(t("typhoon.maxWind"))}</dt><dd>${escapeHTML(kmh(ty.max_wind_kmh))}</dd>
          <dt>${escapeHTML(t("typhoon.gust"))}</dt><dd>${escapeHTML(kmh(ty.gust_kmh))}</dd>
          <dt>${escapeHTML(t("typhoon.movement"))}</dt><dd>${escapeHTML(movement)}</dd>
          <dt>${escapeHTML(t("typhoon.radius"))}</dt><dd>${escapeHTML(radius)}</dd>
          <dt>${escapeHTML(t("typhoon.pressure"))}</dt><dd>${escapeHTML(ty.pressure_hpa ? `${ty.pressure_hpa.value} hPa` : t("common.notAvailable"))}</dd>
          <dt>${escapeHTML(t("typhoon.bulletinTime"))}</dt><dd>${escapeHTML(ty.bulletin_time?.text || t("common.notAvailable"))}</dd>
        </dl>
        ${!p && ty.position_note ? `<p class="subtle" style="margin-top:8px">${escapeHTML(ty.position_note)}</p>` : ""}
        <div class="notice notice-warning" style="margin-top:12px">${icon("alert", { size: 18 })}<div>${escapeHTML(t("typhoon.warning"))}</div></div>
      </section>
      ${quotes.length ? `<section class="detail-section">
        <h3>${escapeHTML(t("typhoon.evidence"))}</h3>
        <ul class="typhoon-quotes">${quotes.map(([label, field]) => `<li><span class="subtle">${escapeHTML(label)}</span><blockquote>${escapeHTML(field.evidence)}</blockquote></li>`).join("")}</ul>
      </section>` : ""}
      <section class="detail-section">
        <dl class="kv">
          <dt>${escapeHTML(t("typhoon.article"))}</dt><dd>${link ? `<a href="${escapeHTML(link)}" target="_blank" rel="noopener noreferrer">${escapeHTML(article.title || article.site || link)}</a>` : escapeHTML(article.title || "—")}</dd>
          ${article.published ? `<dt>${escapeHTML(t("typhoon.published"))}</dt><dd>${escapeHTML(articleDate(article.published))}</dd>` : ""}
        </dl>
        <p class="source-line" style="margin-top:12px">${escapeHTML(t("typhoon.source", { time: formatTime(ty.fetched_at) }))} · <a href="#/sources?s=typhoon-article">${escapeHTML(t("explain.details"))}</a></p>
      </section>`);
  }

  ui.tyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const url = ui.tyUrl.value.trim();
    if (!/^https?:\/\/\S+\.\S+/i.test(url)) {
      ui.tyStatus.textContent = t("typhoon.badUrl");
      ui.tyUrl.focus();
      return;
    }
    ui.tyRead.disabled = true;
    ui.tyStatus.textContent = t("typhoon.reading");
    try {
      const data = await getJSON(`/api/typhoon/from-url?url=${encodeURIComponent(url)}`, { timeoutMs: 45000 });
      if (!state.alive) return;
      if (!data.found) {
        ui.tyStatus.textContent = t("typhoon.notFound");
        return;
      }
      state.typhoon = data;
      ui.tyActions.hidden = false;
      state.engine?.setTyphoon(data.position ? data : null, typhoonLabel(data));
      ui.tyStatus.textContent = data.position
        ? t("typhoon.shown", { name: typhoonLabel(data) })
        : t("typhoon.noPosition", { note: data.position_note || "" });
      selectTyphoon(data);
    } catch (error) {
      if (state.alive) ui.tyStatus.textContent = error.message;
    } finally {
      ui.tyRead.disabled = false;
    }
  });
  ui.tyDetails.addEventListener("click", () => selectTyphoon());
  ui.tyRemove.addEventListener("click", () => {
    state.typhoon = null;
    state.engine?.clearTyphoon();
    ui.tyActions.hidden = true;
    ui.tyStatus.textContent = "";
    ui.tyUrl.value = "";
    if (ui.drawerTitle.textContent.includes(t("typhoon.eyebrow"))) closeDrawer();
  });

  // ------------------------------------------------------------ search
  function searchItems(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const munis = (state.overview?.municipalities || []).map((m) => ({ type: "municipality", name: m.name, sub: t("common.municipality") }));
    const centers = state.centers.map((c) => ({ type: "center", name: c.name, sub: `${t("detail.center")} · ${c.municipality}`, center: c }));
    return [...munis, ...centers].filter((item) => item.name.toLowerCase().includes(q)).slice(0, 8);
  }
  let results = [];
  let active = -1;
  function renderResults() {
    ui.results.hidden = !results.length;
    ui.search.setAttribute("aria-expanded", String(results.length > 0));
    ui.results.innerHTML = results.map((item, i) => `<li role="option" id="sr-${i}" aria-selected="${i === active}" data-i="${i}"><strong>${escapeHTML(item.name)}</strong><span class="subtle">${escapeHTML(item.sub)}</span></li>`).join("");
    if (active >= 0) ui.search.setAttribute("aria-activedescendant", `sr-${active}`);
    else ui.search.removeAttribute("aria-activedescendant");
  }
  function choose(item) {
    if (!item) return;
    ui.search.value = "";
    results = [];
    active = -1;
    renderResults();
    ui.left.classList.remove("is-open");
    ui.leftHandle.setAttribute("aria-expanded", "false");
    if (item.type === "municipality") selectMunicipality(item.name);
    else selectCenter(item.center);
  }
  ui.search.addEventListener("input", () => {
    results = searchItems(ui.search.value);
    active = results.length ? 0 : -1;
    renderResults();
  });
  ui.search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { active = Math.min(results.length - 1, active + 1); renderResults(); event.preventDefault(); }
    if (event.key === "ArrowUp") { active = Math.max(0, active - 1); renderResults(); event.preventDefault(); }
    if (event.key === "Enter") { choose(results[active]); event.preventDefault(); }
    if (event.key === "Escape") { results = []; renderResults(); }
  });
  ui.results.addEventListener("click", (event) => {
    const li = event.target.closest("[data-i]");
    if (li) choose(results[Number(li.dataset.i)]);
  });

  // ------------------------------------------------------------ locate
  ui.locate.addEventListener("click", () => {
    if (!navigator.geolocation) return toastLocal(t("map.locateUnsupported"));
    ui.locate.disabled = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      ui.locate.disabled = false;
      const here = [pos.coords.longitude, pos.coords.latitude];
      state.engine?.showUser(here[0], here[1]);
      const munis = state.overview?.municipalities || [];
      const nearest = munis.filter((m) => m.point).map((m) => ({ m, km: distanceKm(here, [m.point.longitude, m.point.latitude]) })).sort((a, b) => a.km - b.km)[0];
      if (nearest && nearest.km < 40) {
        selectMunicipality(nearest.m.name, { fly: false });
        state.engine?.flyTo(here[0], here[1], 11.5);
        toastLocal(t("map.nearestTown", { name: nearest.m.name, km: num(nearest.km, 1) }));
      } else {
        state.engine?.flyTo(here[0], here[1], 10);
        toastLocal(t("map.outsideBataan"));
      }
    }, () => {
      ui.locate.disabled = false;
      toastLocal(t("map.locateDenied"));
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  });

  async function toastLocal(message) {
    const { toast } = await import("../core/ui.js");
    toast(message);
  }

  // ------------------------------------------------------------ mobile sheet
  ui.leftHandle.addEventListener("click", () => {
    const open = !ui.left.classList.contains("is-open");
    ui.left.classList.toggle("is-open", open);
    ui.leftHandle.setAttribute("aria-expanded", String(open));
  });

  // ------------------------------------------------------------ start
  const onTheme = (event) => state.engine?.setTheme(event.detail.theme);
  document.addEventListener("agos:theme", onTheme);

  const overviewPromise = loadOverview();
  renderLayers({});

  try {
    state.engine = await createAgosMap(ui.canvas, {
      theme: effectiveTheme(),
      onSelectMunicipality: (name) => selectMunicipality(name),
      onSelectCenter: selectCenter,
      onSelectReport: selectReport,
      onSelectTyphoon: () => selectTyphoon(),
      onLayerState: (states) => state.alive && renderLayers(states),
    });
  } catch (error) {
    ui.loading.innerHTML = errorState(error, { retry: false });
    ui.layerList.querySelectorAll("input").forEach((input) => { input.disabled = true; });
    ui.rainStatus.textContent = t("map.noMapHint");
    return () => { state.alive = false; document.removeEventListener("agos:theme", onTheme); };
  }
  if (!state.alive) {
    state.engine.destroy();
    return undefined;
  }
  ui.basemap.textContent = state.engine.basemap.name;
  await state.engine.ready;
  ui.loading.remove();
  await overviewPromise;
  updateRain();
  loadCenters();
  loadReports();

  if (route.query.m) selectMunicipality(route.query.m);
  state.refreshTimer = setInterval(loadOverview, OVERVIEW_TTL);

  return () => {
    state.alive = false;
    stopPlay();
    clearInterval(state.refreshTimer);
    state.drawerCleanup?.();
    document.removeEventListener("agos:theme", onTheme);
    state.engine?.destroy();
  };
}
