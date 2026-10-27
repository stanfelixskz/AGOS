/*
 * Flood factors for one town (/api/flood-factors): rain, wet ground, MGB flood-prone
 * ground, past floods and the mapped rivers side by side, with what is NOT included said out loud.
 * Used at the top of the Map drawer and of the municipality page. The input is
 * { status: "ok", data } or { status: "unavailable", detail }.
 * Not an official warning and not a flood probability.
 */

import { icon } from "../../core/icons.js";
import { t, getLang } from "../../core/i18n.js";
import { escapeHTML, num, isNumber, formatDate, formatTime } from "../../core/format.js";
import { watchBadge, topShare } from "./watch.js";
import { stackedBar, pct, barLabel } from "./susceptibility.js";

const RAISED = new Set(["watch", "warning", "high_warning"]);
const RIVER_NAMES_SHOWN = 6;

export function factorsTown(factors, name) {
  if (factors?.status !== "ok") return null;
  return factors.data?.towns?.find((x) => x.name === name) || null;
}

/** Short day ("Oct 26"): the year is not needed for rain windows. */
export function shortDay(value) {
  return value ? formatDate(value).replace(/, \d{4}$/, "") : "—";
}

/** The three months with the most listed floods, as words ("July, August, September"). */
export function topMonths(months, count = 3) {
  const ranked = (months || []).map((n, i) => ({ n, i })).filter((m) => m.n > 0).sort((a, b) => b.n - a.n || a.i - b.i).slice(0, count)
    .sort((a, b) => a.i - b.i);
  const locale = getLang() === "fil" ? "fil-PH" : "en-PH";
  return ranked.map((m) => new Date(2000, m.i, 1).toLocaleDateString(locale, { month: "long" })).join(", ");
}

/** "wetter than 93% of this town's 14-day spells", or plain words for ordinary ground. */
export function wetWords(percentile) {
  if (!isNumber(percentile)) return "—";
  if (percentile < 90) return t("factors.wetOrdinary");
  return t("factors.wetRank", { p: num(percentile, 0) });
}

/** The first few river names for the panel and how many were left out. */
export function riverNames(names, max = RIVER_NAMES_SHOWN) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max) };
}

function replayLine(data) {
  return data.mode === "replay"
    ? `<p class="subtle">${escapeHTML(t("factors.replay", { date: formatDate(data.date) }))}</p>`
    : "";
}

/** The sentence at the top: what the rain is doing and what it means for flood-prone ground. */
export function renderFactorsBanner(factors, name) {
  const town = factorsTown(factors, name);
  if (!town) return "";
  const data = factors.data;
  const level = town.rain?.level || "no_data";
  const peak = town.rain?.peak;
  if (level === "no_data" || !peak) {
    return `<div class="notice factor-banner" data-state="no_data">${icon("info", { size: 18 })}<div>
      <p><strong>${escapeHTML(t("factors.noData", { town: name }))}</strong></p>${replayLine(data)}</div></div>`;
  }
  const vars = { town: name, mm: num(peak.mm, 0), end: shortDay(peak.end), rank: topShare(peak.percentile) };
  if (RAISED.has(level)) {
    const tone = level === "watch" ? "warning" : "danger";
    const b = data.backing?.[level];
    const backing = b ? `<p>${escapeHTML(t("factors.backing", { caught: b.caught, cases: b.cases }))}</p>` : "";
    return `<div class="notice notice-${tone} factor-banner" data-state="raised">${icon("alert", { size: 18 })}<div>
      <p><strong>${escapeHTML(t("factors.raised", vars))}</strong></p>${backing}${replayLine(data)}
      <p class="subtle">${escapeHTML(t("common.notOfficial"))}</p></div></div>`;
  }
  return `<div class="notice notice-info factor-banner" data-state="ordinary">${icon("info", { size: 18 })}<div>
    <p><strong>${escapeHTML(t("factors.ordinary", vars))}</strong></p>${replayLine(data)}
    <p class="subtle">${escapeHTML(t("common.notOfficial"))}</p></div></div>`;
}

function row(label, valueHTML, { off = false } = {}) {
  return `<div class="factor-row${off ? " is-off" : ""}"><dt>${escapeHTML(label)}</dt><dd>${valueHTML}</dd></div>`;
}

