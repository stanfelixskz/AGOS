/*
 * "Data analysis" section of the municipality page: the step-by-step
 * calculation behind the forecast numbers, from /api/analysis/{name}
 * (backend analysis_service.py). Every step shows its method and result.
 */

import { icon } from "../../core/icons.js";
import { t, getLang } from "../../core/i18n.js";
import { escapeHTML, num, formatTime, isNumber } from "../../core/format.js";
import { levelLabel, levelColor, THRESHOLDS } from "../../core/levels.js";
import { barChart, mountChart } from "../../core/charts.js";
import { riskColor, factorText } from "../../core/risk.js";

const n = (v, d = 1) => (isNumber(v) ? num(v, d) : "—");

function table(head, rows) {
  return `<div class="table-wrap"><table class="table analysis-table">
    <thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ""}>${escapeHTML(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td class="num">${c}</td>` : `<th scope="row">${c}</th>`)).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

function step(index, title, body, open = false) {
  return `<details class="analysis-step"${open ? " open" : ""}>
    <summary><span class="step-num">${index}</span><span class="analysis-step-title">${escapeHTML(title)}</span><span class="fold-chevron">${icon("chevronDown", { size: 18 })}</span></summary>
    <div class="analysis-step-body">${body}</div>
  </details>`;
}

const formula = (text) => `<p class="formula">${escapeHTML(text)}</p>`;
const note = (text) => `<p class="subtle analysis-note">${escapeHTML(text)}</p>`;

/** Plain-language summary built only from the computed numbers. */
function summary(a) {
  const s = a.steps;
  const rain = s.describe.next_24h.precipitation;
  const m = s.models.summary;
  const c = s.climate;
  const cls = s.classify;
  const parts = [];
  parts.push(t("an.sum.rain", { total: n(rain.sum), wet: rain.wet_hours ?? 0, peak: n(rain.max), level: levelLabel(cls.rain_level.level, getLang()) }));
  if (m.n) parts.push(t(`an.sum.models.${m.agreement}`, { n: m.n, min: n(m.min), max: n(m.max), yellow: m.models_yellow_or_above }));
  if (c.status === "ok" && c.forecast_24h) parts.push(t("an.sum.climate", { rank: n(c.forecast_24h.percentile_rank, 0), years: c.years, z: n(c.forecast_24h.z_score, 2) }));
  if (cls.flood_risk?.level) parts.push(t("an.sum.risk", { level: t(`risk.level.${cls.flood_risk.level}`), score: cls.flood_risk.score ?? "—" }));
  return `<div class="notice notice-info analysis-summary">${icon("info", { size: 18 })}<div><strong>${escapeHTML(t("an.summary"))}</strong><p>${parts.map(escapeHTML).join(" ")}</p></div></div>`;
}

function fetchStep(a) {
  const [fc, arch] = a.steps.fetch.sources;
  const g = fc.grid_point || {};
  return step(1, t("an.s1"), `
    <p>${escapeHTML(t("an.s1.intro"))}</p>
    ${table([t("an.col.item"), t("an.col.value")], [
      [escapeHTML(t("an.s1.source")), escapeHTML(fc.name)],
      [escapeHTML(t("an.s1.vars")), escapeHTML(String(fc.params.hourly).replaceAll(",", ", "))],
      [escapeHTML(t("an.s1.models")), escapeHTML(String(fc.params.models).replaceAll(",", ", "))],
      [escapeHTML(t("an.s1.range")), `${escapeHTML(formatTime(fc.first))} → ${escapeHTML(formatTime(fc.last))}`],
      [escapeHTML(t("an.s1.received")), `${fc.received_hours} ${escapeHTML(t("an.hours"))}`],
      [escapeHTML(t("an.s1.grid")), `${n(g.latitude, 3)}°N, ${n(g.longitude, 3)}°E · ${n(g.elevation_m, 0)} m`],
      [escapeHTML(t("an.s1.archive")), escapeHTML(`${arch.name} · ${arch.params?.start_date || "—"} → ${arch.params?.end_date || "—"}`)],
      [escapeHTML(t("an.s1.archiveDays")), `${arch.received_days ?? "—"} ${escapeHTML(t("an.days"))}`],
    ])}
    ${note(t("an.s1.note", { time: formatTime(a.steps.fetch.fetched_at) }))}`, true);
}

