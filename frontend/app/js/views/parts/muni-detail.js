/*
 * Municipality detail, shared by the map drawer and the municipality page.
 * Input is the /api/municipalities/{name} response. Each section shows its
 * own "not available" state; nothing is filled in when a source fails.
 */

import { icon } from "../../core/icons.js";
import { t, getLang } from "../../core/i18n.js";
import { escapeHTML, num, formatTime, formatHour, formatDate, relativeTime, isNumber, parseTime } from "../../core/format.js";
import { levelLabel, levelColor, THRESHOLDS } from "../../core/levels.js";
import { barChart, lineChart, mountChart } from "../../core/charts.js";
import { EXPLAIN } from "../../core/explain.js";
import { buildHash } from "../../core/router.js";

const LEVEL_KEYS = new Set(["nodata", "little", "rain", "yellow", "orange", "red"]);

function sectionHead(title, why) {
  return `<div class="detail-head"><h3>${escapeHTML(title)}</h3>${why ? `<button class="why" type="button" data-why="${why}" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>` : ""}</div>`;
}

/* Set by renderDetail for the duration of one synchronous render. */
let FOLD = false;

/** One detail section: plain, or a collapsible <details> in the map drawer. */
function wrap(title, why, inner, open = true) {
  if (!FOLD) return `<section class="detail-section">${sectionHead(title, why)}${inner}</section>`;
  const whyBtn = why ? `<button class="why" type="button" data-why="${why}" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>` : "";
  return `<details class="detail-section detail-fold"${open ? " open" : ""}>
    <summary class="detail-head"><h3>${escapeHTML(title)}</h3><span class="row" style="gap:4px">${whyBtn}<span class="fold-chevron">${icon("chevronDown", { size: 18 })}</span></span></summary>
    <div class="detail-fold-body">${inner}</div>
  </details>`;
}

function unavailable(section) {
  return `<div class="notice">${icon("alert", { size: 18 })}<div><strong>${escapeHTML(t("common.notAvailable"))}.</strong> ${escapeHTML(section?.detail || "")}</div></div>`;
}

/** Tick label: weekday at midnight, otherwise the hour ("6 PM"). */
function hourTick(time) {
  const date = parseTime(time);
  if (!date) return "";
  const hour = Number(date.toLocaleString("en-US", { timeZone: "Asia/Manila", hour: "numeric", hour12: false }));
  if (hour === 0 || hour === 24) return date.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", weekday: "short" });
  return formatHour(time);
}

export function levelPill(level, text) {
  return `<span class="level" data-level="${escapeHTML(level)}">${escapeHTML(text || levelLabel(level, getLang()))}</span>`;
}

function rainSection(section) {
  if (section?.status !== "ok") return wrap(t("detail.rain"), "rainLevels", unavailable(section));
  const rain = section.data;
  const w24 = rain.windows?.next_24h || {};
  const w6 = rain.windows?.next_6h || {};
  const w48 = rain.windows?.next_48h || {};
  const peakText = isNumber(w24.peak_mm_h)
    ? t("detail.peakAt", { mm: num(w24.peak_mm_h, 1), time: formatTime(w24.peak_time) })
    : t("common.notAvailable");
  return wrap(t("detail.rain"), "rainLevels", `
    ${FOLD ? "" : `<div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>${levelPill(rain.level_24h)}<p class="subtle" style="margin-top:6px">${escapeHTML(t("detail.next24"))} · ${escapeHTML(peakText)}</p></div>
    </div>`}
    <div class="grid grid-3 detail-stats">
      <div class="stat"><span class="stat-label">${escapeHTML(t("detail.total6"))}</span><span class="stat-value num">${escapeHTML(num(w6.total_mm, 1))}<span class="unit">mm</span></span></div>
      <div class="stat"><span class="stat-label">${escapeHTML(t("detail.total24"))}</span><span class="stat-value num">${escapeHTML(num(w24.total_mm, 1))}<span class="unit">mm</span></span></div>
      <div class="stat"><span class="stat-label">${escapeHTML(t("detail.total48"))}</span><span class="stat-value num">${escapeHTML(num(w48.total_mm, 1))}<span class="unit">mm</span></span></div>
    </div>
    <div class="detail-chart" data-chart="rain" aria-label="${escapeHTML(t("detail.rainChart"))}"></div>
    <p class="source-line">${icon("clock", { size: 14 })} Open-Meteo forecast · ${escapeHTML(formatTime(rain.generated_at))} · ${escapeHTML(t("common.notOfficial"))}</p>`);
}