function rainRow(town, data) {
  const level = town.rain?.level || "no_data";
  const peak = town.rain?.peak;
  if (!peak) return row(t("factors.rain"), `${watchBadge(level)} <span class="subtle">${escapeHTML(t("watch.noData"))}</span>`);
  const days = (town.rain.daily || []).filter((d) => isNumber(d.mm));
  const list = days.length
    ? `<span class="subtle">${escapeHTML(t("factors.days", { list: days.map((d) => num(d.mm, 0)).join(" · "), from: shortDay(days[0].date), to: shortDay(days[days.length - 1].date) }))}</span>`
    : "";
  const source = data.mode === "replay" ? t("factors.srcReplay") : t("factors.srcForecast");
  return row(t("factors.rain"), `${watchBadge(level)} ${escapeHTML(t("factors.rainValue", { mm: num(peak.mm, 0), end: shortDay(peak.end), rank: topShare(peak.percentile) }))}
    ${list}<span class="subtle">${escapeHTML(source)}</span>`);
}

function wetRow(town) {
  const w = town.wet_ground;
  if (!w) return row(t("factors.wet"), `<span class="subtle">${escapeHTML(t("factors.wetNA"))}</span>`);
  return row(t("factors.wet"), `${escapeHTML(t("factors.wetValue", { mm: num(w.mm, 0), rank: wetWords(w.percentile) }))}
    <span class="subtle">${escapeHTML(t("factors.wetNote"))}</span>`);
}

function groundRow(town) {
  const s = town.susceptibility;
  if (!s) return row(t("factors.ground"), `<span class="subtle">${escapeHTML(t("factors.groundNA"))}</span>`);
  const top = (s.top_barangays || []).slice(0, 3).map((b) => `${b.name} (${pct(b.high_share)})`).join(", ");
  return row(t("factors.ground"), `${escapeHTML(t("factors.groundValue", { p: pct(s.high_share) }))}
    ${stackedBar(s.shares, { label: barLabel(town.name, s.shares) })}
    ${top ? `<span class="subtle">${escapeHTML(t("factors.groundTop", { names: top }))}</span>` : ""}`);
}

function floodsRow(town) {
  const f = town.floods;
  if (!f?.listed_floods) return row(t("factors.floods"), `<span class="subtle">${escapeHTML(t("watch.noListed", { town: town.name }))}</span>`);
  const months = topMonths(f.months);
  const names = (f.barangays || []).slice(0, 4).map((b) => `${b.name} (${b.count})`).join(", ");
  return row(t("factors.floods"), `${escapeHTML(t("factors.floodsValue", { n: f.listed_floods, latest: f.latest ? formatDate(f.latest) : "—" }))}
    ${months ? `<span class="subtle">${escapeHTML(t("factors.floodsMonths", { months }))}</span>` : ""}
    ${names ? `<span class="subtle">${escapeHTML(t("factors.floodsBgys", { names }))}</span>` : ""}`);
}

/** Named OpenStreetMap waterways in the town and the mapped length. Context only: not part of the sign. */
function riversRow(town) {
  const r = town.rivers;
  if (!r) return row(t("factors.rivers"), `<span class="subtle">${escapeHTML(t("factors.riversNA"))}</span>`);
  const { shown, more } = riverNames(r.names);
  const names = shown.length
    ? `${escapeHTML(t("factors.riversNames", { names: shown.join(", ") }))}${more ? ` ${escapeHTML(t("factors.riversMore", { n: more }))}` : ""}`
    : escapeHTML(t("factors.riversNone"));
  return row(t("factors.rivers"), `${names}
    <span class="subtle">${escapeHTML(t("factors.riversLength", { km: isNumber(r.length_km) ? num(r.length_km, 1) : "—" }))}</span>
    <span class="subtle">${escapeHTML(t("factors.riversNote"))}</span>`);
}

const CONF_REASONS = ["few_spells", "wide_range", "list_incomplete", "modeled_rain"];

