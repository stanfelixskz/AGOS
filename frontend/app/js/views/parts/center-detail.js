/*
 * Evacuation center detail, shared by the map drawer and the Evacuate page.
 * Only fields that exist in the data are shown. There is no street address in
 * the list, so none is shown; capacity and status are "not provided".
 * Distances are straight-line, not road distance.
 */

import { icon } from "../../core/icons.js";
import { t } from "../../core/i18n.js";
import { escapeHTML, num, distanceKm, isNumber } from "../../core/format.js";
import { toast } from "../../core/ui.js";

export function directionsUrl(center, here) {
  if (!center.has_coordinates) return center.google_maps_url || null;
  const params = new URLSearchParams({ api: "1", destination: `${center.latitude},${center.longitude}` });
  if (here) params.set("origin", `${here[1]},${here[0]}`);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function coordinateText(center) {
  return center.has_coordinates ? `${center.latitude.toFixed(5)}, ${center.longitude.toFixed(5)}` : "";
}

/** The `limit` closest other listed centers, straight-line. */
export function nearbyCenters(center, all, limit = 3) {
  if (!center.has_coordinates) return [];
  return all
    .filter((c) => c.id !== center.id && c.has_coordinates)
    .map((c) => ({ c, km: distanceKm([center.longitude, center.latitude], [c.longitude, c.latitude]) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, limit);
}

export function renderCenterDetail(center, { all = [], here = null } = {}) {
  const fromYou = here && center.has_coordinates ? distanceKm(here, [center.longitude, center.latitude]) : null;
  const url = directionsUrl(center, here);
  const coords = coordinateText(center);
  const nearby = nearbyCenters(center, all);
  return `<div class="center-detail">
    <div class="notice notice-warning">${icon("alert", { size: 18 })}<div>${escapeHTML(t("detail.centerWarning"))}</div></div>
    <dl class="kv">
      <dt>${escapeHTML(t("common.municipality"))}</dt><dd>${escapeHTML(center.municipality || "—")}</dd>
      <dt>${escapeHTML(t("detail.capacity"))}</dt><dd>${escapeHTML(isNumber(center.capacity) ? String(center.capacity) : t("evac.notProvided"))}</dd>
      <dt>${escapeHTML(t("detail.status"))}</dt><dd>${escapeHTML(center.operating_status || t("evac.notProvided"))}</dd>
      ${coords ? `<dt>${escapeHTML(t("detail.coords"))}</dt><dd class="num">${escapeHTML(coords)}</dd>` : ""}
      ${isNumber(fromYou) ? `<dt>${escapeHTML(t("detail.fromYou"))}</dt><dd><span class="num">${escapeHTML(num(fromYou, 1))} km</span> ${escapeHTML(t("evac.straightLine"))}</dd>` : ""}
    </dl>
    <div class="center-actions">
      ${url ? `<a class="btn btn-primary" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${icon("navigation", { size: 16 })} ${escapeHTML(t("detail.directions"))}</a>` : ""}
      ${coords ? `<button class="btn" type="button" data-copy="${escapeHTML(coords)}">${icon("copy", { size: 16 })} ${escapeHTML(t("detail.copyCoords"))}</button>` : ""}
    </div>
    ${nearby.length ? `<div class="center-nearby">
      <h4>${escapeHTML(t("detail.nearbyCenters"))}</h4>
      <ul class="list">${nearby.map(({ c, km }) => `<li><button class="evac-name" type="button" data-pick="${escapeHTML(c.id)}">${escapeHTML(c.name)}</button>
        <div class="subtle">${escapeHTML(c.municipality)} · <span class="num">${escapeHTML(num(km, 1))} km</span> ${escapeHTML(t("evac.straightLine"))}</div></li>`).join("")}</ul>
    </div>` : ""}
    <p class="source-line">${escapeHTML(t("detail.centerSource"))} ${escapeHTML(t("detail.coordsNote"))}</p>
  </div>`;
}

/** Wire the copy button and the "other centers" list. onPick(id) selects another center. */
export function hydrateCenterDetail(root, { onPick } = {}) {
  root.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
    const text = button.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
      toast(t("detail.copied", { text }));
    } catch {
      toast(t("detail.copyFailed", { text }), 6000);
    }
  }));
  root.querySelectorAll("[data-pick]").forEach((button) => button.addEventListener("click", () => onPick?.(button.dataset.pick)));
}
