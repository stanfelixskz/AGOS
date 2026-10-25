/*
 * Analytics, written for residents: pick your town, then see its past floods,
 * how often heavy rain happens there and when flood season is. The method
 * (alert reliability, all-Bataan evidence, forecast accuracy) and the raw data
 * are folded away below. No browser calls to Open-Meteo; everything comes from
 * the AGOS backend.
 */

import { icon } from "../core/icons.js";
import { t, getLang } from "../core/i18n.js";
import { getJSON } from "../core/api.js";
import { escapeHTML, num, isNumber, formatDate, parseTime } from "../core/format.js";
import { barChart, lineChart, mountChart } from "../core/charts.js";
import { EXPLAIN } from "../core/explain.js";
import { loadingState, errorState, onRetry, openDialog } from "../core/ui.js";
import { buildHash } from "../core/router.js";
import { renderClimate, mountClimateCharts, explainClimate } from "./parts/climate.js";
import { renderEvidence, explainEvidence } from "./parts/evidence.js";
import { renderModel, explainModel, mountModel } from "./parts/model.js";
import { renderTownFloods, renderRareRain, renderSeason, fold } from "./parts/resident.js";

const PERIODS = [7, 30, 90];
const TOWNS = ["Abucay", "Bagac", "Balanga", "Dinalupihan", "Hermosa", "Limay", "Mariveles", "Morong", "Orani", "Orion", "Pilar", "Samal"];
const STORE_KEY = "agos.analytics";

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  } catch {
    return {};
  }
}
function savePrefs(prefs) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    /* storage blocked: preference only lasts this visit */
  }
}

function shortDate(iso) {
  const d = parseTime(iso);
  return d ? d.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" }) : iso;
}

function rainColor(mm) {
  if (!isNumber(mm)) return undefined;
  if (mm >= 50) return "#ef4444"; // matches the AGOS 24-h display bands below
  if (mm >= 20) return "#fb923c";
  if (mm >= 10) return "#facc15";
  if (mm >= 1) return "#38bdf8";
  return "#93c5fd";
}

function skillBadge(row) {
  if (row.status === "ok") return `<span class="badge badge-success">${escapeHTML(t("analytics.skillOk"))}</span>`;
  if (row.status === "insufficient_data") return `<span class="badge badge-warning">${escapeHTML(t("analytics.skillInsufficient"))}</span>`;
  return `<span class="badge">${escapeHTML(t("analytics.skillNoData"))}</span>`;
}

function pct(value) {
  return isNumber(value) ? `${num(value, 0)}%` : "—";
}