/** Level banner at the top of the map drawer: level, peak, plain meaning. */
function bannerSection(section) {
  if (section?.status !== "ok") return "";
  const rain = section.data;
  const w24 = rain.windows?.next_24h || {};
  const level = rain.level_24h || "nodata";
  const peak = isNumber(w24.peak_mm_h) ? t("detail.peakAt", { mm: num(w24.peak_mm_h, 1), time: formatTime(w24.peak_time) }) : "";
  return `<div class="level-banner" data-level="${escapeHTML(level)}" style="--lvl:${levelColor(level)}">
    <div class="level-banner-top">${levelPill(level)}<span class="subtle">${escapeHTML(t("detail.next24"))}${peak ? ` · ${escapeHTML(peak)}` : ""}</span></div>
    <p class="level-banner-text">${escapeHTML(t(`detail.mean.${LEVEL_KEYS.has(level) ? level : "nodata"}`))}</p>
    <p class="source-line">${escapeHTML(t("common.notOfficial"))}</p>
  </div>`;
}

function weatherSection(section) {
  if (section?.status !== "ok") return wrap(t("detail.weather"), "", unavailable(section));
  const w = section.data;
  const cells = [
    ["temperature", t("detail.temp"), isNumber(w.temperature_c) ? `${num(w.temperature_c, 1)}<span class="unit">°C</span>` : "—"],
    ["humidity", t("detail.humidity"), isNumber(w.humidity_percent) ? `${num(w.humidity_percent, 0)}<span class="unit">%</span>` : "—"],
    ["rain", t("detail.rainNow"), isNumber(w.precipitation_mm) ? `${num(w.precipitation_mm, 1)}<span class="unit">mm</span>` : "—"],
    ["wind", t("detail.wind"), isNumber(w.wind_speed_kmh) ? `${num(w.wind_speed_kmh, 0)}<span class="unit">km/h</span>` : "—"],
  ];
  return wrap(t("detail.weather"), "", `
    <div class="grid grid-4 detail-stats detail-weather">${cells.map(([ic, label, value]) => `
      <div class="stat"><span class="stat-label">${icon(ic, { size: 14 })} ${escapeHTML(label)}</span><span class="stat-value num">${value}</span></div>`).join("")}
    </div>
    <p class="source-line">${icon("clock", { size: 14 })} Open-Meteo · ${escapeHTML(formatTime(w.updated_at))} · ${escapeHTML(t("detail.modelNote"))}</p>`);
}

function dischargeSection(section) {
  if (section?.status !== "ok") return wrap(t("detail.river"), "discharge", unavailable(section), false);
  const d = section.data;
  const has = d.daily?.some((day) => isNumber(day.river_discharge));
  return wrap(t("detail.river"), "discharge", `
    ${has ? `<div class="detail-chart" data-chart="river"></div>` : `<div class="notice">${icon("info", { size: 18 })}<div>${escapeHTML(t("detail.riverNoData"))}</div></div>`}
    <p class="source-line">${icon("clock", { size: 14 })} GloFAS (modeled) · ${escapeHTML(formatTime(d.generated_at))}</p>`, false);
}

function susceptibilitySection() {
  return wrap(t("detail.susceptibility"), "mgb", `<div class="notice">${icon("info", { size: 18 })}<div>${escapeHTML(t("detail.susceptibilityNA"))}</div></div>`, false);
}

function centersSection(section) {
  if (section?.status !== "ok") return wrap(t("detail.centers"), "evacuation", unavailable(section));
  const centers = section.data.centers || [];
  if (!centers.length) return wrap(t("detail.centers"), "evacuation", `<p class="muted">${escapeHTML(t("detail.noCenters"))}</p>`);
  return wrap(t("detail.centers"), "evacuation", `
    <ul class="list">${centers.map((c) => `
      <li class="center-row">
        <div>
          <strong>${escapeHTML(c.name)}</strong>
          <div class="subtle">${escapeHTML(c.municipality)}${isNumber(c.distance_km_from_town_point) ? ` · ${escapeHTML(num(c.distance_km_from_town_point, 1))} km ${escapeHTML(t("detail.fromTownPoint"))}` : ""}</div>
        </div>
        <div class="row" style="gap:6px">
          <span class="badge badge-warning">${escapeHTML(t("common.unverified"))}</span>
          ${c.google_maps_url ? `<a class="btn btn-sm btn-icon" href="${escapeHTML(c.google_maps_url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHTML(t("detail.directions"))}: ${escapeHTML(c.name)}">${icon("navigation", { size: 16 })}</a>` : ""}
        </div>
      </li>`).join("")}
    </ul>`);
}