/** How often unusual rain of the town's sign level ended in a listed flood before (province-wide, past, not a forecast). */
export function chanceRow(town, data) {
  const table = data?.chance;
  if (!table) return row(t("factors.chance"), `<span class="subtle">${escapeHTML(t("factors.chanceNA"))}</span>`);
  const c = town.chance;
  if (!c) return row(t("factors.chance"), `<span class="subtle">${escapeHTML(t("factors.chanceIdle"))}</span>`);
  const level = t(`watch.level.${c.level}`);
  const head = c.rate == null
    ? t("factors.chanceFew", { level, n: c.spells })
    : t("factors.chanceValue", { level, n: c.spells, k: c.floods, since: table.from.slice(0, 4), rate: pct(c.rate), lo: pct(c.range_95[0]), hi: pct(c.range_95[1]) });
  const reasons = (c.reasons || []).filter((x) => CONF_REASONS.includes(x)).map((x) => t(`factors.why.${x}`)).join("; ");
  const conf = c.rate == null ? "" : `${t("factors.confidence", { label: t(`factors.conf.${c.confidence}`) })} ${reasons}.`;
  return row(t("factors.chance"), `${escapeHTML(head)}
    ${conf ? `<span class="subtle">${escapeHTML(conf)}</span>` : ""}
    ${table.includes_replayed_day ? `<span class="subtle">${escapeHTML(t("factors.chanceReplay"))}</span>` : ""}
    <span class="subtle">${escapeHTML(t("factors.chanceNote", { since: table.from.slice(0, 4) }))}</span>`);
}

/** Spring tide from the moon (not a tide gauge). Context only; a precaution line when rain is raised too. */
export function tideRow(town, data) {
  const tide = data?.tide;
  if (!tide?.days?.length) return row(t("factors.tide"), `<span class="subtle">${escapeHTML(t("factors.tideNA"))}</span>`, { off: true });
  const springDays = tide.days.filter((d) => d.spring);
  const first = springDays[0];
  const head = first
    ? t("factors.tideSpring", { moon: t(first.moon === "full" ? "factors.moonFull" : "factors.moonNew"), date: shortDay(first.date) })
    : t("factors.tideOrdinary");
  const k = tide.tested;
  const test = k?.events
    ? t("factors.tideTested", { k: k.near_spring, n: k.events, share: pct(k.share), expected: pct(k.expected_share_if_no_link) })
    : "";
  return row(t("factors.tide"), `${escapeHTML(head)}
    ${town.tide_overlap ? `<span class="factor-precaution">${escapeHTML(t("factors.tideOverlap"))}</span>` : ""}
    ${test ? `<span class="subtle">${escapeHTML(test)}</span>` : ""}
    <span class="subtle">${escapeHTML(t("factors.tideNote"))}</span>`);
}

function reportedBlock(data) {
  if (data.mode !== "replay") return "";
  const list = data.events_near || [];
  const items = list.map((e) => {
    const src = e.sources?.[0];
    const when = e.start === e.end ? formatDate(e.start) : `${shortDay(e.start)} – ${shortDay(e.end)}`;
    const link = src ? ` <a href="${escapeHTML(src.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(src.publisher)}</a>` : "";
    return `<li><strong>${escapeHTML(when)}</strong>: ${escapeHTML(e.towns.join(", ") || "—")}${link}</li>`;
  }).join("");
  return `<div class="factor-reported"><h4>${escapeHTML(t("factors.reported"))}</h4>
    ${items ? `<ul class="list">${items}</ul>` : `<p class="subtle">${escapeHTML(t("factors.reportedNone"))}</p>`}
    <p class="subtle">${escapeHTML(t("factors.reportedNote"))}</p></div>`;
}

/** The factor rows, the left-out factors and the source line. */
export function renderFactorsBody(factors, name) {
  if (factors?.status !== "ok") {
    return `<div class="notice">${icon("alert", { size: 18 })}<div><strong>${escapeHTML(t("common.notAvailable"))}.</strong> ${escapeHTML(factors?.detail || "")}</div></div>`;
  }
  const town = factorsTown(factors, name);
  if (!town) return `<p class="muted">${escapeHTML(t("common.notAvailable"))}</p>`;
  const data = factors.data;
  return `<dl class="factor-rows">
      ${rainRow(town, data)}
      ${wetRow(town)}
      ${groundRow(town)}
      ${floodsRow(town)}
      ${chanceRow(town, data)}
      ${riversRow(town)}
      ${tideRow(town, data)}
      ${row(t("factors.storm"), escapeHTML(t("factors.stormNA")), { off: true })}
      ${row(t("factors.dikes"), escapeHTML(t("factors.dikesNA")), { off: true })}
    </dl>
    ${reportedBlock(data)}
    <p class="source-line">${icon("clock", { size: 14 })} ${escapeHTML(t("factors.source", { when: formatTime(data.issued_at) }))} · ${escapeHTML(t("common.notOfficial"))}</p>`;
}
