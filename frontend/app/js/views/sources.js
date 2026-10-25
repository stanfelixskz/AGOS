/* Sources & About: every data source, live system status, method and limits. */

import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { getJSON } from "../core/api.js";
import { escapeHTML, formatTime, relativeTime, num } from "../core/format.js";
import { SOURCES } from "../core/sources.js";
import { loadingState, errorState, onRetry } from "../core/ui.js";

const REPO_URL = "https://github.com/stanfelixskz/AGOS";

function statusRow(label, value, tone = "") {
  return `<li class="row" style="justify-content:space-between"><span class="muted">${escapeHTML(label)}</span><span class="${tone}">${value}</span></li>`;
}

function yesNo(flag, yes, no) {
  return flag
    ? `<span class="badge badge-success">${escapeHTML(yes)}</span>`
    : `<span class="badge">${escapeHTML(no)}</span>`;
}

function renderStatus(data) {
  const scheduler = data.scheduler || {};
  const db = data.database || {};
  const fc = data.stored_forecasts || {};
  const last = scheduler.last_summary;
  const snap = scheduler.last_forecast_snapshot;
  const rows = [
    statusRow("API", `<span class="badge badge-success">${escapeHTML(data.api?.status || "running")}</span>`),
    statusRow("Scheduled data collection", yesNo(scheduler.enabled, scheduler.running ? "Running" : "Enabled", "Off")),
    statusRow("Last collection finished", scheduler.last_finished_at ? `${escapeHTML(formatTime(scheduler.last_finished_at))} <span class="subtle">(${escapeHTML(relativeTime(scheduler.last_finished_at))})</span>` : "—"),
    statusRow("Last collection result", last ? escapeHTML(last.crashed ? `Crashed: ${last.error}` : `${last.succeeded ?? "?"} of ${last.attempted ?? "?"} requests succeeded`) : "—"),
    statusRow("Last forecast snapshot", snap ? escapeHTML(snap.crashed ? `Crashed: ${snap.error}` : `${snap.stored ?? 0} municipalities saved, ${snap.errors?.length ?? 0} errors`) : "—"),
    statusRow("Saved forecast runs", fc.status === "error" ? `<span class="badge badge-danger">error</span>` : `<span class="num">${escapeHTML(String(fc.runs ?? "—"))}</span>`),
    statusRow("Forecasts saved since", fc.first_issued_at ? escapeHTML(formatTime(fc.first_issued_at)) : "—"),
    statusRow("Suspect / missing forecast values", fc.values != null ? `<span class="num">${escapeHTML(`${fc.suspect_values ?? 0} / ${fc.missing_values ?? 0}`)}</span>` : "—"),
    statusRow("Observation records in database", db.status === "error" ? `<span class="badge badge-danger">error</span>` : `<span class="num">${escapeHTML(String(db.observation_records ?? "—"))}</span>`),
    statusRow("Database size", db.database_size_bytes != null ? `<span class="num">${escapeHTML(num(db.database_size_bytes / 1048576, 1))} MB</span>` : "—"),
    statusRow("WeatherAPI key configured", yesNo(data.weatherapi_key_configured, "Yes", "No")),
  ];
  return `<ul class="list">${rows.join("")}</ul>`;
}

function sourceCard(source) {
  return `
    <article class="card" id="source-${escapeHTML(source.id)}">
      <div class="card-head">
        <div>
          <h3>${escapeHTML(source.name)}</h3>
          <p>${escapeHTML(source.kind)}</p>
        </div>
        ${source.url ? `<a class="btn btn-ghost btn-icon btn-sm" href="${escapeHTML(source.url)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHTML(source.name)}">${icon("external", { size: 16 })}</a>` : ""}
      </div>
      <dl class="stack" style="gap:var(--space-2);margin:0">
        <div><dt class="subtle">${escapeHTML(t("sources.what"))}</dt><dd style="margin:0">${escapeHTML(source.what)}</dd></div>
        <div><dt class="subtle">${escapeHTML(t("sources.usedFor"))}</dt><dd style="margin:0">${escapeHTML(source.usedFor)}</dd></div>
        <div><dt class="subtle">${escapeHTML(t("sources.limitsLabel"))}</dt><dd style="margin:0">${escapeHTML(source.limits)}</dd></div>
      </dl>
      <div class="card-foot">${icon("clock", { size: 14 })} ${escapeHTML(source.refresh)}</div>
    </article>`;
}

