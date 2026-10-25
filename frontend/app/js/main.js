/*
 * AGOS app shell: navigation, routing, theme, language and backend status.
 * Each page is a module in ./views exporting { mount(container, route) }.
 * mount may return a cleanup function that runs when the page is left.
 */

import { icon } from "./core/icons.js";
import { t, initLang, setLang, getLang } from "./core/i18n.js";
import { applyTheme, toggleTheme, watchSystemTheme, effectiveTheme } from "./core/theme.js";
import { onRoute } from "./core/router.js";
import { getJSON } from "./core/api.js";
import { escapeHTML } from "./core/format.js";

const NAV = [
  { id: "overview", icon: "overview" },
  { id: "map", icon: "map" },
  { id: "analytics", icon: "analytics" },
  { id: "evacuate", icon: "evacuate" },
  { id: "report", icon: "report" },
  { id: "sources", icon: "info", sidebarOnly: true },
];

const VIEWS = {
  overview: () => import("./views/overview.js"),
  map: () => import("./views/map.js"),
  municipality: () => import("./views/municipality.js"),
  analytics: () => import("./views/analytics.js"),
  evacuate: () => import("./views/evacuate.js"),
  report: () => import("./views/report.js"),
  sources: () => import("./views/sources.js"),
  notfound: () => import("./views/notfound.js"),
};

const state = { route: null, cleanup: null, token: 0, status: "checking", navShown: false };

function renderNav() {
  const sideNav = document.getElementById("sideNav");
  const tabbar = document.getElementById("tabbar");
  sideNav.innerHTML = `<span class="nav-indicator" aria-hidden="true"></span>` + NAV.map((item, i) => `
    <a href="#/${item.id}" data-nav="${item.id}" style="--i:${i}">${icon(item.icon)}<span>${escapeHTML(t(`nav.${item.id}`))}</span></a>`).join("");
  sideNav.classList.add("has-indicator");
  // Staggered entrance on first load only, not when the language changes.
  if (!state.navShown) {
    state.navShown = true;
    sideNav.classList.add("is-entering");
    sideNav.addEventListener("animationend", (e) => {
      if (e.target === sideNav.lastElementChild) sideNav.classList.remove("is-entering");
    });
  }
  tabbar.innerHTML = NAV.filter((item) => !item.sidebarOnly).map((item) => `
    <a href="#/${item.id}" data-nav="${item.id}">${icon(item.icon, { size: 22 })}<span>${escapeHTML(t(`nav.${item.id}`))}</span></a>`).join("");
  document.getElementById("sidebarDisclaimer").textContent = t("app.disclaimer");
  document.getElementById("brandSub").textContent = t("app.tagline");
  document.getElementById("skipLink").textContent = t("skip");
  markActiveNav();
}

function markActiveNav() {
  const active = state.route?.view === "municipality" ? "map" : state.route?.view;
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  moveNavIndicator();
}

/* Slide the sidebar highlight to the active link. The first placement after
   each render is instant; later moves animate (the is-ready class). */
function moveNavIndicator() {
  const indicator = document.querySelector("#sideNav .nav-indicator");
  if (!indicator) return;
  const link = document.querySelector('#sideNav a[aria-current="page"]');
  if (!link || !link.offsetHeight) {
    indicator.classList.remove("is-visible");
    return;
  }
  indicator.style.setProperty("--nav-y", `${link.offsetTop}px`);
  indicator.style.setProperty("--nav-h", `${link.offsetHeight}px`);
  indicator.classList.add("is-visible");
  if (!indicator.classList.contains("is-ready")) {
    requestAnimationFrame(() => requestAnimationFrame(() => indicator.classList.add("is-ready")));
  }
}

