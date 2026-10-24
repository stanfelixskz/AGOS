/*
 * Overview: "Is my area safe right now?"
 * Briefing, alerts, a Bataan map colored by rain level, every town ranked,
 * and quick actions. All numbers come from /api/overview.
 */

import { icon } from "../core/icons.js";
import { t, getLang } from "../core/i18n.js";
import { getJSON } from "../core/api.js";
import { escapeHTML, num, formatTime, formatHour, isNumber, relativeTime, parseTime } from "../core/format.js";
import { levelLabel, levelColor, THRESHOLDS } from "../core/levels.js";
import { barChart, mountChart } from "../core/charts.js";
import { EXPLAIN } from "../core/explain.js";
import { buildHash } from "../core/router.js";
import { effectiveTheme } from "../core/theme.js";
import { loadingState, errorState, onRetry } from "../core/ui.js";
import { levelPill } from "./parts/muni-detail.js";

const TTL = 10 * 60 * 1000;

function heroTone(level) {
  if (level === "red") return "hero-red";
  if (level === "orange") return "hero-orange";
  if (level === "yellow") return "hero-yellow";
  return "hero-calm";
}

function sparkline(series) {
  const values = (series || []).slice(0, 24);
  const max = Math.max(THRESHOLDS.yellow, ...values.map((p) => (isNumber(p.precipitation_mm) ? p.precipitation_mm : 0)));
  return `<svg class="spark" viewBox="0 0 96 24" width="96" height="24" aria-hidden="true">${values.map((p, i) => {
    const v = p.precipitation_mm;
    if (!isNumber(v)) return `<rect x="${i * 4}" y="22" width="3" height="2" class="chart-missing"/>`;
    const h = Math.max(1, (v / max) * 24);
    return `<rect x="${i * 4}" y="${24 - h}" width="3" height="${h}" rx="1" fill="${levelColor(p.level)}"/>`;
  }).join("")}</svg>`;
}

