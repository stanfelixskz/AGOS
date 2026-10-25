/*
 * Evacuate: find the nearest listed evacuation center.
 * One dataset (/api/evacuation-centers) shared with the map. Distances are
 * straight-line, not road distance. Every center is marked unverified.
 */

import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { getJSON } from "../core/api.js";
import { escapeHTML, num, distanceKm, isNumber } from "../core/format.js";
import { effectiveTheme } from "../core/theme.js";
import { loadingState, errorState, onRetry } from "../core/ui.js";
import { EXPLAIN } from "../core/explain.js";
import { directionsUrl, renderCenterDetail, hydrateCenterDetail } from "./parts/center-detail.js";

export async function mount(container) {
  const state = { alive: true, centers: [], here: null, query: "", town: "", engine: null, selected: null };

  container.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">${escapeHTML(t("evac.eyebrow"))}</div>
        <h1>${escapeHTML(t("title.evacuate"))}</h1>
        <p>${escapeHTML(t("evac.intro"))}</p>
      </div>
    </div>

    <div class="notice notice-danger" style="margin-bottom:var(--space-4)">
      ${icon("phone")}
      <div><strong>${escapeHTML(t("evac.emergencyTitle"))}</strong> ${escapeHTML(t("evac.emergencyBody"))}</div>
    </div>

    <div class="evac-layout">
      <section class="card evac-list-card" aria-labelledby="evacListTitle">
        <div class="card-head">
          <div><h2 id="evacListTitle">${escapeHTML(t("evac.listTitle"))}</h2><p id="evacCount"></p></div>
          <button class="why" type="button" data-why aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>
        </div>
        <button class="btn btn-primary btn-block" type="button" id="evacLocate">${icon("locate", { size: 18 })} ${escapeHTML(t("evac.findNearest"))}</button>
        <p class="subtle" id="evacLocateStatus" role="status" aria-live="polite" style="margin-top:6px"></p>
        <div class="evac-filters">
          <label class="field"><span>${escapeHTML(t("evac.search"))}</span><input class="input" type="search" id="evacSearch" autocomplete="off" placeholder="${escapeHTML(t("evac.searchPlaceholder"))}"></label>
          <label class="field"><span>${escapeHTML(t("common.municipality"))}</span><select class="select" id="evacTown"><option value="">${escapeHTML(t("common.allMunicipalities"))}</option></select></label>
        </div>
        <ul class="list evac-list" id="evacList">${loadingState()}</ul>
      </section>

      <section class="card evac-map-card" aria-label="${escapeHTML(t("evac.mapLabel"))}">
        <div class="evac-map" id="evacMap"><div class="map-loading">${loadingState(t("map.loading"))}</div></div>
        <p class="subtle" style="margin-top:8px">${escapeHTML(t("evac.mapNote"))}</p>
        <div id="evacDetail" class="evac-detail" aria-live="polite"></div>
      </section>
    </div>`;

  const $ = (sel) => container.querySelector(sel);
  const listEl = $("#evacList");

  function rows() {
    const q = state.query.trim().toLowerCase();
    return state.centers
      .filter((c) => !state.town || c.municipality === state.town)
      .filter((c) => !q || `${c.name} ${c.municipality}`.toLowerCase().includes(q))
      .map((c) => ({ ...c, km: state.here && c.has_coordinates ? distanceKm(state.here, [c.longitude, c.latitude]) : null }))
      .sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9) || a.municipality.localeCompare(b.municipality));
  }

  function renderList() {
    const list = rows();
    $("#evacCount").textContent = t("evac.count", { n: list.length, all: state.centers.length });
    if (!list.length) {
      listEl.innerHTML = `<li class="state">${icon("search", { size: 24 })}<span>${escapeHTML(t("evac.none"))}</span></li>`;
      return;
    }
    listEl.innerHTML = list.map((c, i) => {
      const url = directionsUrl(c, state.here);
      return `<li class="evac-item${state.selected === c.id ? " is-selected" : ""}" data-id="${escapeHTML(c.id)}">
        <div class="evac-item-main">
          <div class="row" style="gap:8px">
            ${state.here && i === 0 && isNumber(c.km) ? `<span class="badge badge-brand">${escapeHTML(t("evac.nearest"))}</span>` : ""}
            <span class="badge badge-warning">${escapeHTML(t("common.unverified"))}</span>
          </div>
          <button class="evac-name" type="button" data-focus="${escapeHTML(c.id)}">${escapeHTML(c.name)}</button>
          <div class="subtle">${escapeHTML(c.municipality)}${isNumber(c.km) ? ` · <span class="num">${escapeHTML(num(c.km, 1))} km</span> ${escapeHTML(t("evac.straightLine"))}` : ""}</div>
          <div class="subtle">${escapeHTML(t("detail.capacity"))}: ${escapeHTML(isNumber(c.capacity) ? String(c.capacity) : t("evac.notProvided"))} · ${escapeHTML(t("detail.status"))}: ${escapeHTML(c.operating_status || t("evac.notProvided"))}</div>
        </div>
        ${url ? `<a class="btn btn-sm" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${icon("navigation", { size: 16 })}<span class="hide-sm">${escapeHTML(t("detail.directions"))}</span></a>` : ""}
      </li>`;
    }).join("");
  }

  /** Select one center: pin, list row and the detail card under the map stay in step. */
  function selectCenter(center, { fly = true, scrollList = false } = {}) {
    state.selected = center?.id || null;
    state.engine?.selectCenter(state.selected);
    if (center?.has_coordinates && fly) state.engine?.flyTo(center.longitude, center.latitude, 13);
    renderList();
    const detail = $("#evacDetail");
    if (!center) {
      detail.innerHTML = "";
      return;
    }
    detail.innerHTML = `<h3 class="evac-detail-title">${escapeHTML(center.name)} <span class="badge badge-warning">${escapeHTML(t("common.unverified"))}</span></h3>${renderCenterDetail(center, { all: state.centers, here: state.here })}`;
    hydrateCenterDetail(detail, { onPick: (id) => selectCenter(state.centers.find((c) => c.id === id), { scrollList: true }) });
    if (scrollList) listEl.querySelector(`[data-id="${CSS.escape(center.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  listEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-focus]");
    if (!button) return;
    selectCenter(state.centers.find((c) => c.id === button.dataset.focus));
    if (window.matchMedia("(max-width: 960px)").matches) $("#evacMap").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  $("#evacSearch").addEventListener("input", (e) => { state.query = e.target.value; renderList(); });
  $("#evacTown").addEventListener("change", (e) => { state.town = e.target.value; renderList(); });
  container.querySelector("[data-why]").addEventListener("click", () => EXPLAIN.evacuation());

  $("#evacLocate").addEventListener("click", () => {
    const status = $("#evacLocateStatus");
    if (!navigator.geolocation) { status.textContent = t("map.locateUnsupported"); return; }
    status.textContent = t("evac.locating");
    navigator.geolocation.getCurrentPosition((pos) => {
      state.here = [pos.coords.longitude, pos.coords.latitude];
      state.town = "";
      $("#evacTown").value = "";
      status.textContent = t("evac.located", { acc: Math.round(pos.coords.accuracy) });
      state.engine?.showUser(state.here[0], state.here[1]);
      state.engine?.flyTo(state.here[0], state.here[1], 11.5);
      renderList();
    }, () => {
      status.textContent = t("map.locateDenied");
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 120000 });
  });

  async function load() {
    try {
      const data = await getJSON("/api/evacuation-centers", { ttlMs: 10 * 60 * 1000 });
      if (!state.alive) return;
      state.centers = data.centers || [];
      const towns = [...new Set(state.centers.map((c) => c.municipality))].sort();
      $("#evacTown").insertAdjacentHTML("beforeend", towns.map((n) => `<option>${escapeHTML(n)}</option>`).join(""));
      renderList();
      state.engine?.setCenters(state.centers);
    } catch (error) {
      if (!state.alive) return;
      listEl.innerHTML = `<li>${errorState(error)}</li>`;
      onRetry(listEl, load);
    }
  }

  await load();

  // The map is optional: the list works even if MapLibre cannot load.
  const mapEl = $("#evacMap");
  try {
    const { createAgosMap } = await import("../map/engine.js");
    state.engine = await createAgosMap(mapEl, {
      theme: effectiveTheme(),
      cooperative: true,
      onSelectCenter: (center) => selectCenter(center, { fly: false, scrollList: true }),
    });
    if (!state.alive) { state.engine.destroy(); return undefined; }
    await state.engine.ready;
    mapEl.querySelector(".map-loading")?.remove();
    state.engine.setLayer("rain", false);
    state.engine.setLayer("reports", false);
    state.engine.setCenters(state.centers);
  } catch (error) {
    if (state.alive) mapEl.innerHTML = `<div class="state">${icon("map", { size: 28 })}<span>${escapeHTML(error.message)}</span></div>`;
  }

  return () => {
    state.alive = false;
    state.engine?.destroy();
  };
}
