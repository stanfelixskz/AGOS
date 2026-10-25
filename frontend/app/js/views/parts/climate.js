/*
 * Analytics: "Years and seasons" section. Statistics of past rain per town,
 * computed by the backend (/api/climate) from the AGOS database. Nothing here
 * is a forecast or a flood probability, and every range is shown with its number.
 */

import { icon } from "../../core/icons.js";
import { t, getLang } from "../../core/i18n.js";
import { escapeHTML, num, isNumber, formatDate } from "../../core/format.js";
import { barChart, mountChart } from "../../core/charts.js";

export function monthName(month, lang = getLang()) {
  return new Date(2001, month - 1, 1).toLocaleDateString(lang === "fil" ? "fil-PH" : "en-PH", { month: "short" });
}

/** "low–high" chance range; one "<1%" when both ends are tiny. */
export function percentRange(low, high) {
  const a = percent(low);
  const b = percent(high);
  return a === b ? a : `${a}–${b}`;
}

export function percent(p) {
  if (!isNumber(p)) return "—";
  const v = p * 100;
  return v < 1 ? "<1%" : `${num(v, v < 10 ? 1 : 0)}%`;
}

function trendText(trend) {
  if (!trend || trend.status !== "ok") return t("climate.trendNone");
  const slope = `${trend.slope_mm_per_year > 0 ? "+" : ""}${num(trend.slope_mm_per_year, 1)}`;
  return t(trend.distinguishable_from_zero ? "climate.trendClear" : "climate.trendFlat", { slope });
}

