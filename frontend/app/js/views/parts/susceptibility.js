/*
 * Overview: "Flood susceptibility by area" from the official DENR-MGB map
 * (/api/susceptibility). One stacked bar per town (share of land per MGB class);
 * tapping a town shows its most susceptible barangays and, when available,
 * today's flood warning sign. Susceptibility is "where flooding is possible",
 * not a forecast.
 */

import { icon } from "../../core/icons.js";
import { t } from "../../core/i18n.js";
import { escapeHTML, num, isNumber, formatDate } from "../../core/format.js";
import { watchBadge } from "./watch.js";

// Same colours as the MGB legend on the map page.
export const SUSC_CLASSES = [
  { key: "very_high", color: "#002673" },
  { key: "high", color: "#5900ff" },
  { key: "moderate", color: "#b045ff" },
  { key: "low", color: "#e3d1ff" },
  { key: "not_rated", color: "var(--border-strong)" },
];

export function pct(share) {
  if (!isNumber(share)) return "—";
  const v = share * 100;
  if (v > 0 && v < 1) return "<1%";
  return `${num(v, 0)}%`;
}

/** Share of land rated High or Very High. */
export function highShare(shares) {
  return shares ? (shares.high || 0) + (shares.very_high || 0) : null;
}

export function stackedBar(shares, { label = "" } = {}) {
  if (!shares) return `<span class="susc-bar susc-bar-empty" aria-hidden="true"></span>`;
  const parts = SUSC_CLASSES.filter((c) => shares[c.key] > 0)
    .map((c) => `<span style="width:${(shares[c.key] * 100).toFixed(2)}%;background:${c.color}" title="${escapeHTML(`${t(`susc.class.${c.key}`)}: ${pct(shares[c.key])}`)}"></span>`)
    .join("");
  return `<span class="susc-bar" role="img" aria-label="${escapeHTML(label)}">${parts}</span>`;
}

export function barLabel(name, shares) {
  return t("susc.barAria", { town: name, high: pct(highShare(shares)), moderate: pct(shares?.moderate), low: pct(shares?.low), none: pct(shares?.not_rated) });
}

function legend(present) {
  return `<div class="susc-legend subtle">${SUSC_CLASSES.filter((c) => c.key === "not_rated" || present.includes(c.key))
    .map((c) => `<span><i style="background:${c.color}"></i>${escapeHTML(t(`susc.class.${c.key}`))}</span>`).join("")}</div>`;
}

export function renderSusceptibility(data) {
  if (!data) return "";
  if (!data.available) {
    return `<section class="card" style="margin-top:var(--space-4)"><div class="card-head"><div><h2>${escapeHTML(t("susc.title"))}</h2></div></div>
      <div class="notice notice-info">${icon("info", { size: 18 })}<div>${escapeHTML(t("susc.missing"))}</div></div></section>`;
  }
  const check = data.check?.spearman_high_share_vs_listed_floods;
  return `<section class="card" style="margin-top:var(--space-4)" aria-labelledby="suscTitle">
    <div class="card-head">
      <div><h2 id="suscTitle">${escapeHTML(t("susc.title"))}</h2><p>${escapeHTML(t("susc.sub"))}</p></div>
      <button class="why" type="button" data-susc-why aria-label="${escapeHTML(t("common.why"))}">${icon("info", { size: 16 })}</button>
    </div>
    ${legend(data.classes_present || [])}
    <ul class="susc-chart">${data.towns.map((town) => `<li>
      <button type="button" class="susc-row" data-susc-pick="${escapeHTML(town.name)}" aria-expanded="false" aria-controls="suscDetail">
        <span class="susc-row-name"><strong>${escapeHTML(town.name)}</strong><span class="subtle">${escapeHTML(t("susc.highShort", { p: pct(highShare(town.shares)) }))}</span></span>
        ${stackedBar(town.shares, { label: barLabel(town.name, town.shares) })}
      </button></li>`).join("")}</ul>
    <div id="suscDetail" class="watch-detail" aria-live="polite"></div>
    ${isNumber(check) ? `<p class="subtle">${escapeHTML(t("susc.check", { r: num(check, 2), n: data.check.towns }))}</p>` : ""}
    <p class="card-foot">${escapeHTML(t("susc.foot", { when: data.built_at ? formatDate(data.built_at) : "—", step: num(data.step_m, 0) }))}</p>
  </section>`;
}

