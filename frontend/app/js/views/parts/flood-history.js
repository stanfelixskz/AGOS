/*
 * Analytics: the flood-risk indicator rebuilt for each past day since
 * 1 August (/api/flood-risk/history, backend flood_history_service.py).
 * A town-by-day calendar coloured by level; a click shows that day's reasons.
 */

import { t } from "../../core/i18n.js";
import { getJSON } from "../../core/api.js";
import { escapeHTML, num, isNumber, formatDate, parseTime } from "../../core/format.js";
import { barChart, mountChart } from "../../core/charts.js";
import { loadingState, errorState, onRetry } from "../../core/ui.js";
import { RISK_IDS, riskColor, factorText } from "../../core/risk.js";

const RANK = { nodata: -1, low: 0, moderate: 1, high: 2, very_high: 3 };

function shortDate(iso) {
  const d = parseTime(iso);
  return d ? d.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" }) : iso;
}

/** Same reason text as the live indicator, with the history wording for each time window. */
function historyFactorText(factor) {
  const live = factorText(factor);
  const liveLabel = t(`risk.f.${factor.id}`);
  const key = `fh.f.${factor.id}`;
  const label = t(key);
  return label !== key && live.startsWith(liveLabel) ? label + live.slice(liveLabel.length) : live;
}

function levelText(level, score) {
  return `${t(`risk.level.${level}`)}${isNumber(score) ? ` · ${t("risk.points", { n: score })}` : ""}`;
}

/** "town|date" -> reported flood event, for every day inside an event window. */
function reportedIndex(h) {
  const index = new Map();
  for (const event of h.reported_floods || []) {
    for (const town of event.towns) {
      for (const day of h.days) {
        if (day >= event.start && day <= event.end) index.set(`${town}|${day}`, event);
      }
    }
  }
  return index;
}

function calendar(h, reported) {
  const months = [];
  h.days.forEach((d, i) => {
    const month = parseTime(d)?.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short" });
    if (!months.length || months[months.length - 1].label !== month) months.push({ label: month, start: i, span: 1 });
    else months[months.length - 1].span += 1;
  });
  const cols = `grid-template-columns: 7.5em repeat(${h.days.length}, minmax(6px, 1fr))`;
  return `<div class="fh-cal-wrap"><div class="fh-cal" style="${cols}" role="grid" aria-label="${escapeHTML(t("fh.calendar"))}">
    <span></span>${months.map((m) => `<span class="fh-month" style="grid-column: span ${m.span}">${escapeHTML(m.label)}</span>`).join("")}
    ${h.municipalities.map((town) => `
      <span class="fh-town">${escapeHTML(town.municipality)}</span>
      ${town.days.map((d) => {
        const event = reported.get(`${town.municipality}|${d.date}`);
        return `<button type="button" class="fh-cell${event ? " is-reported" : ""}" style="background:${riskColor(d.level)}"
          data-town="${escapeHTML(town.municipality)}" data-date="${d.date}"
          title="${escapeHTML(`${town.municipality} · ${shortDate(d.date)}: ${levelText(d.level, d.score)} · ${isNumber(d.rain_mm) ? `${num(d.rain_mm, 1)} mm` : "—"}${event ? ` · ${t("fh.reportedTip")}` : ""}`)}"
          aria-label="${escapeHTML(`${town.municipality}, ${formatDate(d.date)}: ${levelText(d.level, d.score)}${event ? `. ${t("fh.reportedTip")}` : ""}`)}"></button>`;
      }).join("")}`).join("")}
  </div></div>`;
}