function cleanStep(a) {
  const rows = a.steps.clean.reports.map((r) => [
    escapeHTML(r.variable), r.received, r.missing, r.duplicates, r.out_of_range, r.gaps,
    `<span class="${r.valid_percent < 90 ? "analysis-bad" : ""}">${n(r.valid_percent, 1)}%</span>`,
  ]);
  return step(2, t("an.s2"), `
    <p>${escapeHTML(t("an.s2.intro"))}</p>
    ${table([t("an.col.variable"), t("an.col.received"), t("an.col.missing"), t("an.col.duplicates"), t("an.col.invalid"), t("an.col.gaps"), t("an.col.valid")], rows)}
    ${note(t("an.s2.rules"))}`);
}

function describeStep(a) {
  const d = a.steps.describe;
  const r = d.next_24h.precipitation;
  const row = (label, s, unit, digits = 1) => [escapeHTML(label), `${n(s.mean, digits)} ${unit}`, `${n(s.min, digits)} ${unit}`, `${n(s.max, digits)} ${unit}`, `${n(s.std, digits)}`];
  return step(3, t("an.s3"), `
    <p>${escapeHTML(t("an.s3.intro"))}</p>
    ${table([t("an.col.rainWindow"), t("an.col.value")], [
      [escapeHTML(t("an.s3.total24")), `${n(r.sum)} mm`],
      [escapeHTML(t("an.s3.peak")), `${n(r.max)} mm/h${r.peak_time && isNumber(r.max) && r.max > 0 ? ` · ${escapeHTML(formatTime(r.peak_time))}` : ""}`],
      [escapeHTML(t("an.s3.max3h")), `${n(r.max_3h)} mm`],
      [escapeHTML(t("an.s3.wet")), `${r.wet_hours ?? "—"} / ${r.n}`],
      [escapeHTML(t("an.s3.total72")), `${n(d.next_72h_precipitation.sum)} mm`],
      [escapeHTML(t("an.s3.past7")), `${n(d.past_7d_precipitation.sum)} mm · ${d.past_7d_precipitation.wet_hours ?? "—"} ${escapeHTML(t("an.s3.wetHours"))}`],
    ])}
    ${formula(t("an.s3.f1"))}
    ${formula(t("an.s3.f2"))}
    ${table([t("an.col.variable24"), t("an.col.mean"), t("an.col.min"), t("an.col.max"), t("an.col.std")], [
      row(t("an.var.temp"), d.next_24h.temperature_2m, "°C"),
      row(t("an.var.rh"), d.next_24h.relative_humidity_2m, "%", 0),
      row(t("an.var.cloud"), d.next_24h.cloud_cover, "%", 0),
      row(t("an.var.wind"), d.next_24h.wind_speed_10m, "km/h", 0),
    ])}`);
}

function modelsStep(a) {
  const m = a.steps.models;
  const s = m.summary;
  const rows = m.per_model.map((x) => [escapeHTML(x.label), `${n(x.total_24h)} mm`, `${n(x.peak_mm_h)} mm/h`,
    s.levels?.[x.model] ? `<span class="hc-dot" style="background:${levelColor(s.levels[x.model])}"></span> ${escapeHTML(levelLabel(s.levels[x.model], getLang()))}` : "—"]);
  return step(4, t("an.s4"), `
    <p>${escapeHTML(t("an.s4.intro"))}</p>
    <div class="detail-chart" data-an-chart="models" aria-label="${escapeHTML(t("an.s4.chart"))}"></div>
    ${table([t("an.col.model"), t("an.col.total24"), t("an.col.peak"), t("an.col.level")], rows)}
    ${s.n ? table([t("an.col.statistic"), t("an.col.value")], [
      [escapeHTML(t("an.s4.mean")), `${n(s.mean)} mm`], [escapeHTML(t("an.s4.median")), `${n(s.median)} mm`],
      [escapeHTML(t("an.s4.std")), `${n(s.std)} mm`], [escapeHTML(t("an.s4.range")), `${n(s.min)} – ${n(s.max)} mm`],
      [escapeHTML(t("an.s4.cv")), n(s.cv, 2)],
      [escapeHTML(t("an.s4.agreement")), `<strong>${escapeHTML(t(`an.agree.${s.agreement}`))}</strong>`],
      [escapeHTML(t("an.s4.reach")), escapeHTML(t("an.s4.reachValue", { y: s.models_yellow_or_above, o: s.models_orange_or_above, r: s.models_red, n: s.models_with_peak }))],
    ]) : ""}
    ${formula(t("an.s4.f1"))}
    ${note(t("an.s4.rule"))}
    ${note(t("an.s4.note"))}`);
}

