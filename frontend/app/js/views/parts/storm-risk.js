/*
 * Flood risk on the day of a storm read from an article (/api/typhoon/flood-risk).
 * Shown in the typhoon drawer on the Map page. The sign is the tested rain rule for
 * that day (stored rain for past days, model analysis for recent days, forecast for
 * today and the next 2 days); the storm's distance is context only.
 * Not an official warning and not a flood probability.
 */

import { icon } from "../../core/icons.js";
import { t } from "../../core/i18n.js";
import { escapeHTML, num, isNumber, formatDate, PH_TZ } from "../../core/format.js";
import { dateRange } from "./evidence.js";
import { watchBadge, topShare } from "./watch.js";

/** Today's date in the Philippines as YYYY-MM-DD. */
export function todayPH(now = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: PH_TZ });
}

/** YYYY-MM-DD `days` after `day`. */
export function addDays(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The day to check first: the article's publish day, when the reader found one. */
export function stormDay(ty) {
  return ty?.article?.day?.date || null;
}

/** Which rain the answer rests on, from the user's side: recorded, recent model, today, or ahead. */
export function riskTense(data, today) {
  if (data?.mode === "replay") return "recorded";
  if (data?.date < today) return "recent";
  return data?.date === today ? "today" : "ahead";
}

/** The date picker and an empty result box, placed in the typhoon drawer. */
export function renderStormRiskForm(ty, today) {
  const day = stormDay(ty);
  const basis = day ? t("stormRisk.fromArticle", { date: formatDate(day) }) : t("stormRisk.noDate");
  return `<section class="detail-section" aria-labelledby="stormRiskTitle">
    <h3 id="stormRiskTitle">${escapeHTML(t("stormRisk.title"))}</h3>
    <p class="subtle">${escapeHTML(t("stormRisk.intro"))}</p>
    <form class="storm-risk-form" id="stormRiskForm" novalidate>
      <label class="subtle" for="stormRiskDate">${escapeHTML(t("stormRisk.date"))}</label>
      <div class="row" style="gap:8px">
        <input class="input" type="date" id="stormRiskDate" value="${escapeHTML(day || "")}" max="${escapeHTML(addDays(today, 2))}">
        <button class="btn btn-sm btn-primary" type="submit">${escapeHTML(t("stormRisk.check"))}</button>
      </div>
    </form>
    <p class="subtle" id="stormRiskBasis" style="margin-top:6px">${escapeHTML(basis)}</p>
    <div id="stormRiskResult" aria-live="polite"></div>
  </section>`;
}

function townRow(town) {
  const rain = town.rain || {};
  const peak = rain.peak;
  const mm = peak && isNumber(peak.mm) ? `${num(peak.mm, 0)} mm` : "—";
  const when = peak ? `<br><span class="subtle">${escapeHTML(dateRange(peak.start, peak.end))}</span>` : "";
  return `<tr>
    <th scope="row">${escapeHTML(town.name)}</th>
    <td>${watchBadge(rain.level || "no_data")}</td>
    <td class="num">${escapeHTML(mm)}${when}</td>
    <td>${escapeHTML(peak ? topShare(peak.percentile) : "—")}</td>
  </tr>`;
}

function stormLines(storm) {
  if (!storm) return `<p class="subtle">${escapeHTML(t("stormRisk.noPosition"))}</p>`;
  const lines = [t("stormRisk.distance", { km: num(storm.nearest.km, 0), town: storm.nearest.name })];
  if (!storm.radius_km) lines.push(t("stormRisk.noRadius"));
  else if (storm.inside_radius.length) lines.push(t("stormRisk.inside", { km: num(storm.radius_km, 0), towns: storm.inside_radius.join(", ") }));
  else lines.push(t("stormRisk.outside", { km: num(storm.radius_km, 0) }));
  return `<p>${escapeHTML(lines.join(" "))}</p><p class="subtle">${escapeHTML(t("stormRisk.stormContext"))}</p>`;
}

function comparisonBlock(cmp) {
  if (!cmp) return "";
  const list = (towns) => (towns.length ? towns.join(", ") : t("stormRisk.none"));
  return `<dl class="kv storm-compare">
      <dt>${escapeHTML(t("stormRisk.listedFlooded"))}</dt><dd>${escapeHTML(list(cmp.listed_flooded))}</dd>
      <dt>${escapeHTML(t("stormRisk.both"))}</dt><dd>${escapeHTML(list(cmp.both))}</dd>
      <dt>${escapeHTML(t("stormRisk.missed"))}</dt><dd>${escapeHTML(list(cmp.flooded_not_raised))}</dd>
      <dt>${escapeHTML(t("stormRisk.extra"))}</dt><dd>${escapeHTML(list(cmp.raised_not_listed))}</dd>
    </dl>
    <p class="subtle">${escapeHTML(t("stormRisk.compareNote"))}</p>`;
}

function eventsList(events) {
  if (!events?.length) return "";
  return `<ul class="storm-events">${events.map((e) => {
    const source = (e.sources || [])[0];
    const link = source && /^https?:\/\//.test(source.url || "")
      ? ` · <a href="${escapeHTML(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(source.publisher || t("resident.source"))}</a>` : "";
    return `<li><strong>${escapeHTML(dateRange(e.start, e.end))}</strong> · ${escapeHTML((e.towns || []).join(", ") || t("stormRisk.noTownNamed"))}${link}</li>`;
  }).join("")}</ul>`;
}

const SHORT_RECORD_YEARS = 10;

/** How long a record the ranks rest on; a short record gets a warning. */
export function recordLine(factors, today) {
  const first = factors?.replay?.min;
  if (!first) return t("stormRisk.recordNone");
  const years = (new Date(`${today}T00:00:00Z`) - new Date(`${first}T00:00:00Z`)) / (365.25 * 86400000);
  const line = t("stormRisk.record", { date: formatDate(first) });
  return years < SHORT_RECORD_YEARS ? `${line} ${t("stormRisk.recordShort", { years: num(years, 1) })}` : line;
}

/** The answer for one day: sign per town, storm context, and listed floods beside it. */
export function renderStormRisk(data, today) {
  const factors = data?.factors;
  if (!factors?.towns?.length) return `<p class="subtle">${escapeHTML(t("stormRisk.empty"))}</p>`;
  const tense = riskTense(data, today);
  const raised = factors.raised || [];
  const head = raised.length
    ? t("stormRisk.raised", { n: raised.length, all: factors.towns.length, towns: raised.join(", ") })
    : t("stormRisk.noneRaised", { all: factors.towns.length });
  const near = factors.events_near || [];
  const floods = tense === "today" || tense === "ahead"
    ? ""
    : near.length
      ? `<h4 class="storm-risk-sub">${escapeHTML(t("stormRisk.floodsNear"))}</h4>${eventsList(near)}${comparisonBlock(data.comparison)}`
      : `<p class="subtle">${escapeHTML(t("stormRisk.noFloodsNear"))}</p>`;
  return `<div class="storm-risk">
    <p class="subtle">${escapeHTML(t(`stormRisk.tense.${tense}`, { date: formatDate(data.date) }))}</p>
    <p><strong>${escapeHTML(head)}</strong></p>
    <p class="subtle">${escapeHTML(recordLine(factors, today))}</p>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>${escapeHTML(t("stormRisk.colTown"))}</th><th>${escapeHTML(t("watch.colSign"))}</th><th class="num">${escapeHTML(t("watch.col3day"))}</th><th>${escapeHTML(t("watch.colRank"))}</th></tr></thead>
      <tbody>${factors.towns.map(townRow).join("")}</tbody>
    </table></div>
    <h4 class="storm-risk-sub">${escapeHTML(t("stormRisk.stormTitle"))}</h4>
    ${stormLines(data.storm)}
    ${floods}
    <button class="btn btn-sm" type="button" data-storm-map>${icon("map", { size: 14 })} ${escapeHTML(t("stormRisk.showOnMap"))}</button>
    <div class="notice notice-warning" style="margin-top:12px">${icon("alert", { size: 18 })}<div>${escapeHTML(t("stormRisk.foot"))}</div></div>
  </div>`;
}
