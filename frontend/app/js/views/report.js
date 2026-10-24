/*
 * Report flooding: short, phone-first form posting to POST /reports/community
 * (the existing API). Recent reports are listed below and shown on the map.
 * Reports are unverified until reviewed; contact numbers are never shown.
 */

import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { getJSON, postForm, clearApiCache } from "../core/api.js";
import { escapeHTML, formatTime, relativeTime, isNumber } from "../core/format.js";
import { loadingState, errorState, onRetry } from "../core/ui.js";
import { buildHash, navigate } from "../core/router.js";

const TOWNS = ["Abucay", "Bagac", "Balanga", "Dinalupihan", "Hermosa", "Limay", "Mariveles", "Morong", "Orani", "Orion", "Pilar", "Samal"];
const SEVERITIES = [
  { value: "low", depth: "0–15 cm", hint: "ankle" },
  { value: "moderate", depth: "15–50 cm", hint: "knee" },
  { value: "high", depth: "50–100 cm", hint: "waist" },
  { value: "critical", depth: "> 100 cm", hint: "above" },
];
const MAX_PHOTO = 8 * 1024 * 1024;

function localNow() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}

function statusBadge(report) {
  const status = report.verification_status;
  if (status === "verified") return `<span class="badge badge-success">${escapeHTML(t("report.verified"))}</span>`;
  if (status === "rejected") return `<span class="badge badge-danger">${escapeHTML(t("report.rejected"))}</span>`;
  return `<span class="badge badge-warning">${escapeHTML(t("common.unverified"))}</span>`;
}

