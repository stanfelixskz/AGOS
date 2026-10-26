/*
 * Analytics: what happened (history from the AGOS database) and how good the
 * forecast has been (accuracy from /skill/rain). No browser calls to
 * Open-Meteo; everything comes from the AGOS backend.
 */

import { icon } from "../core/icons.js";
import { t, getLang } from "../core/i18n.js";
import { getJSON } from "../core/api.js";
import { escapeHTML, num, isNumber, formatDate, parseTime } from "../core/format.js";
import { barChart, lineChart, mountChart } from "../core/charts.js";
import { EXPLAIN } from "../core/explain.js";
import { loadingState, errorState, onRetry, openDialog } from "../core/ui.js";
import { buildHash } from "../core/router.js";
import { mountFloodHistory } from "./parts/flood-history.js";

const PERIODS = [7, 30, 90];
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
    towns: Array.isArray(prefs.towns) && prefs.towns.length ? prefs.towns.slice(0, 3) : ["Balanga"],
    history: null,
    skill: null,
    cleanups: [],
  };

  container.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">${escapeHTML(t("analytics.eyebrow"))}</div>
        <h1>${escapeHTML(t("title.analytics"))}</h1>
        <p>${escapeHTML(t("analytics.intro"))}</p>
      </div>
      <div class="segmented" role="group" aria-label="${escapeHTML(t("analytics.period"))}">
        ${PERIODS.map((d) => `<button type="button" data-days="${d}" aria-pressed="${d === state.days}">${escapeHTML(t("analytics.days", { n: d }))}</button>`).join("")}
      </div>
    </div>
    <div id="floodHistorySlot"></div>
    <div id="analyticsBody" style="margin-top:var(--space-4)">${loadingState()}</div>`;

  const body = container.querySelector("#analyticsBody");

  container.querySelectorAll("[data-days]").forEach((button) => button.addEventListener("click", () => {
    state.days = Number(button.dataset.days);
    container.querySelectorAll("[data-days]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    savePrefs({ days: state.days, towns: state.towns });
    load();
  }));

  function teardownCharts() {
    state.cleanups.splice(0).forEach((fn) => fn());
  }

  function renderTownPicker(allTowns) {
    return `<div class="row town-picker" role="group" aria-label="${escapeHTML(t("analytics.compare"))}">
      ${allTowns.map((name) => `<button type="button" class="chip" data-town="${escapeHTML(name)}" aria-pressed="${state.towns.includes(name)}">${escapeHTML(name)}</button>`).join("")}
    </div>
    <p class="subtle">${escapeHTML(t("analytics.compareHint"))}</p>`;
  }

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
    const selected = data.towns.filter((town) => state.towns.includes(town.name));
    const ranked = [...data.towns].sort((a, b) => (b.total_rain_mm ?? -1) - (a.total_rain_mm ?? -1));
    return `
      <section class="card">
        <div class="card-head">
          <div><h2>${escapeHTML(t("analytics.rainHistory"))}</h2><p>${escapeHTML(t("analytics.rainHistorySub", { start: formatDate(data.period.start), end: formatDate(data.period.end) }))}</p></div>
          <button class="why" type="button" data-explain="history" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>
        </div>
        ${renderTownPicker(data.towns.map((town) => town.name))}
        <div class="stack" style="margin-top:var(--space-4)">
          ${selected.map((town) => `
            <div class="multiple">
              <div class="row" style="justify-content:space-between">
                <a href="${buildHash("municipality", [town.name])}"><strong>${escapeHTML(town.name)}</strong></a>
                <span class="subtle num">${escapeHTML(t("analytics.townSummary", { total: num(town.total_rain_mm, 1), days: town.rain_days_with_data, all: data.period.days }))}</span>
              </div>
              <div class="detail-chart" data-rain="${escapeHTML(town.name)}"></div>
              ${town.flow_days_with_data ? `<div class="detail-chart" data-flow="${escapeHTML(town.name)}"></div>` : ""}
            </div>`).join("")}
        </div>
        <p class="card-foot">${escapeHTML(t("analytics.historyFoot"))}</p>
      </section>

      <section class="card" style="margin-top:var(--space-4)">
        <div class="card-head"><div><h2>${escapeHTML(t("analytics.ranking"))}</h2><p>${escapeHTML(t("analytics.rankingSub"))}</p></div></div>
        <div class="table-wrap"><table class="table">
          <thead><tr>
            <th scope="col">${escapeHTML(t("common.municipality"))}</th>
            <th scope="col" class="num">${escapeHTML(t("analytics.totalRain"))}</th>
            <th scope="col" class="num">${escapeHTML(t("analytics.wettest"))}</th>
            <th scope="col" class="num hide-sm">${escapeHTML(t("analytics.days10"))}</th>
            <th scope="col" class="num hide-sm">${escapeHTML(t("analytics.peakFlow"))}</th>
            <th scope="col" class="num hide-sm">${escapeHTML(t("analytics.coverage"))}</th>
          </tr></thead>
          <tbody>${ranked.map((town) => `<tr>
            <th scope="row"><a href="${buildHash("municipality", [town.name])}">${escapeHTML(town.name)}</a></th>
            <td class="num">${isNumber(town.total_rain_mm) ? `${escapeHTML(num(town.total_rain_mm, 1))} mm` : "—"}</td>
            <td class="num">${town.wettest_day ? `${escapeHTML(num(town.wettest_day.precipitation_mm, 1))} mm<div class="subtle">${escapeHTML(shortDate(town.wettest_day.date))}</div>` : "—"}</td>
            <td class="num hide-sm">${town.rain_days_with_data ? escapeHTML(String(town.days_with_10mm_or_more)) : "—"}</td>
            <td class="num hide-sm">${town.highest_flow_day ? `${escapeHTML(num(town.highest_flow_day.river_discharge_m3s, 1))} m³/s` : "—"}</td>
            <td class="num hide-sm">${escapeHTML(`${town.rain_days_with_data}/${data.period.days}`)}</td>
          </tr>`).join("")}</tbody>
        </table></div>
      </section>`;
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

  function render() {
    teardownCharts();
    body.innerHTML = historySection() + skillSection();

    body.querySelectorAll("[data-town]").forEach((chip) => chip.addEventListener("click", () => {
      const name = chip.dataset.town;
      if (state.towns.includes(name)) {
        if (state.towns.length > 1) state.towns = state.towns.filter((n) => n !== name);
      } else {
        state.towns = [...state.towns, name].slice(-3);
      }
      savePrefs({ days: state.days, towns: state.towns });
      render();
    }));
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
    if (kind === "history") {
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
    const [historyResult, skillResult] = await Promise.allSettled([
      getJSON(`/api/history?days=${state.days}`, { ttlMs: 10 * 60 * 1000, timeoutMs: 30000 }),
      getJSON(`/skill/rain?days=${state.days}`, { ttlMs: 10 * 60 * 1000, timeoutMs: 30000 }),
    ]);
    if (!state.alive) return;
    state.history = historyResult.status === "fulfilled" ? { data: historyResult.value } : { error: historyResult.reason };
    state.skill = skillResult.status === "fulfilled" ? { data: skillResult.value } : { error: skillResult.reason };
    render();
    onRetry(body, load);
  }

  // Flood-risk history loads on its own so it never holds up the rest of the page.
  let floodCleanup = null;
  mountFloodHistory(container.querySelector("#floodHistorySlot")).then((fn) => {
    if (state.alive) floodCleanup = fn;
    else fn?.();
  });

  await load();
  return () => {
    state.alive = false;
    teardownCharts();
    floodCleanup?.();
  };
}