function climateStep(a) {
  const c = a.steps.climate;
  if (c.status !== "ok") return step(5, t("an.s5"), `<div class="notice">${icon("alert", { size: 18 })}<div>${escapeHTML(t("an.s5.na"))} ${escapeHTML(c.detail || "")}</div></div>`);
  const f = c.forecast_24h;
  const f3 = c.forecast_72h;
  const rel = (x) => (x ? `${n(x.percentile_rank, 1)} · z = ${n(x.z_score, 2)}${x.about_one_in ? ` · ${escapeHTML(t("an.s5.oneIn", { n: x.about_one_in }))}` : ""}` : "—");
  return step(5, t("an.s5"), `
    <p>${escapeHTML(t("an.s5.intro", { years: c.years, window: c.window, n: c.n_days }))}</p>
    <div class="detail-chart" data-an-chart="climate" aria-label="${escapeHTML(t("an.s5.chart"))}"></div>
    ${table([t("an.col.statistic"), t("an.col.value")], [
      [escapeHTML(t("an.s5.mean")), `${n(c.daily.mean)} mm (σ ${n(c.daily.std)})`],
      [escapeHTML(t("an.s5.pcts")), `P50 ${n(c.daily.p50)} · P75 ${n(c.daily.p75)} · P90 ${n(c.daily.p90)} · P95 ${n(c.daily.p95)} · P99 ${n(c.daily.p99)} mm`],
      [escapeHTML(t("an.s5.max")), `${n(c.daily.max)} mm`],
      [escapeHTML(t("an.s5.wetDays")), `${n(c.daily.wet_day_percent, 1)}%`],
      [escapeHTML(t("an.s5.f24", { v: n(f?.value) })), rel(f)],
      [escapeHTML(t("an.s5.f72", { v: n(f3?.value) })), rel(f3)],
    ])}
    ${formula(t("an.s5.f1"))}
    ${formula(t("an.s5.f2"))}
    ${note(t("an.s5.note"))}`);
}

function skillStep(a) {
  const k = a.steps.skill.result;
  if (!k || k.status !== "ok") {
    return step(6, t("an.s6"), `<p>${escapeHTML(t("an.s6.intro"))}</p><div class="notice">${icon("info", { size: 18 })}<div>${escapeHTML(t("an.s6.none", { days: k?.days ?? 0 }))}</div></div>`);
  }
  return step(6, t("an.s6"), `
    <p>${escapeHTML(t("an.s6.intro"))}</p>
    ${table([t("an.col.statistic"), t("an.col.value")], [
      [escapeHTML(t("an.s6.days")), `${k.days} (${k.rain_days_observed} ${escapeHTML(t("an.s6.rainy"))})`],
      [escapeHTML(t("an.s6.correct")), `${n(k.rain_no_rain_correct_percent, 1)}%`],
      [escapeHTML(t("an.s6.mae")), `${n(k.mean_absolute_error_mm, 2)} mm`],
      [escapeHTML(t("an.s6.bias")), n(k.bias_ratio, 3)],
      [escapeHTML(t("an.s6.adjusted")), `${n(a.steps.skill.adjusted_24h_mm)} mm (× ${n(k.adjustment_factor, 3)})`],
    ])}
    ${formula(t("an.s6.f1"))}
    ${note(t("an.s6.noteOk"))}`);
}

