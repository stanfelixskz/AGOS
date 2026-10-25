import { icon } from "../core/icons.js";
import { t } from "../core/i18n.js";
import { escapeHTML } from "../core/format.js";

export function mount(container, route) {
  container.innerHTML = `
    <div class="card"><div class="state">
      ${icon("help", { size: 32 })}
      <strong>${escapeHTML(t("title.notfound"))}</strong>
      <span class="num">#/${escapeHTML(route.requested)}</span>
      <a class="btn btn-primary" href="#/overview">${escapeHTML(t("nav.overview"))}</a>
    </div></div>`;
}