export function renderSuscDetail(data, name, watch) {
  const town = data?.towns?.find((x) => x.name === name);
  if (!town) return "";
  const sign = watch?.towns?.find((x) => x.name === name);
  const rows = town.top_barangays.map((b) => `<li class="susc-bgy">
      <span class="susc-bgy-name">${escapeHTML(b.name)}<span class="subtle">${escapeHTML(t("susc.highShort", { p: pct(highShare(b.shares)) }))}</span></span>
      ${stackedBar(b.shares, { label: barLabel(b.name, b.shares) })}
    </li>`).join("");
  return `<div class="watch-detail-inner">
    <div class="row" style="justify-content:space-between;align-items:center"><h3>${escapeHTML(town.name)}</h3>${sign ? `<span class="row" style="gap:6px"><span class="subtle">${escapeHTML(t("susc.today"))}</span>${watchBadge(sign.level)}</span>` : ""}</div>
    <p>${escapeHTML(t("susc.townLine", { town: town.name, high: pct(highShare(town.shares)), moderate: pct(town.shares?.moderate), low: pct(town.shares?.low), none: pct(town.shares?.not_rated) }))}</p>
    ${sign && ["watch", "warning", "high_warning"].includes(sign.level) ? `<div class="notice notice-warning">${icon("alert", { size: 18 })}<div>${escapeHTML(t("susc.todayRaised", { town: town.name }))}</div></div>` : ""}
    <h4>${escapeHTML(t("susc.topTitle"))}</h4>
    ${rows ? `<ul class="susc-bgys">${rows}</ul>` : `<p class="subtle">${escapeHTML(t("susc.noneRanked"))}</p>`}
    ${town.barangays_unsampled.length ? `<p class="subtle">${escapeHTML(t("susc.unsampled", { names: town.barangays_unsampled.join(", ") }))}</p>` : ""}
    ${isNumber(town.listed_floods) ? `<p>${escapeHTML(t("susc.listed", { town: town.name, n: town.listed_floods }))}</p>` : ""}
    <p class="subtle">${escapeHTML(t("susc.mapHint"))} <a href="#/map">${escapeHTML(t("susc.openMap"))}</a></p>
  </div>`;
}

/** Wire the chart; `getWatch` returns the latest warning-sign data (or null). */
export function mountSusceptibility(root, data, getWatch) {
  const detail = root.querySelector("#suscDetail");
  if (!detail || !data?.towns?.length) return;
  const rows = [...root.querySelectorAll("[data-susc-pick]")];
  const pick = (name) => {
    rows.forEach((b) => {
      const on = b.dataset.suscPick === name;
      b.setAttribute("aria-expanded", String(on));
      b.classList.toggle("is-picked", on);
    });
    detail.innerHTML = renderSuscDetail(data, name, getWatch?.());
  };
  rows.forEach((b) => b.addEventListener("click", () => pick(b.dataset.suscPick)));
  pick(data.towns[0].name);
  return pick;
}

export function explainSusceptibility(fil) {
  return fil ? `
    <p>Galing ito sa opisyal na <strong>Detailed Flood Susceptibility</strong> map ng DENR–Mines and Geosciences Bureau (MGB), ang parehong layer sa pahina ng Mapa. Ipinapakita nito kung <strong>saan posible ang baha</strong> sa pangkalahatan, hindi kung babaha ngayon at hindi ang lalim.</p>
    <p>Kinuha ng AGOS ang mga hugis ng MGB sa Bataan nang isang beses at sinukat, sa mga puntong may 200 m na pagitan sa loob ng bawat barangay, kung anong bahagi ng lupa ang nasa bawat klase. Ang maliliit na barangay ay may kaunting punto, kaya magaspang ang kanilang bilang; ang mas maliit pa sa 200 m ay maaaring walang punto (sinasabi ito).</p>
    <p>Ang <strong>"walang rating"</strong> ay lupang hindi inuri ng MGB (kadalasang bundok at gubat). Hindi ito nangangahulugang ligtas.</p>
    <p>Pagsusuri: ang mga bayang mas maraming lupang "High" ay mas madalas nasa listahan ng baha ng AGOS (rank correlation sa 12 bayan). Kakaunti ang bayan, kaya gabay lang ito.</p>
    <p>Ang "Ngayon" ay ang babalang tanda mula sa ulan (sa itaas). Pinagsama: ang lugar na mataas ang susceptibility sa bayang may babalang tanda ang dapat unang bantayan.</p>` : `
    <p>This comes from the official <strong>Detailed Flood Susceptibility</strong> map of the DENR–Mines and Geosciences Bureau (MGB), the same layer as on the Map page. It shows <strong>where flooding is possible</strong> in general, not whether it will flood now, and not how deep.</p>
    <p>AGOS downloaded MGB's shapes over Bataan once and measured, at points 200 m apart inside each barangay, which share of the land falls in each class. Small barangays get few points, so their numbers are rough; barangays smaller than 200 m may get none (this is said).</p>
    <p><strong>"Not rated"</strong> is land MGB did not classify (mostly mountains and forest). It does not mean safe.</p>
    <p>Check: towns with more High land appear more often on the AGOS flood list (rank correlation over 12 towns). With only 12 towns this is a guide, not proof.</p>
    <p>"Today" is the rain warning sign (above). Together: highly susceptible areas in a town with a warning sign are the ones to watch first.</p>`;
}