function classifyStep(a) {
  const c = a.steps.classify;
  const cond = c.condition_24h;
  const risk = c.flood_risk;
  const scored = (risk?.factors || []).filter((f) => f.points > 0 || f.held_back);
  return step(7, t("an.s7"), `
    ${table([t("an.col.result"), t("an.col.value")], [
      [escapeHTML(t("an.s7.level")), `<span class="hc-dot" style="background:${levelColor(c.rain_level.level)}"></span> ${escapeHTML(levelLabel(c.rain_level.level, getLang()))} (${n(c.rain_level.peak_mm_h)} mm/h)`],
      [escapeHTML(t("an.s7.condition")), escapeHTML(`${t(`an.cond.${cond.rain}`)}${cond.sky ? ` · ${t(`an.sky.${cond.sky}`)}` : ""}`)],
      [escapeHTML(t("an.s7.code")), escapeHTML(c.model_weather_code.code === null ? "—" : `${c.model_weather_code.code} · ${c.model_weather_code.meaning || "?"}`)],
      [escapeHTML(t("an.s7.risk")), risk?.level ? `<span class="hc-dot" style="background:${riskColor(risk.level)}"></span> ${escapeHTML(t(`risk.level.${risk.level}`))} · ${escapeHTML(t("risk.points", { n: risk.score ?? "—" }))}` : "—"],
    ])}
    ${note(t("an.s7.levelRule", { y: THRESHOLDS.yellow, o: THRESHOLDS.orange, r: THRESHOLDS.redAbove }))}
    ${note(t("an.s7.condRule"))}
    ${note(t("an.s7.codeNote"))}
    ${scored.length ? `<p style="margin-top:8px"><strong>${escapeHTML(t("an.s7.riskWhy"))}</strong></p><ul class="risk-factors">${scored.map((f) => `<li>${escapeHTML(factorText(f))}</li>`).join("")}</ul>` : ""}
    ${risk?.level ? note(`${t("risk.levelsRule")} ${t("an.s7.riskDraft")}`) : ""}`);
}

export function renderAnalysis(a) {
  return `<section class="card analysis" id="analysis" aria-labelledby="analysisHeading">
    <div class="detail-head"><h2 id="analysisHeading">${escapeHTML(t("an.title"))}</h2></div>
    <p class="muted">${escapeHTML(t("an.intro"))}</p>
    ${summary(a)}
    ${fetchStep(a)}${cleanStep(a)}${describeStep(a)}${modelsStep(a)}${climateStep(a)}${skillStep(a)}${classifyStep(a)}
    <p class="source-line">${escapeHTML(t("an.foot", { time: formatTime(a.generated_at) }))}</p>
  </section>`;
}

/** Charts for steps 4 and 5. Returns a cleanup function. */
export function hydrateAnalysis(root, a) {
  const cleanups = [];
  const modelsEl = root.querySelector('[data-an-chart="models"]');
  if (modelsEl) {
    const bars = a.steps.models.per_model.map((m) => ({
      label: m.label.split(" ")[0], value: m.total_24h,
      color: levelColor(a.steps.models.summary.levels?.[m.model] || "little"),
      title: `${m.label}: ${isNumber(m.total_24h) ? `${m.total_24h} mm` : "no data"}`,
    }));
    cleanups.push(mountChart(modelsEl, (width) => barChart(bars, { width, height: 150, unit: "mm", xLabelEvery: 1, minMax: 5, ariaLabel: t("an.s4.chart") })));
  }
  const climateEl = root.querySelector('[data-an-chart="climate"]');
  const c = a.steps.climate;
  if (climateEl && c.status === "ok") {
    const value = c.forecast_24h?.value;
    const bars = c.daily.histogram.map((b) => {
      const inBin = isNumber(value) && value >= b.from && (b.to === null || value < b.to);
      const label = b.to === null ? `≥${b.from}` : `${b.from}–${b.to}`;
      return { label, value: b.count, color: inBin ? "#dc2626" : "var(--brand)", title: `${label} mm: ${b.count} ${t("an.days")}${inBin ? ` · ${t("an.s5.forecastBin")}` : ""}` };
    });
    cleanups.push(mountChart(climateEl, (width) => barChart(bars, { width, height: 150, unit: t("an.days"), xLabelEvery: 1, ariaLabel: t("an.s5.chart") })));
  }
  return () => cleanups.forEach((fn) => fn());
}
