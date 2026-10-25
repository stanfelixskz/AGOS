/*
 * Analytics for residents: plain-language sections for ONE chosen town.
 * - Past floods in my town (/api/flood-events + rain ranks from /api/flood-evidence)
 * - How often this much rain happens here (return levels from /api/climate)
 * - When flood season is (monthly rain from /api/climate + months of listed floods)
 * Everything is computed by the backend from the AGOS database; this file only words it.
 */

import { icon } from "../../core/icons.js";
import { t } from "../../core/i18n.js";
import { escapeHTML, num, isNumber } from "../../core/format.js";
import { dateRange } from "./evidence.js";
import { monthName, percent } from "./climate.js";

const EVIDENCE_KINDS = ["flooded", "road", "evacuation", "death", "affected"];
const FIRST_SHOWN = 5;

/**
 * Plain words for a 3-day rain percentile against the town's own record.
 * The cut-offs match the alert levels tested in "How reliable would a simple alert be?".
 */
export function rainWords(p) {
  if (!isNumber(p)) return null;
  if (p >= 99) return { key: "resident.rank.extreme", level: "danger" };
  if (p >= 98) return { key: "resident.rank.veryUnusual", level: "danger" };
  if (p >= 95) return { key: "resident.rank.unusual", level: "warning" };
  if (p >= 90) return { key: "resident.rank.heavier", level: "info" };
  return { key: "resident.rank.normal", level: "" };
}

/**
 * Listed events that mention `town` (any kind of evidence), newest first, each with
 * the town's entry and, when the evidence check could test it, the rain before it.
 */
export function townFloods(eventsData, evidenceData, town) {
  const cases = new Map();
  for (const e of evidenceData?.events || []) {
    const c = (e.towns || []).find((tw) => tw.municipality === town);
    if (c) cases.set(e.id, c);
  }
  return (eventsData?.events || [])
    .map((e) => ({ event: e, entry: (e.towns || []).find((tw) => tw.municipality === town), rain: cases.get(e.id) || null }))
    .filter((x) => x.entry)
    .sort((a, b) => String(b.event.start_date || b.event.period || "").localeCompare(String(a.event.start_date || a.event.period || "")));
}

/** Listed Bataan floods per calendar month (dated events only): [{month, count}] for months with any. */
export function floodMonths(eventsData) {
  const counts = new Array(12).fill(0);
  for (const e of eventsData?.events || []) {
    if (!e.start_date) continue;
    counts[Number(e.start_date.slice(5, 7)) - 1] += 1;
  }
  return counts.map((count, i) => ({ month: i + 1, count })).filter((m) => m.count > 0);
}

function rainLine(rain) {
  if (!rain) return `<span class="subtle">${escapeHTML(t("resident.rainNotTested"))}</span>`;
  if (rain.status !== "ok") {
    return `<span class="subtle">${escapeHTML(t(rain.status === "outside_record" ? "evidence.beforeRecord" : "evidence.incomplete"))}</span>`;
  }
  const words = rainWords(rain.max_3day_percentile);
  const badge = words?.level ? `<span class="badge badge-${words.level}">${escapeHTML(t(words.key))}</span>` : `<span class="badge">${escapeHTML(t(words.key))}</span>`;
  return `${escapeHTML(t("resident.rainBefore", { mm: num(rain.max_3day_mm, 0) }))} ${badge}`;
}