function render(data) {
  const lang = getLang();
  const alerts = data.alerts || [];
  const briefing = data.briefing?.[lang] || data.briefing?.en || "";
  // First sentence large; the rest smaller. The "not official" note is already
  // in the source line below, so it is not repeated here.
  const sentences = briefing.split(/(?<=\.)\s+/).filter((s) => !/not an official PAGASA warning|hindi opisyal na babala/i.test(s));
  const headline = sentences.shift() || briefing;
  const more = sentences.join(" ");
  const munis = [...(data.municipalities || [])].sort((a, b) => (data.ranking_24h || []).indexOf(a.name) - (data.ranking_24h || []).indexOf(b.name));

  return `
    <section class="hero ${heroTone(data.highest_level_24h)}" aria-labelledby="heroTitle">
      <div class="hero-main">
        <div class="row" style="gap:8px">
          ${levelPill(data.highest_level_24h, `${t("overview.highest")}: ${levelLabel(data.highest_level_24h, lang)}`)}
          <button class="why" type="button" data-why="rainLevels" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>
        </div>
        <h2 id="heroTitle" class="hero-title">${escapeHTML(headline)}</h2>
        ${more ? `<p class="hero-more">${escapeHTML(more)}</p>` : ""}
        <p class="source-line">${icon("clock", { size: 14 })}${escapeHTML(t("common.updated"))} ${escapeHTML(formatTime(data.generated_at))} (${escapeHTML(relativeTime(data.generated_at))}) · Open-Meteo · ${escapeHTML(t("common.notOfficial"))}</p>
      </div>
      <div class="hero-actions">
        <a class="btn btn-primary" href="#/map">${icon("map", { size: 18 })} ${escapeHTML(t("overview.openMap"))}</a>
        <a class="btn" href="#/evacuate">${icon("evacuate", { size: 18 })} ${escapeHTML(t("nav.evacuate"))}</a>
        <a class="btn" href="#/report">${icon("report", { size: 18 })} ${escapeHTML(t("overview.reportFlood"))}</a>
      </div>
    </section>

    <div class="overview-grid">
      <section class="card overview-map-card" aria-labelledby="mapTitle">
        <div class="card-head">
          <div><h2 id="mapTitle">${escapeHTML(t("overview.mapTitle"))}</h2><p>${escapeHTML(t("overview.mapSub"))}</p></div>
          <a class="btn btn-sm" href="#/map">${escapeHTML(t("overview.fullMap"))} ${icon("arrowRight", { size: 14 })}</a>
        </div>
        <div class="overview-map" id="overviewMap"><div class="map-loading">${loadingState(t("map.loading"))}</div></div>
      </section>

      <section class="card" aria-labelledby="alertsTitle">
        <div class="card-head">
          <div><h2 id="alertsTitle">${escapeHTML(t("overview.alerts"))}</h2><p>${escapeHTML(t("overview.alertsSub"))}</p></div>
          <span class="badge ${alerts.length ? "badge-warning" : "badge-success"}">${alerts.length}</span>
        </div>
        ${alerts.length ? `<ul class="list alert-list">${alerts.map((a) => `
          <li>
            <a class="alert-item" href="${buildHash("municipality", [a.municipality])}">
              <span class="alert-bar" style="background:${levelColor(a.level)}"></span>
              <span class="alert-text">
                <span class="row" style="gap:8px"><strong>${escapeHTML(a.municipality)}</strong>${levelPill(a.level)}</span>
                <span class="muted">${escapeHTML(a.text?.[lang] || a.text?.en || "")}</span>
                <span class="subtle">${escapeHTML(t("overview.window", { from: formatTime(a.starts), to: formatHour(a.ends) }))}</span>
              </span>
              ${icon("chevronRight", { size: 18 })}
            </a>
          </li>`).join("")}</ul>`
        : `<div class="state">${icon("check", { size: 28 })}<strong>${escapeHTML(t("overview.noAlerts"))}</strong><span>${escapeHTML(t("overview.noAlertsBody"))}</span></div>`}
        <p class="card-foot">${escapeHTML(t("overview.alertsFoot"))}</p>
      </section>
    </div>

    <section class="card" style="margin-top:var(--space-4)" aria-labelledby="provinceTitle">
      <div class="card-head">
        <div><h2 id="provinceTitle">${escapeHTML(t("overview.provinceChart"))}</h2><p>${escapeHTML(t("overview.provinceChartSub"))}</p></div>
      </div>
      <div id="provinceChart" class="detail-chart"></div>
    </section>

    <section class="card" style="margin-top:var(--space-4)" aria-labelledby="townsTitle">
      <div class="card-head">
        <div><h2 id="townsTitle">${escapeHTML(t("overview.towns"))}</h2><p>${escapeHTML(t("overview.townsSub"))}</p></div>
      </div>
      <div class="table-wrap">
        <table class="table town-table">
          <thead><tr>
            <th scope="col">${escapeHTML(t("common.municipality"))}</th>
            <th scope="col">${escapeHTML(t("overview.level"))}</th>
            <th scope="col" class="num">${escapeHTML(t("overview.peak"))}</th>
            <th scope="col" class="num hide-sm">${escapeHTML(t("detail.total24"))}</th>
            <th scope="col" class="hide-sm">${escapeHTML(t("overview.next24"))}</th>
            <th scope="col" class="hide-sm"><span class="visually-hidden">${escapeHTML(t("common.details"))}</span></th>
          </tr></thead>
          <tbody>${munis.map((m) => {
            const w = m.windows?.next_24h || {};
            return `<tr>
              <th scope="row"><a href="${buildHash("municipality", [m.name])}">${escapeHTML(m.name)}</a></th>
              <td>${levelPill(m.level_24h)}</td>
              <td class="num">${isNumber(w.peak_mm_h) ? `${escapeHTML(num(w.peak_mm_h, 1))} mm/h` : "—"}${w.peak_time ? `<div class="subtle">${escapeHTML(formatHour(w.peak_time))}</div>` : ""}</td>
              <td class="num hide-sm">${isNumber(w.total_mm) ? `${escapeHTML(num(w.total_mm, 1))} mm` : "—"}</td>
              <td class="hide-sm">${sparkline(m.series)}</td>
              <td class="hide-sm"><a class="btn btn-ghost btn-icon btn-sm" href="${buildHash("map", [], { m: m.name })}" aria-label="${escapeHTML(t("common.openMap"))}: ${escapeHTML(m.name)}">${icon("map", { size: 16 })}</a></td>
            </tr>`;
          }).join("")}</tbody>
        </table>
      </div>
      <p class="card-foot">${escapeHTML(t("overview.townsFoot"))}</p>
    </section>

    <section class="card susceptibility-slot" style="margin-top:var(--space-4)" aria-labelledby="suscTitle">
      <div class="row">
        ${icon("layers", { size: 22 })}
        <div class="spacer">
          <h2 id="suscTitle" style="font-size:var(--text-md)">${escapeHTML(t("overview.suscTitle"))} <span class="badge">${escapeHTML(t("common.comingSoon"))}</span></h2>
          <p class="muted">${escapeHTML(t("overview.suscBody"))}</p>
        </div>
      </div>
    </section>`;
}

