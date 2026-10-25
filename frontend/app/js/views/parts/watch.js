/*
 * Flood warning sign (/api/flood-watch): the tested rain rule applied to the last
 * 2 days, today and the next 2 days. Used on Overview (all towns) and at the top of
 * Analytics (one town). Not an official warning and not a flood probability.
 */

import { icon } from "../../core/icons.js";
import { t } from "../../core/i18n.js";
import { escapeHTML, num, isNumber, formatDate } from "../../core/format.js";
import { dateRange } from "./evidence.js";

export const WATCH_LEVELS = ["high_warning", "warning", "watch", "normal", "no_data"];
const BADGE = { high_warning: "danger", warning: "danger", watch: "warning", normal: "success", no_data: "" };

export function watchBadge(level) {
  const tone = BADGE[level] ?? "";
  return `<span class="badge${tone ? ` badge-${tone}` : ""}">${escapeHTML(t(`watch.level.${level}`))}</span>`;
}

/** "top 1.6%" from a percentile; above every value on record gets its own words. */
export function topShare(p) {
  if (!isNumber(p)) return "—";
  if (p >= 100) return t("watch.aboveRecord");
  if (p < 90) return t("watch.ordinary"); // exact ranks only matter for unusual rain
  const share = 100 - p;
  return t("watch.top", { p: num(share, share < 10 ? 1 : 0) });
}

function backingLine(data, level) {
  const b = data.backing?.[level];
  if (!b) return "";
  return t("watch.backing", { share: num(b.share * 100, 0), caught: b.caught, cases: b.cases, per: isNumber(b.alerts_per_town_year) ? num(b.alerts_per_town_year, 1) : "—" });
}

function reasonLine(town) {
  if (town.level === "no_data") return t("watch.noData");
  const p = town.peak;
  return t("watch.reason", { mm: num(p.mm, 0), when: dateRange(p.start, p.end), rank: topShare(p.percentile), town: town.name });
}

function floodsLine(town) {
  if (!town.listed_floods) return t("watch.noListed", { town: town.name });
  return t("watch.listed", { town: town.name, n: town.listed_floods, latest: town.latest ? formatDate(town.latest) : "—" });
}

function dayStrip(town) {
  return `<div class="watch-days">${(town.daily || []).map((d) => `<div class="watch-day${d.date === town.today ? " is-today" : ""}">
      <span class="subtle">${escapeHTML(formatDate(d.date).replace(/, \d{4}$/, ""))}</span>
      <strong class="num">${isNumber(d.mm) ? `${escapeHTML(num(d.mm, 0))} mm` : "—"}</strong></div>`).join("")}</div>`;
}

function disclaimer(data) {
  const mixed = data.rain_record && data.rain_record.consistent === false;
  return `<p class="card-foot">${escapeHTML(t("watch.foot"))}${mixed ? ` ${escapeHTML(t("watch.mixed"))}` : ""}</p>`;
}

/** One town, with reasons (top of Analytics). */
export function renderWatchTown(data, name) {
  const town = data?.towns?.find((x) => x.name === name);
  if (!town) return "";
  const enriched = { ...town, today: data.today };
  const level = town.level;
  const tone = { high_warning: "danger", warning: "danger", watch: "warning" }[level] || "info";
  return `<section class="card watch-card" aria-labelledby="watchTitle">
    <div class="card-head">
      <div><h2 id="watchTitle">${escapeHTML(t("watch.title", { town: name }))}</h2>
        <p>${escapeHTML(t("watch.sub", { when: formatDate(data.today) }))}</p></div>
      <button class="why" type="button" data-explain="watch" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>
    </div>
    <div class="notice notice-${tone}">${icon(level === "normal" || level === "no_data" ? "info" : "alert", { size: 18 })}<div>
      <div style="margin-bottom:4px">${watchBadge(level)}</div>
      <div>${escapeHTML(reasonLine(town))}</div>
      ${level !== "normal" && level !== "no_data" ? `<div>${escapeHTML(backingLine(data, level))}</div>` : ""}
      ${level === "normal" ? `<div>${escapeHTML(t("watch.normalNote"))}</div>` : ""}
    </div></div>
    ${dayStrip(enriched)}
    <p>${escapeHTML(floodsLine(town))}</p>
    ${disclaimer(data)}
  </section>`;
}