export async function mount(container) {
  const prefs = readPrefs();
  const state = {
    alive: true,
    days: PERIODS.includes(prefs.days) ? prefs.days : 30,
    town: TOWNS.includes(prefs.town) ? prefs.town : (TOWNS.includes(prefs.climateTown) ? prefs.climateTown : "Balanga"),
    folds: prefs.folds && typeof prefs.folds === "object" ? prefs.folds : {},
    history: null,
    events: null,
    skill: null,
    climate: null,
    evidence: null,
    model: null,
    cleanups: [],
  };

  container.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">${escapeHTML(t("analytics.eyebrow"))}</div>
        <h1>${escapeHTML(t("title.analytics"))}</h1>
        <p>${escapeHTML(t("analytics.intro"))}</p>
      </div>
      <label class="field analytics-town"><span>${escapeHTML(t("resident.pickTown"))}</span>
        <select class="select" id="analyticsTown">${TOWNS.map((n) => `<option ${n === state.town ? "selected" : ""}>${escapeHTML(n)}</option>`).join("")}</select>
      </label>
    </div>
    <div id="analyticsBody">${loadingState()}</div>`;

  const body = container.querySelector("#analyticsBody");

  const persist = () => savePrefs({ days: state.days, town: state.town, folds: state.folds });

  container.querySelector("#analyticsTown").addEventListener("change", (event) => {
    state.town = event.target.value;
    persist();
    if (state.history) render();
  });

  function teardownCharts() {
    state.cleanups.splice(0).forEach((fn) => fn());
  }

  function periodPicker() {
    return `<div class="segmented" role="group" aria-label="${escapeHTML(t("analytics.period"))}">
      ${PERIODS.map((d) => `<button type="button" data-days="${d}" aria-pressed="${d === state.days}">${escapeHTML(t("analytics.days", { n: d }))}</button>`).join("")}
    </div>`;
  }

  /** Daily rain and river flow for the chosen town (inside the data explorer). */
  function historySection() {
    const h = state.history;
    if (h.error) return `<section class="card">${errorState(h.error)}</section>`;
    const data = h.data;
    if (!data.any_data) {
      return `<section class="card"><div class="state">${icon("database", { size: 30 })}
        <strong>${escapeHTML(t("analytics.noHistory"))}</strong>
        <span>${escapeHTML(t("analytics.noHistoryBody"))}</span>
        <code class="num subtle">AGOS_SCHEDULER_ENABLED=true</code></div></section>`;
    }
    const town = data.towns.find((tw) => tw.name === state.town);
    return `
      <section class="card">
        <div class="card-head">
          <div><h2>${escapeHTML(t("analytics.rainHistory"))}</h2><p>${escapeHTML(t("analytics.rainHistorySub", { start: formatDate(data.period.start), end: formatDate(data.period.end) }))}</p></div>
          <button class="why" type="button" data-explain="history" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>
        </div>
        ${periodPicker()}
        ${town ? `<div class="stack" style="margin-top:var(--space-4)">
            <div class="row" style="justify-content:space-between">
              <a href="${buildHash("municipality", [town.name])}"><strong>${escapeHTML(town.name)}</strong></a>
              <span class="subtle num">${escapeHTML(t("analytics.townSummary", { total: num(town.total_rain_mm, 1), days: town.rain_days_with_data, all: data.period.days }))}</span>
            </div>
            <div class="detail-chart" data-rain="${escapeHTML(town.name)}"></div>
            ${town.flow_days_with_data ? `<div class="detail-chart" data-flow="${escapeHTML(town.name)}"></div>` : `<p class="subtle">${escapeHTML(t("resident.noFlow"))}</p>`}
          </div>` : ""}
        <p class="card-foot">${escapeHTML(t("analytics.historyFoot"))}</p>
      </section>`;
  }

  function climateSection() {
    const c = state.climate;
    if (!c) return "";
    if (c.error) return `<section class="card" style="margin-top:var(--space-4)"><div class="card-head"><div><h2>${escapeHTML(t("climate.title"))}</h2></div></div>${errorState(c.error)}</section>`;
    return renderClimate(c.data, state.town, { picker: false, monthly: false });
  }

  function evidenceSection() {
    const e = state.evidence;
    if (!e) return "";
    if (e.error) return `<section class="card" style="margin-top:var(--space-4)"><div class="card-head"><div><h2>${escapeHTML(t("evidence.title"))}</h2></div></div>${errorState(e.error)}</section>`;
    return renderEvidence(e.data);
  }

  function modelSection() {
    const m = state.model;
    if (!m) return "";
    if (m.error) return `<section class="card" style="margin-top:var(--space-4)"><div class="card-head"><div><h2>${escapeHTML(t("model.title"))}</h2></div></div>${errorState(m.error)}</section>`;
    return renderModel(m.data);
  }

  function skillSection() {
    const s = state.skill;
    if (s.error) return `<section class="card" style="margin-top:var(--space-4)"><div class="card-head"><div><h2>${escapeHTML(t("analytics.accuracy"))}</h2></div></div>${errorState(s.error)}</section>`;
    const rows = s.data.municipalities || [];
    const usable = rows.filter((row) => row.days > 0);
    const totals = usable.reduce((acc, row) => ({ correct: acc.correct + (row.hits + row.correct_negatives), days: acc.days + row.days }), { correct: 0, days: 0 });
    return `
      <section class="card" style="margin-top:var(--space-4)" aria-labelledby="skillTitle">
        <div class="card-head">
          <div><h2 id="skillTitle">${escapeHTML(t("analytics.accuracy"))}</h2><p>${escapeHTML(t("analytics.accuracySub"))}</p></div>
          <button class="why" type="button" data-explain="skill" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>
        </div>
        <div class="grid grid-3" style="margin-bottom:var(--space-4)">
          <div class="stat"><span class="stat-label">${escapeHTML(t("analytics.overallCorrect"))}</span><span class="stat-value num">${totals.days ? escapeHTML(pct((100 * totals.correct) / totals.days)) : "—"}</span></div>
          <div class="stat"><span class="stat-label">${escapeHTML(t("analytics.daysCompared"))}</span><span class="stat-value num">${escapeHTML(String(totals.days))}</span></div>
          <div class="stat"><span class="stat-label">${escapeHTML(t("analytics.townsReady"))}</span><span class="stat-value num">${escapeHTML(`${rows.filter((r) => r.status === "ok").length}/${rows.length}`)}</span></div>
        </div>
        ${totals.days === 0 ? `<div class="notice notice-info">${icon("clock", { size: 18 })}<div>${escapeHTML(t("analytics.collecting"))}</div></div>` : ""}
        <div class="table-wrap" style="margin-top:var(--space-3)"><table class="table">
          <thead><tr>
            <th scope="col">${escapeHTML(t("common.municipality"))}</th>
            <th scope="col">${escapeHTML(t("analytics.status"))}</th>
            <th scope="col" class="num">${escapeHTML(t("analytics.correct"))}</th>
            <th scope="col" class="num hide-sm">${escapeHTML(t("analytics.detected"))}</th>
            <th scope="col" class="num hide-sm">${escapeHTML(t("analytics.missesFalse"))}</th>
            <th scope="col" class="num hide-sm">${escapeHTML(t("analytics.bias"))}</th>
            <th scope="col" class="num">${escapeHTML(t("analytics.daysCol"))}</th>
          </tr></thead>
          <tbody>${rows.map((row) => `<tr>
            <th scope="row">${escapeHTML(row.municipality)}</th>
            <td>${skillBadge(row)}</td>
            <td class="num">${escapeHTML(pct(row.rain_no_rain_correct_percent))}</td>
            <td class="num hide-sm">${escapeHTML(pct(row.rain_detected_percent))}</td>
            <td class="num hide-sm">${row.days ? escapeHTML(`${row.misses} / ${row.false_alarms}`) : "—"}</td>
            <td class="num hide-sm">${isNumber(row.bias_ratio) ? `×${escapeHTML(num(row.bias_ratio, 2))}` : "—"}</td>
            <td class="num">${escapeHTML(String(row.days ?? 0))}</td>
          </tr>`).join("")}</tbody>
        </table></div>
        <p class="card-foot">${escapeHTML(t("analytics.skillFoot"))}</p>
      </section>`;
  }

  function sectionError(titleKey, error) {
    return `<section class="card" style="margin-top:var(--space-4)"><div class="card-head"><div><h2>${escapeHTML(t(titleKey, { town: state.town }))}</h2></div></div>${errorState(error)}</section>`;
  }

  /** Shown while the statistics still use the mixed default record (ERA5 to 2016, IFS from 2017). */
  function recordNotice() {
    const records = [state.climate, state.evidence, state.model].map((x) => x?.data?.rain_record).filter(Boolean);
    if (!records.some((r) => r.consistent === false)) return "";
    return `<div class="notice notice-warning" style="margin-bottom:var(--space-4)">${icon("info", { size: 18 })}<div>${escapeHTML(t("resident.mixedRecord"))}</div></div>`;
  }

  function residentSections() {
    const ev = state.events;
    const evid = state.evidence;
    const floods = ev?.error ? sectionError("resident.floodsTitle", ev.error) : renderTownFloods(ev?.data, evid?.data, state.town);
    const climate = state.climate;
    const rare = climate?.error ? sectionError("resident.rareTitle", climate.error) : renderRareRain(climate?.data, state.town);
    const season = climate?.error ? "" : renderSeason(climate?.data, ev?.data, state.town);
    return recordNotice() + floods + rare + season;
  }

  function render() {
    teardownCharts();
    body.innerHTML = residentSections()
      + fold("trust", t("resident.trustTitle"), t("resident.trustSub"), modelSection() + evidenceSection() + skillSection(), Boolean(state.folds.trust))
      + fold("explore", t("resident.exploreTitle"), t("resident.exploreSub"), historySection() + climateSection(), Boolean(state.folds.explore));

    body.querySelectorAll("[data-days]").forEach((button) => button.addEventListener("click", () => {
      state.days = Number(button.dataset.days);
      persist();
      load();
    }));
    body.querySelectorAll("[data-fold]").forEach((el) => el.addEventListener("toggle", () => {
      state.folds = { ...state.folds, [el.dataset.fold]: el.open };
      persist();
    }));
    if (state.climate?.data) state.cleanups.push(...mountClimateCharts(body, state.climate.data, state.town));
    if (state.model?.data) mountModel(body, state.model.data);
    body.querySelectorAll("[data-explain]").forEach((button) => button.addEventListener("click", () => explain(button.dataset.explain)));

    const data = state.history?.data;
    if (!data) return;
    body.querySelectorAll("[data-rain]").forEach((el) => {
      const town = data.towns.find((tw) => tw.name === el.dataset.rain);
      const bars = town.daily.map((d) => ({ label: shortDate(d.date), value: d.precipitation_mm, color: rainColor(d.precipitation_mm), title: `${formatDate(d.date)}: ${isNumber(d.precipitation_mm) ? `${d.precipitation_mm} mm` : t("analytics.notCollected")}` }));
      state.cleanups.push(mountChart(el, (width) => barChart(bars, { width, height: 140, unit: "mm/day", minMax: 5, ariaLabel: `${town.name} daily rain`, xLabelEvery: Math.max(1, Math.ceil(bars.length / Math.max(3, Math.floor(width / 90)))) })));
    });
    body.querySelectorAll("[data-flow]").forEach((el) => {
      const town = data.towns.find((tw) => tw.name === el.dataset.flow);
      const points = town.daily.map((d) => ({ label: shortDate(d.date), value: d.river_discharge_m3s }));
      state.cleanups.push(mountChart(el, (width) => lineChart(points, { width, height: 110, unit: "m³/s", color: "#0891b2", ariaLabel: `${town.name} river flow`, xLabelEvery: Math.max(1, Math.ceil(points.length / Math.max(3, Math.floor(width / 90)))) })));
    });
  }

  function explain(kind) {
    const fil = getLang() === "fil";
    if (kind === "model") {
      openDialog(t("model.title"), explainModel(fil));
    } else if (kind === "evidence") {
      openDialog(t("evidence.title"), explainEvidence(fil));
    } else if (kind === "climate") {
      openDialog(t("climate.title"), explainClimate(fil));
    } else if (kind === "history") {
      openDialog(t("analytics.rainHistory"), fil ? `
        <p>Ang ulan bawat araw ay mula sa <strong>archive reanalysis</strong> ng Open-Meteo sa reference point ng bawat bayan: model estimate ng bumagsak na ulan, hindi sukat ng rain gauge. Simulated na GloFAS discharge ang daloy ng ilog.</p>
        <p>Ang mga araw lang na naipon na ng AGOS scheduler ang ipinapakita. Ang kulay-abong marka ay mga araw na hindi naipon — kulang, hindi zero.</p>
        <p>Ang kulay ng bar ay display band ng AGOS para sa kabuuang ulan bawat araw (1, 10, 20 at 50 mm). Hindi ito kategorya ng PAGASA.</p>` : `
        <p>Daily rainfall is the Open-Meteo <strong>archive reanalysis</strong> at each town's reference point: a model estimate of what fell, not a rain-gauge reading. River flow is simulated GloFAS discharge.</p>
        <p>Only days already collected by the AGOS scheduler are shown. Gray marks are days that were never collected — they are missing, not zero.</p>
        <p>Bar colors are AGOS display bands for daily totals (1, 10, 20 and 50 mm). They are not PAGASA categories.</p>`);
    } else {
      openDialog(t("analytics.accuracy"), fil ? `
        <p>Bawat oras, itinatabi ng AGOS ang forecast ng Open-Meteo. Para sa bawat nakaraang araw, ang <strong>day-ahead forecast</strong> (ang huling naitabi bago magsimula ang araw) ay ikinukumpara sa archive na ulan para sa araw na iyon.</p>
        <p><strong>Tama ang ulan/walang ulan</strong>: bahagi ng mga araw na nagkasundo ang forecast at archive kung may bumagsak na kahit 1 mm. <strong>Nahuling ulan</strong>: sa mga maulang araw, ilan ang nahulaan ng forecast. <strong>Bias ×</strong>: kabuuang forecast hinati sa kabuuang aktwal (lampas 1 ay mas maraming ulan ang hinulaan kaysa bumagsak).</p>
        <p>"Kulang ang datos" ang makikita sa isang bayan hangga't wala pang 14 na naikumparang araw na may 10 maulang araw. Model din ang batayan (reanalysis), hindi gauge, kaya pagkakasundo ng dalawang model ang sinusukat nito.</p>
        <p class="subtle"><a href="#/sources?s=forecast-skill">Detalye ng pinagmulan</a></p>` : `
        <p>Every hour AGOS saves the Open-Meteo forecast. For each past day, the <strong>day-ahead forecast</strong> (the last one saved before that day began) is compared with the archive rainfall for that day.</p>
        <p><strong>Rain/no-rain correct</strong>: the share of days where the forecast and the archive agree on whether at least 1 mm fell. <strong>Rain detected</strong>: of the rainy days, how many the forecast caught. <strong>Bias ×</strong>: forecast total divided by observed total (above 1 means the forecast said more rain than fell).</p>
        <p>A town shows "insufficient data" until it has at least 14 compared days with 10 rainy days. The reference is itself a model (reanalysis), not a gauge, so this measures agreement between two models.</p>
        <p class="subtle"><a href="#/sources?s=forecast-skill">Source details</a></p>`);
    }
  }

  async function load() {
    teardownCharts();
    body.innerHTML = loadingState();
    const [historyResult, skillResult, climateResult, evidenceResult, modelResult, eventsResult] = await Promise.allSettled([
      getJSON(`/api/history?days=${state.days}`, { ttlMs: 10 * 60 * 1000, timeoutMs: 30000 }),
      getJSON(`/skill/rain?days=${state.days}`, { ttlMs: 10 * 60 * 1000, timeoutMs: 30000 }),
      getJSON("/api/climate", { ttlMs: 30 * 60 * 1000, timeoutMs: 30000 }),
      getJSON("/api/flood-evidence", { ttlMs: 30 * 60 * 1000, timeoutMs: 45000 }),
      getJSON("/api/flood-model", { ttlMs: 30 * 60 * 1000, timeoutMs: 60000 }),
      getJSON("/api/flood-events", { ttlMs: 30 * 60 * 1000, timeoutMs: 30000 }),
    ]);
    if (!state.alive) return;
    state.events = eventsResult.status === "fulfilled" ? { data: eventsResult.value } : { error: eventsResult.reason };
    state.history = historyResult.status === "fulfilled" ? { data: historyResult.value } : { error: historyResult.reason };
    state.evidence = evidenceResult.status === "fulfilled" ? { data: evidenceResult.value } : { error: evidenceResult.reason };
    state.model = modelResult.status === "fulfilled" ? { data: modelResult.value } : { error: modelResult.reason };
    state.climate = climateResult.status === "fulfilled" ? { data: climateResult.value } : { error: climateResult.reason };
    state.skill = skillResult.status === "fulfilled" ? { data: skillResult.value } : { error: skillResult.reason };
    render();
    onRetry(body, load);
  }

  await load();
  return () => {
    state.alive = false;
    teardownCharts();
  };
}
