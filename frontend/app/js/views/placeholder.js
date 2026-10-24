/* Temporary page for sections whose redesign arrives in a later pull request. */

import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { escapeHTML } from "../core/format.js";

export function placeholder(view) {
  return function mount(container) {
    container.innerHTML = `
      <div class="card">
        <div class="state">
          ${icon("clock", { size: 32 })}
          <strong>${escapeHTML(t("placeholder.title"))}</strong>
          <span>${escapeHTML(t("placeholder.body"))}</span>
          <a class="btn btn-primary" href="legacy.html" data-view="${escapeHTML(view)}">${escapeHTML(t("common.legacy"))} ${icon("external", { size: 16 })}</a>
        </div>
      </div>`;
  };
}
