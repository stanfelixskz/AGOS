/* Municipality page: everything AGOS knows about one town, shareable by URL. */

import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { getJSON } from "../core/api.js";
import { escapeHTML, formatTime } from "../core/format.js";
import { buildHash, navigate } from "../core/router.js";
import { loadingState, errorState, onRetry, toast } from "../core/ui.js";
import { renderDetail, hydrateDetail, levelPill } from "./parts/muni-detail.js";

const TOWNS = ["Abucay", "Bagac", "Balanga", "Dinalupihan", "Hermosa", "Limay", "Mariveles", "Morong", "Orani", "Orion", "Pilar", "Samal"];

export async function mount(container, route) {
  const requested = route.params[0];
  if (!requested) {
    navigate("overview");
    return undefined;
  }
  let alive = true;
  let cleanup = null;

  async function load() {
    container.innerHTML = `<div class="card">${loadingState()}</div>`;
    let data;
    let reports = null;
    try {
      data = await getJSON(`/api/municipalities/${encodeURIComponent(requested)}`, { ttlMs: 5 * 60 * 1000, timeoutMs: 30000 });
    } catch (error) {
      if (!alive) return;
      container.innerHTML = `<div class="card">${errorState(error, { retry: error.status !== 404 })}</div>`;
      onRetry(container, load);
      return;
    }
    try {
      const all = await getJSON("/reports", { ttlMs: 60000 });
      reports = { status: "ok", data: (all.reports || []).filter((r) => String(r.municipality || "").toLowerCase() === data.name.toLowerCase()) };
    } catch (error) {
      reports = { status: "unavailable", detail: error.message };
    }
    if (!alive) return;

    const level = data.rain?.status === "ok" ? data.rain.data.level_24h : "nodata";
    container.innerHTML = `
      <div class="page-head">
        <div>
          <div class="eyebrow">${escapeHTML(t("common.municipality"))} · Bataan</div>
          <h1>${escapeHTML(data.name)}</h1>
          <div class="row" style="margin-top:8px">${levelPill(level)}<span class="subtle">${escapeHTML(t("muni.point", { lat: data.point.latitude, lon: data.point.longitude }))}</span></div>
        </div>
        <div class="row">
          <label class="visually-hidden" for="townSwitch">${escapeHTML(t("muni.switch"))}</label>
          <select class="select" id="townSwitch" style="width:auto">${TOWNS.map((n) => `<option ${n === data.name ? "selected" : ""}>${n}</option>`).join("")}</select>
          <a class="btn" href="${buildHash("map", [], { m: data.name })}">${icon("map", { size: 16 })} ${escapeHTML(t("common.openMap"))}</a>
          <button class="btn btn-ghost btn-icon" type="button" id="shareBtn" aria-label="${escapeHTML(t("muni.share"))}">${icon("share", { size: 18 })}</button>
        </div>
      </div>
      <div class="card detail-page">${renderDetail(data, { reports, showOpenPage: false })}</div>
      <p class="subtle" style="margin-top:var(--space-3)">${escapeHTML(t("muni.generated", { time: formatTime(data.generated_at) }))}</p>`;

    cleanup = hydrateDetail(container, data);
    container.querySelector("#townSwitch").addEventListener("change", (event) => navigate("municipality", [event.target.value]));
    container.querySelector("#shareBtn").addEventListener("click", async () => {
      const url = location.href;
      try {
        if (navigator.share) await navigator.share({ title: `AGOS · ${data.name}`, url });
        else {
          await navigator.clipboard.writeText(url);
          toast(t("muni.copied"));
        }
      } catch {
        /* user cancelled sharing */
      }
    });
  }

  await load();
  return () => {
    alive = false;
    cleanup?.();
  };
}