function renderTopbarActions() {
  const actions = document.getElementById("topbarActions");
  const dark = effectiveTheme() === "dark";
  actions.innerHTML = `
    <span class="badge" id="backendBadge" title=""><span class="dot"></span><span class="hide-sm" data-label></span></span>
    <button class="btn btn-ghost btn-sm" type="button" id="langToggle" aria-label="${escapeHTML(t("lang.label"))}">${icon("language", { size: 18 })}<span class="hide-sm">${escapeHTML(t("lang.toggle"))}</span></button>
    <button class="btn btn-ghost btn-icon btn-sm" type="button" id="themeToggle" aria-label="${escapeHTML(t("theme.toggle"))}">${icon(dark ? "sun" : "moon", { size: 18 })}</button>
    <a class="btn btn-ghost btn-icon btn-sm" href="#/sources" aria-label="${escapeHTML(t("nav.sources"))}">${icon("info", { size: 18 })}</a>`;
  document.getElementById("langToggle").addEventListener("click", () => setLang(getLang() === "en" ? "fil" : "en"));
  document.getElementById("themeToggle").addEventListener("click", () => {
    toggleTheme();
    renderTopbarActions();
  });
  renderStatus();
}

function renderStatus() {
  const badge = document.getElementById("backendBadge");
  if (!badge) return;
  const dot = badge.querySelector(".dot");
  const label = badge.querySelector("[data-label]");
  const map = {
    checking: ["", t("status.checking"), ""],
    online: ["dot-live", t("status.online"), ""],
    offline: ["dot-off", t("status.offline"), "badge-danger"],
  };
  const [dotClass, text, badgeClass] = map[state.status];
  dot.className = `dot ${dotClass}`;
  badge.className = `badge ${badgeClass}`;
  label.textContent = text;
  badge.title = state.status === "offline" ? t("status.offlineHelp") : text;
}

async function checkBackend() {
  try {
    await getJSON("/system/status", { timeoutMs: 8000 });
    state.status = "online";
  } catch {
    state.status = "offline";
  }
  renderStatus();
  document.dispatchEvent(new CustomEvent("agos:backend", { detail: { status: state.status } }));
}

function setTitle(route) {
  const key = route.view;
  const title = route.view === "municipality" && route.params[0] ? route.params[0] : t(`title.${key}`);
  const sub = t(`sub.${key}`);
  document.getElementById("pageTitle").textContent = title;
  document.getElementById("pageSub").textContent = sub === `sub.${key}` ? "" : sub;
  document.title = `${title} · AGOS Bataan`;
}

async function show(route) {
  const token = ++state.token;
  const container = document.getElementById("content");
  const previous = state.route;
  state.route = route;
  markActiveNav();
  setTitle(route);

  if (typeof state.cleanup === "function") {
    try {
      state.cleanup();
    } catch (error) {
      console.warn("AGOS: page cleanup failed", error);
    }
  }
  state.cleanup = null;

  const loader = VIEWS[route.view] || VIEWS.notfound;
  let module;
  try {
    module = await loader();
  } catch (error) {
    console.error("AGOS: page module failed to load", error);
    container.className = "content";
    container.innerHTML = `<div class="state" role="alert"><strong>${escapeHTML(t("common.notAvailable"))}</strong><span>${escapeHTML(error.message)}</span></div>`;
    return;
  }
  if (token !== state.token) return; // a newer navigation happened meanwhile

  container.className = module.layout === "flush" ? "content content-flush" : "content";
  container.innerHTML = "";
  if (!previous || previous.view !== route.view) {
    window.scrollTo(0, 0);
    // Restart the fade-in for the new page.
    container.classList.remove("is-entering");
    void container.offsetWidth;
    container.classList.add("is-entering");
  }
  try {
    const cleanup = (await module.mount(container, route)) || null;
    if (token !== state.token) {
      // The user navigated away while this page was still loading.
      if (typeof cleanup === "function") cleanup();
      return;
    }
    state.cleanup = cleanup;
  } catch (error) {
    console.error("AGOS: page failed", error);
    container.innerHTML = `<div class="state" role="alert"><strong>${escapeHTML(t("common.notAvailable"))}</strong><span>${escapeHTML(error.message)}</span></div>`;
  }
}

function start() {
  initLang();
  applyTheme();
  watchSystemTheme();
  renderNav();
  renderTopbarActions();

  document.addEventListener("agos:lang", () => {
    renderNav();
    renderTopbarActions();
    if (state.route) show(state.route);
  });

  onRoute(show);
  // The sidebar is hidden on small screens and fonts change link heights;
  // re-place the highlight when either settles.
  window.addEventListener("resize", moveNavIndicator);
  document.fonts?.ready.then(moveNavIndicator);
  checkBackend();
  setInterval(checkBackend, 5 * 60 * 1000);
}

start();
