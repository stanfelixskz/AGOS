/*
 * Analytics: "Floods and the rain before them". For each known past flood
 * (/api/flood-evidence) it shows how unusual the rain and modeled river flow were
 * in the flooded towns, against each town's own record, and compares the share
 * of "unusually wet" cases with what the same season gives by chance.
 * Nothing here is a forecast; it is the check that a forecast method must pass.
 */

import { icon } from "../../core/icons.js";
import { t } from "../../core/i18n.js";
import { escapeHTML, num, isNumber, formatDate } from "../../core/format.js";

/** "99th" style rank label from a 0-100 percentile. */
export function rankLabel(p) {
  if (!isNumber(p)) return "—";
  if (p >= 99.5) return t("evidence.rankTop1");
  return t("evidence.rank", { p: num(Math.floor(p), 0) });
}

/**
 * Plain verdict from the summary, by a fixed rule:
 * fewer than 8 events tested -> too few; otherwise the share of cases in the top 5%
 * must beat the season-matched chance by more than 2 standard errors, using the
 * number of EVENTS (not town-cases) because towns hit by the same storm are not independent.
 */
export function verdict(summary) {
  const n = summary?.events_with_rain_data || 0;
  const share = summary?.share_top5;
  const chance = summary?.chance_top5;
  if (n < 8 || !isNumber(share) || !isNumber(chance)) return { key: "evidence.verdictFew", level: "info" };
  const se = Math.sqrt((chance * (1 - chance)) / n);
  if (share - chance > 2 * se) return { key: "evidence.verdictWetter", level: "success" };
  return { key: "evidence.verdictUnclear", level: "warning" };
}

function townList(towns) {
  return towns.map((tw) => {
    if (tw.status !== "ok") {
      const why = tw.status === "outside_record" ? t("evidence.beforeRecord") : t("evidence.incomplete");
      return `<li>${escapeHTML(tw.municipality)}: <span class="subtle">${escapeHTML(why)}</span></li>`;
    }
    const flow = isNumber(tw.max_flow_percentile) ? ` · ${escapeHTML(t("evidence.flowShort", { rank: rankLabel(tw.max_flow_percentile) }))}` : "";
    return `<li>${escapeHTML(tw.municipality)}: ${escapeHTML(num(tw.max_3day_mm, 0))} mm / 3 d (${escapeHTML(rankLabel(tw.max_3day_percentile))})${flow}</li>`;
  }).join("");
}

/** "Sep 7–8, 2026", "Jul 30 – Aug 2, 2021", or one date. */
export function dateRange(start, end) {
  if (!start) return "—";
  if (!end || start === end) return formatDate(start);
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  const month = (d) => d.toLocaleDateString("en-PH", { month: "short" });
  if (a.getFullYear() !== b.getFullYear()) return `${formatDate(start)} – ${formatDate(end)}`;
  if (a.getMonth() === b.getMonth()) return `${month(a)} ${a.getDate()}–${b.getDate()}, ${a.getFullYear()}`;
  return `${month(a)} ${a.getDate()} – ${month(b)} ${b.getDate()}, ${a.getFullYear()}`;
}