export async function mount(container, route) {
  container.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">AGOS · Bataan</div>
        <h1>${escapeHTML(t("title.sources"))}</h1>
        <p>${escapeHTML(t("sources.intro"))}</p>
      </div>
    </div>

    <div class="notice notice-warning" style="margin-bottom:var(--space-5)">
      ${icon("alert")}
      <div>${escapeHTML(t("app.disclaimer"))}</div>
    </div>

    <div class="grid grid-2" style="align-items:start">
      <section class="card" aria-labelledby="liveHeading">
        <div class="card-head">
          <div><h2 id="liveHeading">${escapeHTML(t("sources.live"))}</h2><p>/system/status</p></div>
          <button class="btn btn-ghost btn-icon btn-sm" type="button" id="statusRefresh" aria-label="Refresh status">${icon("refresh", { size: 16 })}</button>
        </div>
        <div id="statusBody">${loadingState()}</div>
      </section>

      <section class="card" aria-labelledby="methodHeading">
        <div class="card-head"><div><h2 id="methodHeading">${escapeHTML(t("sources.method"))}</h2></div></div>
        <ol class="stack" style="gap:var(--space-3);margin:0;padding-left:20px">
          <li><strong>Collect.</strong> The backend fetches public data (Open-Meteo forecasts, past weather, GloFAS river flow) for one reference point in each of the 12 municipalities. Nothing is downloaded by hand.</li>
          <li><strong>Clean and store.</strong> Values are checked for units and realistic ranges and saved in a local SQLite database with their source and time. Missing values stay missing (never 0); out-of-range values are flagged, not deleted.</li>
          <li><strong>Classify.</strong> The heaviest forecast hour is compared with the PAGASA Heavy Rainfall Warning intensity criteria to give a PAGASA-equivalent color.</li>
          <li><strong>Check itself.</strong> Saved forecasts are compared later with what fell, to measure forecast accuracy and bias.</li>
          <li><strong>Show.</strong> Every number and color on screen links to its source and time.</li>
        </ol>
      </section>
    </div>

    <section style="margin-top:var(--space-6)" aria-labelledby="limitsHeading">
      <h2 id="limitsHeading" style="margin-bottom:var(--space-3)">${escapeHTML(t("sources.limits"))}</h2>
      <div class="card">
        <ul class="stack" style="gap:var(--space-2);margin:0;padding-left:20px">
          <li>AGOS does <strong>not</strong> issue official warnings. PAGASA-equivalent colors are AGOS rules applied to model forecasts.</li>
          <li>AGOS does <strong>not</strong> predict flood depth or exactly which streets will flood.</li>
          <li>Forecast rain is model output for one point per municipality, not a rain-gauge reading for the whole town.</li>
          <li>River discharge is simulated (GloFAS), not an observed river level.</li>
          <li>Community reports and evacuation center details are unverified until reviewed.</li>
          <li>Flood susceptibility by municipality or barangay is not available yet; the slot is reserved and will say so until the data exists.</li>
        </ul>
      </div>
    </section>

    <section style="margin-top:var(--space-6)" aria-labelledby="sourcesHeading">
      <h2 id="sourcesHeading" style="margin-bottom:var(--space-3)">${escapeHTML(t("sources.list"))}</h2>
      <div class="grid grid-2">${SOURCES.map(sourceCard).join("")}</div>
    </section>

    <section style="margin-top:var(--space-6)" class="card">
      <div class="row">
        ${icon("sourceCode")}
        <div class="spacer">
          <strong>AGOS — Analytics-Driven Geospatial Observation and Flood Support System for Bataan</strong>
          <p class="subtle">Student research project. Open source.</p>
        </div>
        <a class="btn btn-sm" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">GitHub ${icon("external", { size: 14 })}</a>
      </div>
    </section>`;

  const body = container.querySelector("#statusBody");
  let alive = true;

  async function load() {
    body.innerHTML = loadingState();
    try {
      const data = await getJSON("/system/status", { timeoutMs: 10000 });
      if (alive) body.innerHTML = renderStatus(data);
    } catch (error) {
      if (!alive) return;
      body.innerHTML = errorState(error);
      onRetry(body, load);
    }
  }

  container.querySelector("#statusRefresh").addEventListener("click", load);
  if (route?.query?.s) {
    container.querySelector(`#source-${CSS.escape(route.query.s)}`)?.scrollIntoView({ block: "start" });
  }
  load();
  return () => {
    alive = false;
  };
}
