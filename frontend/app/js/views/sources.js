/* Sources & About: every data source, live system status, method and limits. */

import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { getJSON } from "../core/api.js";
import { escapeHTML, formatTime, relativeTime, num } from "../core/format.js";
import { SOURCES, sourceText } from "../core/sources.js";
import { getLang } from "../core/i18n.js";
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
    statusRow(t("st.api"), `<span class="badge badge-success">${escapeHTML(!data.api?.status || data.api.status === "running" ? t("st.running") : data.api.status)}</span>`),
    statusRow(t("st.scheduler"), yesNo(scheduler.enabled, scheduler.running ? t("st.running") : t("st.enabled"), t("st.off"))),
    statusRow(t("st.lastFinished"), scheduler.last_finished_at ? `${escapeHTML(formatTime(scheduler.last_finished_at))} <span class="subtle">(${escapeHTML(relativeTime(scheduler.last_finished_at))})</span>` : "—"),
    statusRow(t("st.lastResult"), last ? escapeHTML(last.crashed ? t("st.crashed", { error: last.error }) : t("st.resultText", { ok: last.succeeded ?? "?", all: last.attempted ?? "?" })) : "—"),
    statusRow(t("st.lastSnapshot"), snap ? escapeHTML(snap.crashed ? t("st.crashed", { error: snap.error }) : t("st.snapshotText", { n: snap.stored ?? 0, e: snap.errors?.length ?? 0 })) : "—"),
    statusRow(t("st.runs"), fc.status === "error" ? `<span class="badge badge-danger">error</span>` : `<span class="num">${escapeHTML(String(fc.runs ?? "—"))}</span>`),
    statusRow(t("st.since"), fc.first_issued_at ? escapeHTML(formatTime(fc.first_issued_at)) : "—"),
    statusRow(t("st.suspect"), fc.values != null ? `<span class="num">${escapeHTML(`${fc.suspect_values ?? 0} / ${fc.missing_values ?? 0}`)}</span>` : "—"),
    statusRow(t("st.obs"), db.status === "error" ? `<span class="badge badge-danger">error</span>` : `<span class="num">${escapeHTML(String(db.observation_records ?? "—"))}</span>`),
    statusRow(t("st.dbSize"), db.database_size_bytes != null ? `<span class="num">${escapeHTML(num(db.database_size_bytes / 1048576, 1))} MB</span>` : "—"),
    statusRow(t("st.key"), yesNo(data.weatherapi_key_configured, t("st.yes"), t("st.no"))),
  ];
  return `<ul class="list">${rows.join("")}</ul>`;
}

function sourceCard(raw) {
  const source = sourceText(raw, getLang());
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
          ${[1, 2, 3, 4, 5].map((n) => `<li><strong>${escapeHTML(t(`method.${n}.title`))}</strong> ${escapeHTML(t(`method.${n}.body`))}</li>`).join("")}
        </ol>
      </section>
    </div>

    <section style="margin-top:var(--space-6)" aria-labelledby="limitsHeading">
      <h2 id="limitsHeading" style="margin-bottom:var(--space-3)">${escapeHTML(t("sources.limits"))}</h2>
      <div class="card">
        <ul class="stack" style="gap:var(--space-2);margin:0;padding-left:20px">
          ${[1, 2, 3, 4, 5, 6].map((n) => `<li>${escapeHTML(t(`limit.${n}`))}</li>`).join("")}
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
          <p class="subtle">${escapeHTML(t("about.sub"))}</p>
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