function summaryTable(h) {
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th>${escapeHTML(t("common.municipality"))}</th>
      <th class="num">${escapeHTML(t("risk.level.moderate"))}</th><th class="num">${escapeHTML(t("risk.level.high"))}</th><th class="num">${escapeHTML(t("risk.level.very_high"))}</th>
      <th class="num">${escapeHTML(t("fh.rainTotal"))}</th><th>${escapeHTML(t("fh.worstDay"))}</th></tr></thead>
    <tbody>${[...h.municipalities].sort((a, b) => (b.summary.worst_score ?? -1) - (a.summary.worst_score ?? -1)).map((town) => {
      const s = town.summary;
      return `<tr><th scope="row">${escapeHTML(town.municipality)}</th>
        <td class="num">${s.moderate}</td><td class="num">${s.high}</td><td class="num">${s.very_high}</td>
        <td class="num">${escapeHTML(num(s.rain_total_mm, 0))} mm</td>
        <td>${s.worst_day ? `<button type="button" class="btn btn-sm btn-ghost fh-open" data-town="${escapeHTML(town.municipality)}" data-date="${s.worst_day}"><span class="hc-dot" style="background:${riskColor(s.worst_level)}"></span> ${escapeHTML(shortDate(s.worst_day))} · ${escapeHTML(levelText(s.worst_level, s.worst_score))}</button>` : "—"}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function eventsList(h) {
  if (!h.events.length) return `<p class="muted">${escapeHTML(t("fh.noEvents"))}</p>`;
  return `<ol class="fh-events">${h.events.slice(0, 10).map((e) => `<li>
    <button type="button" class="fh-open fh-event" data-town="${escapeHTML(e.municipality)}" data-date="${e.date}">
      <span class="hc-dot" style="background:${riskColor(e.level)}"></span>
      <strong>${escapeHTML(e.municipality)}</strong> · ${escapeHTML(shortDate(e.date))} · ${escapeHTML(levelText(e.level, e.score))}
      <span class="subtle">· ${escapeHTML(isNumber(e.rain_mm) ? `${num(e.rain_mm, 1)} mm` : "—")}${isNumber(e.peak_mm_h) ? ` · ${escapeHTML(t("fh.peak", { mm: num(e.peak_mm_h, 1) }))}` : ""}</span>
    </button></li>`).join("")}</ol>`;
}

function sourceLinks(sources) {
  return sources.map((s) => `<a href="${escapeHTML(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(s.name)}</a>`).join(" · ");
}

function evaluationTable(h) {
  const rows = h.evaluation || [];
  if (!rows.length) return "";
  const sum = h.evaluation_summary;
  return `<h3 style="margin-top:var(--space-4)">${escapeHTML(t("fh.evalTitle"))}</h3>
    <p class="subtle">${escapeHTML(t("fh.evalSummary", { mod: sum.moderate_or_above, high: sum.high_or_above, n: sum.town_events }))}</p>
    <div class="table-wrap"><table class="table fh-eval">
      <thead><tr><th>${escapeHTML(t("fh.evalReported"))}</th><th>${escapeHTML(t("common.municipality"))}</th><th>${escapeHTML(t("fh.evalIndicator"))}</th><th class="num">${escapeHTML(t("fh.rainTotal"))}</th><th class="num">${escapeHTML(t("fh.evalUpstream"))}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <th scope="row"><button type="button" class="fh-open fh-event" data-town="${escapeHTML(r.municipality)}" data-date="${r.date}"><strong>${escapeHTML(r.start === r.end ? shortDate(r.start) : `${shortDate(r.start)}–${shortDate(r.end)}`)}</strong></button>
          <div class="subtle">${escapeHTML(r.summary)}</div><div class="subtle">${sourceLinks(r.sources)}</div></th>
        <td>${escapeHTML(r.municipality)}</td>
        <td><span class="row" style="gap:6px;flex-wrap:nowrap"><span class="hc-dot" style="background:${riskColor(r.level)}"></span>${escapeHTML(levelText(r.level, r.score))}</span><div class="subtle">${escapeHTML(shortDate(r.date))}</div></td>
        <td class="num">${isNumber(r.rain_mm) ? `${escapeHTML(num(r.rain_mm, 1))} mm` : "—"}</td>
        <td class="num">${isNumber(r.upstream_mm) ? `${escapeHTML(num(r.upstream_mm, 1))} mm` : "—"}</td>
      </tr>`).join("")}</tbody></table></div>
    <p class="subtle" style="margin-top:6px">${escapeHTML(t("fh.evalNote"))}</p>`;
}

function dayDetail(h, townName, date) {
  const town = h.municipalities.find((m) => m.municipality === townName);
  const day = town?.days.find((d) => d.date === date);
  if (!day) return "";
  const event = reportedIndex(h).get(`${townName}|${date}`);
  const shown = day.factors.filter((f) => f.points > 0 || f.held_back);
  const rest = day.factors.filter((f) => !(f.points > 0 || f.held_back));
  return `<div class="fh-detail" style="border-left-color:${riskColor(day.level)}">
    <div class="row" style="justify-content:space-between"><strong>${escapeHTML(townName)} · ${escapeHTML(formatDate(date))}</strong>
      <span class="row" style="gap:6px"><span class="hc-dot" style="background:${riskColor(day.level)}"></span>${escapeHTML(levelText(day.level, day.score))}</span></div>
    ${event ? `<div class="notice notice-info" style="margin-top:8px"><div><strong>${escapeHTML(t("fh.reportedTip"))}:</strong> ${escapeHTML(event.summary)}<div class="subtle">${sourceLinks(event.sources)}</div></div></div>` : ""}
    ${shown.length ? `<p class="subtle" style="margin-top:6px">${escapeHTML(t("fh.because"))}</p><ul class="risk-factors">${shown.map((f) => `<li>${escapeHTML(historyFactorText(f))}</li>`).join("")}</ul>` : `<p class="subtle" style="margin-top:6px">${escapeHTML(t("fh.nothing"))}</p>`}
    <details style="margin-top:6px"><summary class="subtle">${escapeHTML(t("fh.allInputs"))}</summary><ul class="risk-factors">${rest.map((f) => `<li>${escapeHTML(historyFactorText(f))}</li>`).join("")}</ul></details>
  </div>`;
}

export async function mountFloodHistory(slot) {
  let alive = true;
  let chartCleanup = null;
  let data = null;

  function open(townName, date) {
    const panel = slot.querySelector("#fhDetail");
    panel.innerHTML = dayDetail(data, townName, date);
    slot.querySelectorAll(".fh-cell.is-selected").forEach((el) => el.classList.remove("is-selected"));
    slot.querySelector(`.fh-cell[data-town="${CSS.escape(townName)}"][data-date="${date}"]`)?.classList.add("is-selected");
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function render() {
    const h = data;
    const maxPerDay = h.days.map((d, i) => {
      const cells = h.municipalities.map((m) => m.days[i]);
      const top = cells.reduce((a, b) => (RANK[b.level] > RANK[a.level] || (RANK[b.level] === RANK[a.level] && (b.score ?? -1) > (a.score ?? -1)) ? b : a));
      return { label: shortDate(d), value: top.score, color: riskColor(top.level), title: `${shortDate(d)}: ${levelText(top.level, top.score)}` };
    });
    slot.innerHTML = `<section class="card" aria-labelledby="fhTitle">
      <div class="card-head"><div><h2 id="fhTitle">${escapeHTML(t("fh.title", { start: formatDate(h.start) }))}</h2>
        <p>${escapeHTML(t("fh.sub", { end: formatDate(h.end), n: h.days.length }))}</p></div>
        <span class="badge badge-warning">${escapeHTML(t("risk.draft"))}</span></div>
      <ul class="swatches fh-legend">${RISK_IDS.map((id) => `<li><span class="swatch" style="background:${riskColor(id)}"></span>${escapeHTML(t(`risk.level.${id}`))}</li>`).join("")}<li><span class="swatch fh-reported-swatch"></span>${escapeHTML(t("fh.reportedLegend"))}</li></ul>
      ${calendar(h, reportedIndex(h))}
      <div id="fhDetail" aria-live="polite"><p class="subtle">${escapeHTML(t("fh.clickHint"))}</p></div>
      ${evaluationTable(h)}
      <h3 style="margin-top:var(--space-4)">${escapeHTML(t("fh.dailyMax"))}</h3>
      <div class="detail-chart" id="fhChart"></div>
      <h3 style="margin-top:var(--space-4)">${escapeHTML(t("fh.byTown"))}</h3>${summaryTable(h)}
      <h3 style="margin-top:var(--space-4)">${escapeHTML(t("fh.events"))}</h3>${eventsList(h)}
      <p class="card-foot">${escapeHTML(t("fh.foot"))} ${escapeHTML(t("risk.levelsRule"))}</p>
    </section>`;
    slot.querySelectorAll(".fh-cell, .fh-open").forEach((el) => el.addEventListener("click", () => open(el.dataset.town, el.dataset.date)));
    chartCleanup?.();
    chartCleanup = mountChart(slot.querySelector("#fhChart"), (width) => barChart(maxPerDay, {
      width, height: 140, unit: t("fh.pts"), minMax: 6, ariaLabel: t("fh.dailyMax"),
      xLabelEvery: Math.max(1, Math.ceil(maxPerDay.length / Math.max(3, Math.floor(width / 70)))),
      guides: [{ value: 3, label: t("risk.level.moderate"), color: "#ca8a04" }, { value: 6, label: t("risk.level.high"), color: "#ea580c" }, { value: 9, label: t("risk.level.very_high"), color: "#b91c1c" }],
    }));
  }

  async function load() {
    slot.innerHTML = `<section class="card">${loadingState(t("fh.loading"))}</section>`;
    try {
      data = await getJSON("/api/flood-risk/history", { ttlMs: 30 * 60 * 1000, timeoutMs: 120000 });
      if (alive) render();
    } catch (error) {
      if (!alive) return;
      slot.innerHTML = `<section class="card">${errorState(error)}</section>`;
      onRetry(slot, load);
    }
  }

  await load();
  return () => {
    alive = false;
    chartCleanup?.();
  };
}