function returnTables(rl) {
  if (!rl || rl.status === "insufficient_data") {
    return `<div class="notice notice-info">${icon("clock", { size: 18 })}<div>${escapeHTML(t("climate.insufficient", { needed: rl?.needed ?? 10, have: rl?.n_years ?? 0 }))}</div></div>`;
  }
  if (rl.status === "no_variation") {
    return `<div class="notice notice-info">${icon("info", { size: 18 })}<div>${escapeHTML(t("climate.noVariation"))}</div></div>`;
  }
  return `
    <div class="grid grid-2">
      <div class="table-wrap"><table class="table">
        <caption class="subtle" style="text-align:left">${escapeHTML(t("climate.returnTitle"))}</caption>
        <thead><tr>
          <th scope="col">${escapeHTML(t("climate.onceEvery"))}</th>
          <th scope="col" class="num">${escapeHTML(t("climate.dailyRain"))}</th>
          <th scope="col" class="num">${escapeHTML(t("climate.range"))}</th>
        </tr></thead>
        <tbody>${rl.levels.map((lv) => `<tr>
          <th scope="row">${escapeHTML(t("climate.years", { n: lv.years }))}</th>
          <td class="num">${escapeHTML(num(lv.mm, 0))} mm</td>
          <td class="num subtle">${escapeHTML(num(lv.low, 0))}–${escapeHTML(num(lv.high, 0))} mm</td>
        </tr>`).join("")}</tbody>
      </table></div>
      <div class="table-wrap"><table class="table">
        <caption class="subtle" style="text-align:left">${escapeHTML(t("climate.exceedTitle"))}</caption>
        <thead><tr>
          <th scope="col">${escapeHTML(t("climate.aDayOf"))}</th>
          <th scope="col" class="num">${escapeHTML(t("climate.chance"))}</th>
          <th scope="col" class="num">${escapeHTML(t("climate.range"))}</th>
        </tr></thead>
        <tbody>${rl.exceedance.map((e) => `<tr>
          <th scope="row">≥ ${escapeHTML(String(e.mm))} mm</th>
          <td class="num">${escapeHTML(percent(e.probability))}</td>
          <td class="num subtle">${escapeHTML(percentRange(e.low, e.high))}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>
    <p class="subtle">${escapeHTML(t("climate.returnFoot", { n: rl.n_years, max: num(rl.observed_max_mm, 0) }))}</p>`;
}

/** HTML for the section. `selected` is the town name; `data` is the /api/climate payload. */
export function renderClimate(data, selected) {
  if (!data?.any_data) {
    return `<section class="card" style="margin-top:var(--space-4)"><div class="state">${icon("database", { size: 30 })}
      <strong>${escapeHTML(t("climate.noData"))}</strong>
      <span>${escapeHTML(t("climate.noDataBody"))}</span>
      <code class="num subtle">python tools/backfill_history.py --from-year 2015</code></div></section>`;
  }
  const town = data.towns.find((tw) => tw.name === selected) || data.towns[0];
  const full = town.years.filter((y) => y.complete);
  const wettest = full.length ? full.reduce((a, b) => (b.wettest_day.mm > a.wettest_day.mm ? b : a)).wettest_day : null;
  return `
    <section class="card" style="margin-top:var(--space-4)" aria-labelledby="climateTitle">
      <div class="card-head">
        <div><h2 id="climateTitle">${escapeHTML(t("climate.title"))}</h2>
          <p>${escapeHTML(t("climate.sub", { first: data.first_year, last: data.last_year, n: town.full_years }))}</p></div>
        <button class="why" type="button" data-explain="climate" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>
      </div>
      <div class="row town-picker" role="group" aria-label="${escapeHTML(t("climate.pick"))}">
        ${data.towns.map((tw) => `<button type="button" class="chip" data-ctown="${escapeHTML(tw.name)}" aria-pressed="${tw.name === town.name}">${escapeHTML(tw.name)}</button>`).join("")}
      </div>

      <div class="grid grid-3" style="margin:var(--space-4) 0">
        <div class="stat"><span class="stat-label">${escapeHTML(t("climate.fullYears"))}</span><span class="stat-value num">${escapeHTML(String(town.full_years))}</span></div>
        <div class="stat"><span class="stat-label">${escapeHTML(t("climate.wettestRecord"))}</span><span class="stat-value num">${wettest ? `${escapeHTML(num(wettest.mm, 0))} mm` : "—"}</span>${wettest ? `<span class="subtle">${escapeHTML(formatDate(wettest.date))}</span>` : ""}</div>
        <div class="stat"><span class="stat-label">${escapeHTML(t("climate.trend"))}</span><span class="subtle">${escapeHTML(trendText(town.trend))}</span></div>
      </div>

      <h3>${escapeHTML(t("climate.yearly"))}</h3>
      <div class="detail-chart" data-climate-year="${escapeHTML(town.name)}"></div>
      <h3 style="margin-top:var(--space-4)">${escapeHTML(t("climate.monthly"))}</h3>
      <p class="subtle">${escapeHTML(t("climate.monthlySub"))}</p>
      <div class="detail-chart" data-climate-month="${escapeHTML(town.name)}"></div>
      <h3 style="margin-top:var(--space-4)">${escapeHTML(t("climate.returnHeading"))}</h3>
      ${returnTables(town.return_levels)}
      <p class="card-foot">${escapeHTML(t("climate.foot"))}</p>
    </section>`;
}

/** Draw the two charts; returns cleanup functions. */
export function mountClimateCharts(root, data, selected) {
  const town = data?.towns?.find((tw) => tw.name === selected) || data?.towns?.[0];
  if (!town) return [];
  const cleanups = [];
  const yearEl = root.querySelector("[data-climate-year]");
  if (yearEl) {
    const bars = town.years.map((y) => ({
      label: String(y.year),
      value: y.total_mm,
      color: y.complete ? undefined : "var(--chart-missing, #94a3b8)",
      title: y.complete
        ? `${y.year}: ${num(y.total_mm, 0)} mm · ${y.rain_days} ${t("climate.rainDays")}`
        : `${y.year}: ${num(y.total_mm, 0)} mm · ${t("climate.partialYear", { days: y.days_with_data })}`,
    }));
    cleanups.push(mountChart(yearEl, (width) => barChart(bars, { width, height: 150, unit: "mm/yr", minMax: 100, ariaLabel: `${town.name} rain per year`, xLabelEvery: Math.max(1, Math.ceil(bars.length / Math.max(3, Math.floor(width / 60)))) })));
  }
  const monthEl = root.querySelector("[data-climate-month]");
  if (monthEl && town.monthly.length) {
    const bars = town.monthly.map((m) => ({
      label: monthName(m.month),
      value: m.mean_total_mm,
      color: m.above_average ? undefined : "#93c5fd",
      title: `${monthName(m.month)}: ${num(m.mean_total_mm, 0)} mm · ${num(m.mean_rain_days, 0)} ${t("climate.rainDays")}`,
    }));
    cleanups.push(mountChart(monthEl, (width) => barChart(bars, { width, height: 140, unit: "mm/month", minMax: 50, ariaLabel: `${town.name} average rain by month`, xLabelEvery: 1 })));
  }
  return cleanups;
}

export function explainClimate(fil) {
  return fil ? `
    <p>Ang mga numerong ito ay <strong>estadistika ng nakaraan</strong>, hindi forecast at hindi probabilidad ng baha. Galing ang ulan sa archive reanalysis ng Open-Meteo (ERA5) sa reference point ng bayan: model estimate, hindi rain gauge. Ang isang cell ng ERA5 ay mga 25 km ang lapad, kaya kadalasang mas mababa ang pinakamalalakas na araw kaysa sa sukat ng gauge.</p>
    <p><strong>Buong taon</strong> lang ang ginagamit (may datos sa hindi bababa sa 360 araw). Hindi kasama ang kasalukuyang taon. Kulay-abo ang bahagyang taon sa chart.</p>
    <p><strong>"Isang beses kada N taon"</strong>: Gumbel na hugis na ikinasya sa pinakamaulang araw ng bawat taon. Ang <strong>saklaw</strong> ay ang 5th hanggang 95th percentile ng 500 bootstrap na pag-uulit. Kapag maikli ang talaan (mga 11 taon), <strong>malapad ang saklaw</strong> at hindi namin ipinapakita ang lampas sa dalawang beses ng bilang ng taon.</p>
    <p>Ang <strong>trend</strong> ay tuwid na linya sa kabuuang ulan bawat taon. Sinasabing "malinaw" lang kapag mas malaki ito kaysa dalawang beses ng karaniwang error.</p>
    <p class="subtle">Ang mga hangganang 10, 50 at 100 mm bawat araw ay display threshold ng AGOS, hindi kategorya ng PAGASA.</p>` : `
    <p>These numbers are <strong>statistics of the past</strong>, not a forecast and not a flood probability. Rain comes from the Open-Meteo archive reanalysis (ERA5) at the town's reference point: a model estimate, not a rain gauge. One ERA5 cell is about 25 km wide, so the heaviest days usually come out lower than a gauge would measure.</p>
    <p>Only <strong>full years</strong> are used (at least 360 days of data). The current year is left out. A partial year is drawn gray in the chart.</p>
    <p><strong>"Once every N years"</strong>: a Gumbel curve fitted to each year's wettest day. The <strong>range</strong> is the 5th to 95th percentile of 500 bootstrap refits. With a short record (about 11 years) <strong>the range is wide</strong>, and levels beyond twice the number of years are not shown.</p>
    <p>The <strong>trend</strong> is a straight line through yearly totals. It is called "clear" only when it is larger than twice its standard error.</p>
    <p class="subtle">The 10, 50 and 100 mm-a-day limits are AGOS display thresholds, not PAGASA categories.</p>`;
}
