/* Small UI helpers: toasts, dialogs, loading / error / empty states. */

import { icon } from "./icons.js";
import { escapeHTML } from "./format.js";
import { t } from "./i18n.js";

export function toast(message, ms = 3200) {
  let region = document.querySelector(".toast-region");
  if (!region) {
    region = document.createElement("div");
    region.className = "toast-region";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.append(region);
  }
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  region.append(el);
  setTimeout(() => el.remove(), ms);
}

/** Open a modal dialog. bodyHTML must already be escaped by the caller. */
export function openDialog(title, bodyHTML) {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog";
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = `
    <div class="dialog-head">
      <h2>${escapeHTML(title)}</h2>
      <button class="btn btn-ghost btn-icon btn-sm" type="button" data-close aria-label="${escapeHTML(t("common.close"))}">${icon("close", { size: 18 })}</button>
    </div>
    <div class="dialog-body">${bodyHTML}</div>`;
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target.closest("[data-close]")) dialog.close();
  });
  dialog.showModal();
  return dialog;
}

export function loadingState(label = t("common.loading")) {
  return `<div class="state" role="status" aria-live="polite"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:40%"></div><span class="visually-hidden">${escapeHTML(label)}</span></div>`;
}

export function errorState(error, { retry = true } = {}) {
  const message = error?.message || String(error || "Something went wrong.");
  const offline = error?.kind === "offline" || error?.kind === "timeout";
  return `<div class="state" role="alert">
      ${icon(offline ? "database" : "alert", { size: 28 })}
      <strong>${escapeHTML(offline ? t("status.offline") : t("common.notAvailable"))}</strong>
      <span>${escapeHTML(message)}</span>
      ${offline ? `<span class="subtle">${escapeHTML(t("status.offlineHelp"))}</span>` : ""}
      ${retry ? `<button class="btn btn-sm" type="button" data-retry>${icon("refresh", { size: 16 })}${escapeHTML(t("common.retry"))}</button>` : ""}
    </div>`;
}

/** Wire [data-retry] buttons inside root to a callback. */
export function onRetry(root, callback) {
  root.querySelectorAll("[data-retry]").forEach((button) => button.addEventListener("click", callback, { once: true }));
}