/**
 * Bar position for a town: its wettest 3 days against its own Watch / Warning /
 * High warning amounts. The track ends a little past the High warning amount so
 * every mark is visible; bigger rain fills the whole bar.
 */
export function barScale(town) {
  const th = town.thresholds_mm || {};
  const top = isNumber(th.high_warning) && th.high_warning > 0 ? th.high_warning * 1.25 : null;
  if (!top) return null;
  const at = (mm) => Math.max(0, Math.min(100, (100 * mm) / top));
  return {
    fill: isNumber(town.peak?.mm) ? at(town.peak.mm) : 0,
    marks: ["watch", "warning", "high_warning"].filter((k) => isNumber(th[k])).map((k) => ({ level: k, mm: th[k], at: at(th[k]) })),
  };
}

function chartRow(town, data) {
  const sc = barScale(town);
  const fillTone = { high_warning: "danger", warning: "danger", watch: "warning" }[town.level] || "normal";
  const need = town.thresholds_mm?.warning;
  const sub = town.peak
    ? t("watch.barSub", { mm: num(town.peak.mm, 0), need: isNumber(need) ? num(need, 0) : "—" })
    : t("watch.noData");
  return `<li>
    <button type="button" class="watch-row" data-watch-pick="${escapeHTML(town.name)}" aria-expanded="false" aria-controls="watchDetail">
      <span class="watch-row-name"><strong>${escapeHTML(town.name)}</strong>${watchBadge(town.level)}</span>
      <span class="watch-track" aria-hidden="true">
        ${sc ? `<span class="watch-fill watch-fill-${fillTone}" style="width:${sc.fill.toFixed(1)}%"></span>
        ${sc.marks.map((m) => `<span class="watch-mark watch-mark-${m.level}" style="left:${m.at.toFixed(1)}%" title="${escapeHTML(`${t(`watch.level.${m.level}`)}: ${num(m.mm, 0)} mm`)}"></span>`).join("")}` : ""}
      </span>
      <span class="watch-row-sub subtle">${escapeHTML(sub)}</span>
    </button>
  </li>`;
}

/** Detail for one town, shown under the chart when a bar is tapped. */
export function renderWatchDetail(data, name) {
  const town = data?.towns?.find((x) => x.name === name);
  if (!town) return "";
  const level = town.level;
  const th = town.thresholds_mm || {};
  return `<div class="watch-detail-inner">
    <div class="row" style="justify-content:space-between;align-items:center">
      <h3>${escapeHTML(town.name)}</h3>${watchBadge(level)}
    </div>
    <p>${escapeHTML(reasonLine(town))}</p>
    ${level !== "normal" && level !== "no_data" ? `<p>${escapeHTML(backingLine(data, level))}</p>` : ""}
    ${level === "normal" ? `<p class="subtle">${escapeHTML(t("watch.normalNote"))}</p>` : ""}
    ${dayStrip({ ...town, today: data.today })}
    ${isNumber(th.warning) ? `<p class="subtle">${escapeHTML(t("watch.amounts", { watch: num(th.watch, 0), warning: num(th.warning, 0), high: num(th.high_warning, 0) }))}</p>` : ""}
    <p>${escapeHTML(floodsLine(town))}</p>
    <a class="btn" href="#/analytics" data-watch-town="${escapeHTML(town.name)}">${escapeHTML(t("watch.openTown", { town: town.name }))}</a>
  </div>`;
}

/** Wire the chart: tapping a bar shows that town's detail below. */
export function mountWatchChart(root, data, onOpenTown) {
  const detail = root.querySelector("#watchDetail");
  if (!detail) return;
  const rows = [...root.querySelectorAll("[data-watch-pick]")];
  const pick = (name) => {
    rows.forEach((b) => {
      const on = b.dataset.watchPick === name;
      b.setAttribute("aria-expanded", String(on));
      b.classList.toggle("is-picked", on);
    });
    detail.innerHTML = renderWatchDetail(data, name);
    detail.querySelector("[data-watch-town]")?.addEventListener("click", (e) => onOpenTown?.(e.currentTarget.dataset.watchTown));
  };
  rows.forEach((b) => b.addEventListener("click", () => pick(b.dataset.watchPick)));
  if (data.towns?.length) pick(data.towns[0].name); // most serious town first
}