export async function mount(container) {
  let alive = true;
  let engine = null;
  const cleanups = [];

  async function load({ quiet = false } = {}) {
    if (!quiet) container.innerHTML = `<div class="card">${loadingState()}</div>`;
    let data;
    try {
      data = await getJSON("/api/overview?hours=48", { ttlMs: TTL, timeoutMs: 30000 });
    } catch (error) {
      if (!alive) return;
      container.innerHTML = `<div class="card">${errorState(error)}</div>`;
      onRetry(container, load);
      return;
    }
    if (!alive) return;
    engine?.destroy();
    engine = null;
    cleanups.splice(0).forEach((fn) => fn());
    container.innerHTML = render(data);
    container.querySelectorAll("[data-why]").forEach((b) => b.addEventListener("click", () => EXPLAIN[b.dataset.why]?.()));

    // Province chart: heaviest hourly value across the 12 town points.
    const steps = data.municipalities?.[0]?.series?.length || 0;
    const bars = Array.from({ length: Math.min(48, steps) }, (_, i) => {
      const values = (data.municipalities || []).map((m) => ({ name: m.name, p: m.series?.[i] })).filter((x) => isNumber(x.p?.precipitation_mm));
      const top = values.sort((a, b) => b.p.precipitation_mm - a.p.precipitation_mm)[0];
      const time = data.municipalities[0].series[i].time;
      const date = parseTime(time);
      const hour = date ? Number(date.toLocaleString("en-US", { timeZone: "Asia/Manila", hour: "numeric", hour12: false })) : 0;
      return {
        label: hour === 0 ? date.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", weekday: "short" }) : formatHour(time),
        hour,
        value: top ? top.p.precipitation_mm : null,
        color: top ? levelColor(top.p.level) : undefined,
        title: top ? `${formatTime(time)}: ${top.p.precipitation_mm} mm/h in ${top.name} (${levelLabel(top.p.level, getLang())})` : `${formatTime(time)}: no data`,
      };
    });
    const chartEl = container.querySelector("#provinceChart");
    cleanups.push(mountChart(chartEl, (width) => barChart(bars, {
      width, height: 170, unit: "mm/h", minMax: 2, ariaLabel: t("overview.provinceChart"),
      showLabel: (i, bar) => bar.hour % (width < 520 ? 12 : 6) === 0,
      guides: [
        { value: THRESHOLDS.yellow, label: "Yellow 7.5", color: "#ca8a04" },
        { value: THRESHOLDS.orange, label: "Orange 15", color: "#ea580c" },
        { value: THRESHOLDS.redAbove, label: "Red 30", color: "#dc2626" },
      ],
    })));

    // Small map (optional: the page still works if the map library fails).
    const mapEl = container.querySelector("#overviewMap");
    try {
      const { createAgosMap } = await import("../map/engine.js");
      engine = await createAgosMap(mapEl, {
        theme: effectiveTheme(),
        cooperative: true,
        onSelectMunicipality: (name) => { location.hash = buildHash("municipality", [name]); },
      });
      if (!alive) { engine.destroy(); return; }
      await engine.ready;
      mapEl.querySelector(".map-loading")?.remove();
      engine.setLayer("evacuation", false);
      engine.setLayer("reports", false);
      engine.setRain((data.municipalities || []).map((m) => ({
        name: m.name, point: m.point, level: m.level_24h,
        valueText: isNumber(m.windows?.next_24h?.peak_mm_h) ? `${num(m.windows.next_24h.peak_mm_h, 1)} mm/h` : "—",
        labelText: levelLabel(m.level_24h, getLang()),
      })));
    } catch (error) {
      if (alive) mapEl.innerHTML = `<div class="state">${icon("map", { size: 28 })}<span>${escapeHTML(error.message)}</span></div>`;
    }
  }

  const onTheme = (event) => engine?.setTheme(event.detail.theme);
  document.addEventListener("agos:theme", onTheme);
  await load();
  const timer = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, TTL);

  return () => {
    alive = false;
    clearInterval(timer);
    document.removeEventListener("agos:theme", onTheme);
    cleanups.forEach((fn) => fn());
    engine?.destroy();
  };
}

