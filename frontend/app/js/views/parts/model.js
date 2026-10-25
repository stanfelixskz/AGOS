/*
 * Analytics: "How reliable would a simple alert be?". Shows what a plain rule
 * ("3-day rain in the town's top X%") would have done on the known past floods
 * (/api/flood-model), tested year by year. Not a forecast and not a probability.
 */

import { icon } from "../../core/icons.js";
import { t } from "../../core/i18n.js";
import { escapeHTML, num, isNumber } from "../../core/format.js";

/** "62% (45–78%)" from a fraction and a [low, high] range. */
export function pctRange(value, range) {
  if (!isNumber(value)) return "—";
  const p = (x) => `${num(x * 100, 0)}`;
  return range && range.length === 2 ? `${p(value)}% (${p(range[0])}–${p(range[1])}%)` : `${p(value)}%`;
}

/** Share of alert episodes that did not overlap a listed flood (an upper bound on false alarms). */
export function unlistedShare(row) {
  if (!row || !row.episodes) return null;
  return 1 - row.hit_episodes / row.episodes;
}

function tableRows(rows) {
  return rows.map((r) => `<tr>
    <th scope="row">${escapeHTML(t("model.level", { p: num(100 - r.threshold, 1) }))}</th>
    <td class="num">${escapeHTML(`${r.caught} / ${r.cases}`)}<div class="subtle">${escapeHTML(pctRange(r.recall, r.recall_range))}</div></td>
    <td class="num">${escapeHTML(String(r.episodes))}</td>
    <td class="num">${escapeHTML(String(r.hit_episodes))}<div class="subtle">${escapeHTML(isNumber(r.precision_lower_bound) ? `≥ ${num(r.precision_lower_bound * 100, 0)}%` : "—")}</div></td>
  </tr>`).join("");
}

function table(rows) {
  return `<div class="table-wrap"><table class="table">
    <thead><tr>
      <th scope="col">${escapeHTML(t("model.colLevel"))}</th>
      <th scope="col" class="num">${escapeHTML(t("model.colCaught"))}</th>
      <th scope="col" class="num">${escapeHTML(t("model.colEpisodes"))}</th>
      <th scope="col" class="num">${escapeHTML(t("model.colHit"))}</th>
    </tr></thead><tbody>${tableRows(rows)}</tbody></table></div>`;
}