function floodItem({ event, entry, rain }) {
  const when = event.start_date ? dateRange(event.start_date, event.end_date) : (event.period || t("resident.noDate"));
  const kind = EVIDENCE_KINDS.includes(entry.evidence) ? t(`resident.ev.${entry.evidence}`) : entry.evidence;
  const source = event.sources?.[0];
  return `<li class="town-flood">
    <div class="row" style="justify-content:space-between;align-items:baseline">
      <strong>${escapeHTML(when)}${event.storm ? ` · ${escapeHTML(event.storm)}` : ""}</strong>
      <span class="subtle">${escapeHTML(kind)}</span>
    </div>
    ${entry.note ? `<div>${escapeHTML(entry.note)}</div>` : ""}
    <div>${rainLine(rain)}</div>
    ${source ? `<div class="subtle">${escapeHTML(t("resident.source"))}: <a href="${escapeHTML(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(source.publisher)}</a></div>` : ""}
  </li>`;
}

/** "Past floods in <town>" card. */
export function renderTownFloods(eventsData, evidenceData, town) {
  const list = townFloods(eventsData, evidenceData, town);
  const s = evidenceData?.summary;
  const bataan = s && isNumber(s.share_top5) && isNumber(s.chance_top5)
    ? `<div class="notice notice-info">${icon("info", { size: 18 })}<div>${escapeHTML(t("resident.bataanFinding", { share: num(s.share_top5 * 100, 0), chance: num(s.chance_top5 * 100, 0) }))}</div></div>`
    : "";
  const rest = list.slice(FIRST_SHOWN);
  const more = rest.length
    ? `<details class="town-floods-more"><summary>${escapeHTML(t("resident.showAll", { n: list.length }))}</summary><ul class="town-floods">${rest.map(floodItem).join("")}</ul></details>`
    : "";
  const body = list.length
    ? `<ul class="town-floods">${list.slice(0, FIRST_SHOWN).map(floodItem).join("")}</ul>${more}`
    : `<div class="notice notice-info">${icon("info", { size: 18 })}<div>${escapeHTML(t("resident.noFloods", { town }))}</div></div>`;
  return `<section class="card" aria-labelledby="townFloodsTitle">
    <div class="card-head">
      <div><h2 id="townFloodsTitle">${escapeHTML(t("resident.floodsTitle", { town }))}</h2>
        <p>${escapeHTML(t(list.length === 1 ? "resident.floodsSub1" : "resident.floodsSubN", { n: list.length }))}</p></div>
      <button class="why" type="button" data-explain="evidence" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>
    </div>
    ${bataan}
    ${body}
    <p class="card-foot">${escapeHTML(t("resident.floodsFoot"))}</p>
  </section>`;
}

/** "How often does this much rain happen in <town>?" card, from the town's return levels. */
export function renderRareRain(climateData, town) {
  const tw = climateData?.towns?.find((x) => x.name === town);
  const rl = tw?.return_levels;
  const head = `<div class="card-head">
      <div><h2 id="rareRainTitle">${escapeHTML(t("resident.rareTitle", { town }))}</h2>
        <p>${escapeHTML(tw ? t("resident.rareSub", { n: rl?.n_years ?? tw.full_years }) : "")}</p></div>
      <button class="why" type="button" data-explain="climate" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>
    </div>`;
  if (!rl || rl.status !== "ok") {
    return `<section class="card" style="margin-top:var(--space-4)" aria-labelledby="rareRainTitle">${head}
      <div class="notice notice-info">${icon("clock", { size: 18 })}<div>${escapeHTML(t("resident.rareNone"))}</div></div></section>`;
  }
  const levels = rl.levels.map((lv) => `<li>${escapeHTML(t("resident.onceEvery", { years: lv.years, mm: num(lv.mm, 0), low: num(lv.low, 0), high: num(lv.high, 0) }))}</li>`).join("");
  const exceed = rl.exceedance.map((e) => `<li>${escapeHTML(t("resident.chanceYear", { mm: e.mm, p: percent(e.probability) }))}</li>`).join("");
  return `<section class="card" style="margin-top:var(--space-4)" aria-labelledby="rareRainTitle">${head}
    <ul class="plain-list">${levels}</ul>
    <h3 style="margin-top:var(--space-3)">${escapeHTML(t("resident.inAYear"))}</h3>
    <ul class="plain-list">${exceed}</ul>
    <p class="subtle">${escapeHTML(t("resident.rareRecord", { mm: num(rl.observed_max_mm, 0) }))}</p>
    <p class="card-foot">${escapeHTML(t("resident.rareFoot"))}</p>
  </section>`;
}

/** "When is flood season?" card: the town's monthly rain chart plus months of listed Bataan floods. */
export function renderSeason(climateData, eventsData, town) {
  const tw = climateData?.towns?.find((x) => x.name === town);
  const wet = (tw?.monthly || []).filter((m) => m.above_average).map((m) => monthName(m.month));
  const months = floodMonths(eventsData);
  return `<section class="card" style="margin-top:var(--space-4)" aria-labelledby="seasonTitle">
    <div class="card-head"><div><h2 id="seasonTitle">${escapeHTML(t("resident.seasonTitle"))}</h2>
      <p>${escapeHTML(wet.length ? t("resident.wetMonths", { town, months: wet.join(", ") }) : t("resident.noMonthly"))}</p></div></div>
    ${tw?.monthly?.length ? `<div class="detail-chart" data-climate-month="${escapeHTML(town)}"></div>` : ""}
    ${months.length ? `<h3 style="margin-top:var(--space-3)">${escapeHTML(t("resident.floodMonthsTitle"))}</h3>
      <div class="row" style="flex-wrap:wrap;gap:var(--space-2)">${months.map((m) => `<span class="badge">${escapeHTML(`${monthName(m.month)}: ${m.count}`)}</span>`).join("")}</div>` : ""}
    <p class="card-foot">${escapeHTML(t("resident.seasonFoot"))}</p>
  </section>`;
}

/** A folded group of cards; `id` is used for the remembered open state. */
export function fold(id, title, sub, inner, open = false) {
  return `<details class="analytics-fold" data-fold="${escapeHTML(id)}"${open ? " open" : ""}>
    <summary><span><span class="analytics-fold-title">${escapeHTML(title)}</span><span class="subtle">${escapeHTML(sub)}</span></span>
      <span class="fold-chevron">${icon("chevronDown", { size: 20 })}</span></summary>
    <div class="analytics-fold-body">${inner}</div>
  </details>`;
}