export async function mount(container) {
  let alive = true;

  container.innerHTML = `
    <div class="page-head">
      <div>
        <div class="eyebrow">${escapeHTML(t("report.eyebrow"))}</div>
        <h1>${escapeHTML(t("title.report"))}</h1>
        <p>${escapeHTML(t("report.intro"))}</p>
      </div>
    </div>

    <div class="report-layout">
      <form class="card report-form" id="reportForm" novalidate>
        <div class="notice notice-warning">${icon("alert", { size: 18 })}<div>${escapeHTML(t("report.safety"))}</div></div>

        <fieldset class="form-step">
          <legend><span class="step-num">1</span>${escapeHTML(t("report.where"))}</legend>
          <div class="grid grid-2">
            <label class="field"><span>${escapeHTML(t("common.municipality"))} *</span>
              <select class="select" name="municipality" required><option value="">${escapeHTML(t("report.choose"))}</option>${TOWNS.map((n) => `<option>${n}</option>`).join("")}</select>
            </label>
            <label class="field"><span>${escapeHTML(t("report.barangay"))} *</span><input class="input" name="barangay" maxlength="150" required autocomplete="off"></label>
          </div>
          <label class="field"><span>${escapeHTML(t("report.location"))} *</span><input class="input" name="location" maxlength="300" required placeholder="${escapeHTML(t("report.locationHint"))}"></label>
          <div class="row">
            <button class="btn btn-sm" type="button" id="gpsBtn">${icon("locate", { size: 16 })} ${escapeHTML(t("report.addGps"))}</button>
            <span class="subtle" id="gpsStatus" role="status" aria-live="polite">${escapeHTML(t("report.gpsOptional"))}</span>
          </div>
          <input type="hidden" name="latitude"><input type="hidden" name="longitude">
        </fieldset>

        <fieldset class="form-step">
          <legend><span class="step-num">2</span>${escapeHTML(t("report.what"))}</legend>
          <div class="severity-grid" role="radiogroup" aria-label="${escapeHTML(t("report.severity"))}">
            ${SEVERITIES.map((s) => `
              <label class="severity" data-sev="${s.value}">
                <input type="radio" name="severity" value="${s.value}" required>
                <span class="severity-card"><strong>${escapeHTML(t(`report.sev.${s.value}`))}</strong><span>${escapeHTML(t(`report.depth.${s.hint}`))}</span><span class="num subtle">${escapeHTML(s.depth)}</span></span>
              </label>`).join("")}
          </div>
          <div class="grid grid-2">
            <label class="field"><span>${escapeHTML(t("report.depthCm"))}</span><input class="input" type="number" name="water_level_cm" min="0" max="1000" step="1" inputmode="numeric" placeholder="${escapeHTML(t("report.depthOptional"))}"></label>
            <label class="field"><span>${escapeHTML(t("report.when"))} *</span><input class="input" type="datetime-local" name="reported_at" required></label>
          </div>
        </fieldset>

        <fieldset class="form-step">
          <legend><span class="step-num">3</span>${escapeHTML(t("report.details"))}</legend>
          <label class="field"><span>${escapeHTML(t("report.description"))} *</span><textarea class="textarea" name="description" minlength="10" maxlength="3000" required placeholder="${escapeHTML(t("report.descriptionHint"))}"></textarea></label>
          <label class="field"><span>${escapeHTML(t("report.photo"))}</span><input class="input" type="file" name="photo" accept="image/jpeg,image/png,image/webp"><span class="hint">${escapeHTML(t("report.photoHint"))}</span></label>
          <label class="field"><span>${escapeHTML(t("report.contact"))}</span><input class="input" type="tel" name="contact_number" maxlength="30" autocomplete="tel"><span class="hint">${escapeHTML(t("report.contactHint"))}</span></label>
          <label class="check"><input type="checkbox" name="accuracy_confirmed" value="true" required><span>${escapeHTML(t("report.confirm"))} *</span></label>
        </fieldset>

        <div id="formError" class="notice notice-danger" role="alert" hidden></div>
        <button class="btn btn-primary btn-block" type="submit" id="submitBtn">${icon("report", { size: 18 })} ${escapeHTML(t("report.submit"))}</button>
      </form>

      <section class="card" aria-labelledby="recentTitle">
        <div class="card-head">
          <div><h2 id="recentTitle">${escapeHTML(t("report.recent"))}</h2><p>${escapeHTML(t("report.recentSub"))}</p></div>
          <a class="btn btn-sm" href="${buildHash("map")}">${icon("map", { size: 16 })} ${escapeHTML(t("common.openMap"))}</a>
        </div>
        <ul class="list" id="recentList">${loadingState()}</ul>
      </section>
    </div>`;

  const form = container.querySelector("#reportForm");
  const errorBox = container.querySelector("#formError");
  form.elements.reported_at.value = localNow();

  container.querySelector("#gpsBtn").addEventListener("click", () => {
    const status = container.querySelector("#gpsStatus");
    if (!navigator.geolocation) { status.textContent = t("map.locateUnsupported"); return; }
    status.textContent = t("evac.locating");
    navigator.geolocation.getCurrentPosition((pos) => {
      form.elements.latitude.value = pos.coords.latitude.toFixed(6);
      form.elements.longitude.value = pos.coords.longitude.toFixed(6);
      status.textContent = t("report.gpsAdded", { acc: Math.round(pos.coords.accuracy) });
    }, () => { status.textContent = t("map.locateDenied"); }, { enableHighAccuracy: true, timeout: 12000 });
  });

  function validate() {
    const problems = [];
    const f = form.elements;
    if (!f.municipality.value) problems.push(t("report.err.municipality"));
    if (!f.barangay.value.trim()) problems.push(t("report.err.barangay"));
    if (!f.location.value.trim()) problems.push(t("report.err.location"));
    if (!form.querySelector('input[name="severity"]:checked')) problems.push(t("report.err.severity"));
    if (f.description.value.trim().length < 10) problems.push(t("report.err.description"));
    if (!f.reported_at.value) problems.push(t("report.err.when"));
    if (f.reported_at.value && new Date(f.reported_at.value).getTime() > Date.now() + 5 * 60000) problems.push(t("report.err.future"));
    const photo = f.photo.files?.[0];
    if (photo && photo.size > MAX_PHOTO) problems.push(t("report.err.photo"));
    if (!f.accuracy_confirmed.checked) problems.push(t("report.err.confirm"));
    return problems;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const problems = validate();
    if (problems.length) {
      errorBox.hidden = false;
      errorBox.innerHTML = `${icon("alert", { size: 18 })}<div><strong>${escapeHTML(t("report.fix"))}</strong><ul style="margin:4px 0 0;padding-left:18px">${problems.map((p) => `<li>${escapeHTML(p)}</li>`).join("")}</ul></div>`;
      errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    errorBox.hidden = true;
    const data = new FormData();
    const f = form.elements;
    for (const name of ["municipality", "barangay", "location", "description"]) data.append(name, f[name].value.trim());
    data.append("severity", form.querySelector('input[name="severity"]:checked').value);
    data.append("report_type", "Flooding");
    if (f.water_level_cm.value !== "") data.append("water_level_cm", f.water_level_cm.value);
    if (f.latitude.value && f.longitude.value) {
      data.append("latitude", f.latitude.value);
      data.append("longitude", f.longitude.value);
    }
    data.append("reported_at", new Date(f.reported_at.value).toISOString());
    if (f.contact_number.value.trim()) data.append("contact_number", f.contact_number.value.trim());
    data.append("accuracy_confirmed", "true");
    if (f.photo.files?.[0]) data.append("photo", f.photo.files[0]);

    const button = container.querySelector("#submitBtn");
    button.disabled = true;
    button.textContent = t("report.sending");
    try {
      const result = await postForm("/reports/community", data);
      clearApiCache();
      form.innerHTML = `<div class="state">${icon("check", { size: 36 })}
        <strong>${escapeHTML(t("report.thanks"))}</strong>
        <span>${escapeHTML(result.message || "")}</span>
        <span class="num subtle">${escapeHTML(result.report?.report_id || "")}</span>
        <div class="row" style="justify-content:center;margin-top:8px">
          <a class="btn" href="${buildHash("map")}">${escapeHTML(t("common.openMap"))}</a>
          <button class="btn btn-primary" type="button" id="againBtn">${escapeHTML(t("report.another"))}</button>
        </div></div>`;
      form.querySelector("#againBtn").addEventListener("click", () => navigate("report"));
      loadRecent();
    } catch (error) {
      button.disabled = false;
      button.innerHTML = `${icon("report", { size: 18 })} ${escapeHTML(t("report.submit"))}`;
      errorBox.hidden = false;
      errorBox.innerHTML = `${icon("alert", { size: 18 })}<div><strong>${escapeHTML(t("report.failed"))}</strong> ${escapeHTML(error.message)}</div>`;
    }
  });

  async function loadRecent() {
    const list = container.querySelector("#recentList");
    try {
      const data = await getJSON("/reports", { ttlMs: 30000 });
      if (!alive) return;
      const reports = (data.reports || []).slice(0, 12);
      list.innerHTML = reports.length ? reports.map((r) => `
        <li class="recent-report">
          <div class="row" style="justify-content:space-between;gap:8px">
            <strong>${escapeHTML(r.barangay || r.location || "")}, ${escapeHTML(r.municipality || "")}</strong>
            ${statusBadge(r)}
          </div>
          <div class="row" style="gap:8px;margin-top:4px">
            <span class="badge sev-${escapeHTML(r.severity || "")}">${escapeHTML(t(`report.sev.${r.severity}`) || r.severity || "")}</span>
            ${isNumber(r.water_level_cm) ? `<span class="subtle num">~${escapeHTML(String(r.water_level_cm))} cm</span>` : ""}
            <span class="subtle">${escapeHTML(formatTime(r.reported_at))} · ${escapeHTML(relativeTime(r.reported_at))}</span>
          </div>
          ${r.description ? `<p class="muted recent-desc">${escapeHTML(r.description)}</p>` : ""}
        </li>`).join("") : `<li class="state">${icon("report", { size: 24 })}<span>${escapeHTML(t("report.noneYet"))}</span></li>`;
    } catch (error) {
      if (!alive) return;
      list.innerHTML = `<li>${errorState(error)}</li>`;
      onRetry(list, loadRecent);
    }
  }

  loadRecent();
  return () => { alive = false; };
}