export function renderModel(data) {
  if (!data?.summary) return "";
  const s = data.summary;
  const head = `<div class="card-head">
      <div><h2 id="modelTitle">${escapeHTML(t("model.title"))}</h2>
        <p>${escapeHTML(t("model.sub", { cases: s.cases, towns: s.towns, years: s.years }))}</p></div>
      <button class="why" type="button" data-explain="model" aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>
    </div>`;
  if (!s.enough_cases) {
    return `<section class="card" style="margin-top:var(--space-4)" aria-labelledby="modelTitle">${head}
      <div class="notice notice-info">${icon("info", { size: 18 })}<div>${escapeHTML(t("model.few", { n: s.min_cases }))}</div></div></section>`;
  }
  const loyo = data.rain.leave_one_year_out?.result;
  const tiles = loyo ? `<div class="grid grid-3" style="margin-bottom:var(--space-3)">
      <div class="stat"><span class="stat-label">${escapeHTML(t("model.tileCaught"))}</span><span class="stat-value num">${escapeHTML(pctRange(loyo.recall, loyo.recall_range))}</span><span class="subtle">${escapeHTML(t("model.tileCaughtSub", { k: loyo.caught, n: loyo.cases }))}</span></div>
      <div class="stat"><span class="stat-label">${escapeHTML(t("model.tileAlerts"))}</span><span class="stat-value num">${escapeHTML(String(loyo.episodes))}</span><span class="subtle">${escapeHTML(t("model.tileAlertsSub", { k: loyo.hit_episodes }))}</span></div>
      <div class="stat"><span class="stat-label">${escapeHTML(t("model.tileUnlisted"))}</span><span class="stat-value num">${escapeHTML(isNumber(unlistedShare(loyo)) ? `${num(unlistedShare(loyo) * 100, 0)}%` : "—")}</span><span class="subtle">${escapeHTML(t("model.tileUnlistedSub"))}</span></div>
    </div>` : "";
  const f = data.flow_towns;
  const flowBlock = f && f.cases >= s.min_cases ? `
      <h3 style="margin-top:var(--space-4)">${escapeHTML(t("model.flowTitle", { n: f.towns.length, cases: f.cases }))}</h3>
      <p class="subtle">${escapeHTML(t("model.flowNote"))}</p>
      ${f.leave_one_year_out_rain && f.leave_one_year_out_rain_or_flow ? `<p>${escapeHTML(t("model.flowCompare", {
        a: pctRange(f.leave_one_year_out_rain.result.recall, null),
        ea: f.leave_one_year_out_rain.result.episodes,
        b: pctRange(f.leave_one_year_out_rain_or_flow.result.recall, null),
        eb: f.leave_one_year_out_rain_or_flow.result.episodes,
      }))}</p>` : ""}` : "";
  return `<section class="card" style="margin-top:var(--space-4)" aria-labelledby="modelTitle">${head}
    ${tiles}
    <div class="notice notice-warning">${icon("info", { size: 18 })}<div>${escapeHTML(t("model.caution"))}</div></div>
    <h3 style="margin-top:var(--space-3)">${escapeHTML(t("model.tableTitle"))}</h3>
    ${table(data.rain.table)}
    ${flowBlock}
    <p class="card-foot">${escapeHTML(t("model.foot"))}</p>
  </section>`;
}

export function explainModel(fil) {
  return fil ? `
    <p>Ito ay pagsubok ng <strong>simpleng patakaran</strong>, hindi forecast: "magbabala kapag ang 3-araw na ulan ng bayan ay nasa pinakamataas na X% ng sarili nitong talaan".</p>
    <p><strong>Nahuli</strong> = bilang ng nakalistang baha na may hindi bababa sa isang araw ng babala sa loob ng petsa nito (3 araw bago hanggang 1 araw pagkatapos). <strong>Babala</strong> = magkakasunod na araw ng babala na pinagsama.</p>
    <p>Ang <strong>pagsubok taon-taon</strong> ay pumipili ng antas gamit ang ibang mga taon (pinakamataas na F1), at hinahatulan sa taong hindi ginamit. Kaya hindi ito "kinabisado" ng datos.</p>
    <p>Dahil kulang sa maliliit na baha ang listahan, ang babalang walang nakalistang baha ay maaaring totoong baha na hindi naitala. Kaya ang bahagi ng tamang babala ay <strong>pinakamababang tantiya</strong>, at ang "walang nakalistang baha" ay <strong>pinakamataas na tantiya</strong> ng maling babala. Ang mga saklaw ay 95% Wilson interval; kakaunti ang kaso, kaya malawak.</p>
    <p>Hindi nakikita ang tubig-dagat (tide), sirang dike at ulan sa itaas ng ilog.</p>` : `
    <p>This tests a <strong>simple rule</strong>, not a forecast: "warn when the town's 3-day rain is in the top X% of its own record".</p>
    <p><strong>Caught</strong> = listed floods with at least one warning day inside their window (3 days before to 1 day after). A <strong>warning</strong> is a run of consecutive alert days merged together.</p>
    <p>The <strong>year-by-year test</strong> picks the level using the other years (best F1) and judges it on the held-out year, so the rule is not fitted to the answers it is graded on.</p>
    <p>The events list misses small floods, so a warning with no listed flood may have been a real, unreported flood. That makes the share of correct warnings a <strong>lower bound</strong> and "no listed flood" an <strong>upper bound</strong> on false alarms. Ranges are 95% Wilson intervals; with few cases they are wide.</p>
    <p>Tide, broken dikes and upstream rain are not seen.</p>`;
}