function reportsSection(reports) {
  if (!reports) return "";
  if (reports.status !== "ok") return wrap(t("detail.reports"), "reports", unavailable(reports));
  const rows = reports.data || [];
  return wrap(t("detail.reports"), "reports", `
    ${rows.length ? `<ul class="list">${rows.slice(0, 5).map((r) => `
      <li>
        <div class="row" style="justify-content:space-between"><strong>${escapeHTML(r.barangay || r.location || "")}</strong><span class="badge">${escapeHTML(r.severity || "")}</span></div>
        <div class="subtle">${escapeHTML(formatTime(r.reported_at))} (${escapeHTML(relativeTime(r.reported_at))}) · ${escapeHTML(t("common.unverified"))}</div>
      </li>`).join("")}</ul>` : `<p class="muted">${escapeHTML(t("detail.noReports"))}</p>`}`, rows.length > 0);
}

/** Return HTML for the full detail. */
export function renderDetail(data, { reports = null, showOpenPage = true, collapsible = false, banner = false } = {}) {
  FOLD = collapsible;
  try {
    return renderParts(data, reports, showOpenPage, banner);
  } finally {
    FOLD = false;
  }
}

function renderParts(data, reports, showOpenPage, banner) {
  return `
    ${banner ? bannerSection(data.rain) : ""}
    ${rainSection(data.rain)}
    ${weatherSection(data.current_weather)}
    ${dischargeSection(data.river_discharge)}
    ${susceptibilitySection(data.susceptibility)}
    ${centersSection(data.evacuation_centers)}
    ${reportsSection(reports)}
    ${showOpenPage ? `<div class="detail-foot"><a class="btn btn-block" href="${buildHash("municipality", [data.name])}">${escapeHTML(t("detail.openPage"))} ${icon("arrowRight", { size: 16 })}</a></div>` : ""}`;
}

/** Mount charts and "why" buttons after the HTML is in the page. Returns cleanup. */
export function hydrateDetail(root, data) {
  const cleanups = [];
  root.querySelectorAll("[data-why]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      EXPLAIN[button.dataset.why]?.();
    });
  });

  const rainEl = root.querySelector('[data-chart="rain"]');
  if (rainEl && data.rain?.status === "ok") {
    const series = data.rain.data.series || [];
    const bars = series.map((p) => ({
      label: hourTick(p.time),
      hour: parseTime(p.time)?.toLocaleString("en-US", { timeZone: "Asia/Manila", hour: "numeric", hour12: false }),
      value: p.precipitation_mm,
      color: levelColor(p.level),
      title: `${formatTime(p.time)}: ${isNumber(p.precipitation_mm) ? `${p.precipitation_mm} mm/h` : "no data"} · ${levelLabel(p.level, getLang())}${isNumber(p.probability_percent) ? ` · ${p.probability_percent}% chance` : ""}`,
    }));
    cleanups.push(mountChart(rainEl, (width) => barChart(bars, {
      width, height: 150, unit: "mm/h",
      showLabel: (i, bar) => Number(bar.hour) % (width < 420 ? 12 : 6) === 0,
      ariaLabel: t("detail.rainChart"),
      minMax: 2,
      guides: [
        { value: THRESHOLDS.yellow, label: "Yellow 7.5", color: "#ca8a04" },
        { value: THRESHOLDS.orange, label: "Orange 15", color: "#ea580c" },
        { value: THRESHOLDS.redAbove, label: "Red 30", color: "#dc2626" },
      ],
    })));
  }

  const riverEl = root.querySelector('[data-chart="river"]');
  if (riverEl) {
    const daily = data.river_discharge.data.daily || [];
    const points = daily.map((d) => ({ label: formatDate(d.date).replace(/, \d{4}$/, ""), value: d.river_discharge, low: d.p25, high: d.p75 }));
    cleanups.push(mountChart(riverEl, (width) => lineChart(points, { width, height: 140, unit: "m³/s", color: "#0891b2", xLabelEvery: width < 420 ? 2 : 1, ariaLabel: t("detail.river") })));
  }

  return () => cleanups.forEach((fn) => fn());
}

export function sortByTime(rows) {
  return [...rows].sort((a, b) => (parseTime(b.reported_at)?.getTime() || 0) - (parseTime(a.reported_at)?.getTime() || 0));
}