/** All towns, most serious first (Overview). */
export function renderWatchList(data) {
  if (!data?.towns?.length) return "";
  const raised = data.towns.filter((x) => ["high_warning", "warning", "watch"].includes(x.level));
  const head = raised.length
    ? t("watch.listRaised", { n: raised.length })
    : t("watch.listNone");
  return `<section class="card" style="margin-top:var(--space-4)" aria-labelledby="watchListTitle">
    <div class="card-head">
      <div><h2 id="watchListTitle">${escapeHTML(t("watch.listTitle"))}</h2><p>${escapeHTML(head)}</p></div>
      <button class="why" type="button" data-watch-why aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>
    </div>
    <div class="watch-legend subtle" aria-hidden="true">
      <span><i class="watch-mark watch-mark-watch"></i>${escapeHTML(t("watch.level.watch"))}</span>
      <span><i class="watch-mark watch-mark-warning"></i>${escapeHTML(t("watch.level.warning"))}</span>
      <span><i class="watch-mark watch-mark-high_warning"></i>${escapeHTML(t("watch.level.high_warning"))}</span>
    </div>
    <ul class="watch-chart">${data.towns.map((x) => chartRow(x, data)).join("")}</ul>
    <div id="watchDetail" class="watch-detail" aria-live="polite">
      <p class="subtle">${escapeHTML(t("watch.tapHint"))}</p>
    </div>
    ${disclaimer(data)}
  </section>`;
}

export function explainWatch(fil) {
  return fil ? `
    <p>Para sa bawat bayan, kinukuha ng AGOS ang forecast na ulan bawat araw (2 araw na nakaraan, ngayon at 2 susunod na araw) mula sa Open-Meteo. Ang pinakamalaking <strong>3-araw na kabuuan</strong> ay inihahambing sa sariling talaan ng bayan mula 1990.</p>
    <p><strong>Bantayan</strong>: top 5% ng talaan. <strong>Babalang tanda</strong>: top 2% (ang antas na pinili ng pagsusuring taon-taon). <strong>Mataas na babalang tanda</strong>: top 1%. Ito ang parehong tuntuning sinubok sa mga nakaraang baha sa "Gaano ito kaaasahan?".</p>
    <p>Ang "X% ng nakalistang baha" ay ilan sa mga nakaraang baha sa Bataan ang may ulang ganito kadalang bago bumaha. Hindi ito tsansa na babaha ngayon.</p>
    <p>Mga limitasyon: model forecast ang ulan at maaaring mali, lalo na sa thunderstorm at landas ng bagyo. Iba ang model ng forecast sa model ng talaan, kaya tinatayang ranggo lang ito. Hindi kasama ang tide, dike, ulan sa itaas ng ilog at drainage. Hindi ito opisyal na babala; sundin ang PAGASA at ang inyong MDRRMO.</p>` : `
    <p>For each town, AGOS takes the daily forecast rain (2 past days, today and the next 2 days) from Open-Meteo. The largest <strong>3-day total</strong> is compared with that town's own record since 1990.</p>
    <p><strong>Watch</strong>: top 5% of the record. <strong>Warning sign</strong>: top 2% (the level the year-by-year test chose). <strong>High warning sign</strong>: top 1%. This is the same rule tested against past floods under "How much can you trust this?".</p>
    <p>"X% of listed floods" is how many past Bataan floods had rain at least this unusual before they happened. It is not the chance of a flood now.</p>
    <p>Limits: forecast rain is model output and can be wrong, especially for thunderstorms and typhoon tracks. The forecast model is not the record's model, so the rank is approximate. Tide, dikes, upstream rain and drainage are not included. This is not an official warning; follow PAGASA and your MDRRMO.</p>`;
}