function eventRow(e) {
  const tested = e.towns.filter((tw) => tw.status === "ok");
  const flows = tested.map((tw) => tw.max_flow_percentile).filter(isNumber).sort((a, b) => a - b);
  const flowMedian = flows.length ? flows[Math.floor((flows.length - 1) / 2)] : null;
  const source = e.sources?.[0];
  const when = dateRange(e.start_date, e.end_date);
  const meta = [e.storm, t(`evidence.conf.${e.confidence || "low"}`)].filter(Boolean).join(" · ");
  const rank = tested.length
    ? `${escapeHTML(rankLabel(e.median_3day_percentile))}${e.any_top5 ? `<div><span class="badge badge-danger">${escapeHTML(t("evidence.top5"))}</span></div>` : ""}`
    : `<span class="subtle">${escapeHTML(t("evidence.notTestable"))}</span>`;
  return `<tr>
    <th scope="row" class="evidence-date">${escapeHTML(when)}<div class="subtle">${escapeHTML(meta)}${source ? ` · <a href="${escapeHTML(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(source.publisher)}</a>` : ""}</div></th>
    <td class="hide-sm evidence-towns-cell">${e.towns.length
      ? `<details><summary>${escapeHTML(t(e.towns.length === 1 ? "evidence.towns1" : "evidence.townsN", { n: e.towns.length }))}</summary><ul class="evidence-towns">${townList(e.towns)}</ul></details>`
      : `<span class="subtle">${escapeHTML(t("evidence.noFloodedTown"))}</span>`}</td>
    <td class="num hide-sm">${isNumber(e.max_3day_mm) ? `${escapeHTML(num(e.max_3day_mm, 0))} mm` : "—"}</td>
    <td class="num">${rank}</td>
    <td class="num hide-sm">${escapeHTML(rankLabel(flowMedian))}</td>
  </tr>`;
}

export function renderEvidence(data) {
  if (!data?.summary) return "";
  const s = data.summary;
  const v = verdict(s);
  const pct = (x) => (isNumber(x) ? `${num(x * 100, 0)}%` : "—");
  return `
    <section class="card" style="margin-top:var(--space-4)" aria-labelledby="evidenceTitle">
      <div class="card-head">
        <div><h2 id="evidenceTitle">${escapeHTML(t("evidence.title"))}</h2>
          <p>${escapeHTML(t("evidence.sub", { tested: s.events_with_rain_data, dated: s.events_dated, all: s.events }))}</p></div>
        <button class="why" type="button" data-explain="evidence" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>
      </div>
      <div class="grid grid-3" style="margin-bottom:var(--space-3)">
        <div class="stat"><span class="stat-label">${escapeHTML(t("evidence.shareWet"))}</span><span class="stat-value num">${escapeHTML(pct(s.share_top5))}</span><span class="subtle">${escapeHTML(t("evidence.cases", { k: s.cases_top5, n: s.cases }))}</span></div>
        <div class="stat"><span class="stat-label">${escapeHTML(t("evidence.chance"))}</span><span class="stat-value num">${escapeHTML(pct(s.chance_top5))}</span><span class="subtle">${escapeHTML(t("evidence.chanceSub"))}</span></div>
        <div class="stat"><span class="stat-label">${escapeHTML(t("evidence.typical"))}</span><span class="stat-value num">${escapeHTML(rankLabel(s.median_3day_percentile))}</span><span class="subtle">${escapeHTML(t("evidence.flowTypical", { rank: rankLabel(s.median_flow_percentile), n: s.cases_with_flow }))}</span></div>
      </div>
      <div class="notice notice-${v.level}">${icon("info", { size: 18 })}<div>${escapeHTML(t(v.key))}</div></div>
      <div class="table-wrap" style="margin-top:var(--space-3)"><table class="table">
        <thead><tr>
          <th scope="col">${escapeHTML(t("evidence.colDate"))}</th>
          <th scope="col" class="hide-sm">${escapeHTML(t("evidence.colTowns"))}</th>
          <th scope="col" class="num hide-sm">${escapeHTML(t("evidence.col3day"))}</th>
          <th scope="col" class="num">${escapeHTML(t("evidence.colRank"))}</th>
          <th scope="col" class="num hide-sm">${escapeHTML(t("evidence.colFlow"))}</th>
        </tr></thead>
        <tbody>${data.events.map(eventRow).join("")}</tbody>
      </table></div>
      ${s.cases_outside_record ? `<p class="subtle">${escapeHTML(t("evidence.outside", { n: s.cases_outside_record, first: data.record?.first ? formatDate(data.record.first) : "—" }))}</p>` : ""}
      <p class="card-foot">${escapeHTML(t("evidence.foot"))}</p>
    </section>`;
}

export function explainEvidence(fil) {
  return fil ? `
    <p>Para sa bawat nakaraang baha na may petsa, tinitingnan ng AGOS ang ulan sa mga bayang sinabing binaha, mula <strong>2 araw bago</strong> hanggang sa huling araw ng baha. Ang pinakamalaking <strong>3-araw na kabuuan</strong> ay inihahambing sa buong talaan ng parehong bayan: ang "ika-99" ay mas maulan kaysa 99% ng lahat ng 3-araw na yugto.</p>
    <p>Ang <strong>tsansa</strong> ay kung gaano kadalas umaabot sa top 5% ang isang yugtong kapareho ang haba at <strong>kapareho ang panahon</strong> (30 araw bago o pagkatapos ng parehong petsa, alinmang taon). Kailangan ito dahil sa tag-ulan nangyayari ang baha, at mas maulan talaga ang tag-ulan.</p>
    <p>Ang <strong>hatol</strong> ay sumusunod sa isang tuntunin: kailangan ng hindi bababa sa 8 baha, at dapat lumampas ang bahagi sa tsansa nang higit sa 2 standard error. Bilang ng <strong>baha</strong> ang ginagamit, hindi ng bayan, dahil hindi magkahiwalay ang mga bayang tinamaan ng iisang bagyo.</p>
    <p>Mga limitasyon: ERA5 reanalysis (modeled) at GloFAS (modeled, 8 sa 12 bayan) ang datos. Maaaring galing ang baha sa ulan sa itaas ng ilog, sa high tide o sa nasirang dike. Kulang sa maliliit na baha ang listahan. Hindi ito forecast.</p>` : `
    <p>For every dated past flood, AGOS looks at the rain in the towns the sources name as flooded, from <strong>2 days before</strong> to the last flood day. The largest <strong>3-day total</strong> is compared with that town's whole record: "99th" means wetter than 99% of all 3-day spells.</p>
    <p>The <strong>chance</strong> figure is how often a window of the same length, in <strong>the same season</strong> (ending within 30 days of the same date, any year), reaches the town's top 5%. This matters because floods happen in the wet season, which is wetter anyway.</p>
    <p>The <strong>verdict</strong> follows a fixed rule: at least 8 floods tested, and the share must beat chance by more than 2 standard errors. It counts <strong>floods</strong>, not towns, because towns hit by the same storm are not independent.</p>
    <p>Limits: rain is ERA5 reanalysis (modeled) and flow is GloFAS (modeled, 8 of 12 towns). Floods can come from upstream rain, high tide or broken dikes. The events list misses small floods. This is not a forecast.</p>`;
}
