/*
 * Hash router. Routes look like:
 *   #/overview
 *   #/map?m=Balanga
 *   #/municipality/Balanga
 * Pure parsing is unit-tested; the browser part listens to hashchange.
 */

export const ROUTES = ["overview", "map", "municipality", "analytics", "evacuate", "report", "sources"];
export const DEFAULT_ROUTE = "overview";

export function parseHash(hash) {
  const raw = String(hash || "").replace(/^#\/?/, "");
  const [pathPart, queryPart = ""] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const query = Object.fromEntries(new URLSearchParams(queryPart));
  const view = segments[0] || DEFAULT_ROUTE;
  return {
    view: ROUTES.includes(view) ? view : "notfound",
    requested: view,
    params: segments.slice(1),
    query,
  };
}

export function buildHash(view, params = [], query = {}) {
  const path = [view, ...params.map((p) => encodeURIComponent(p))].join("/");
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  return `#/${path}${qs ? `?${qs}` : ""}`;
}

export function navigate(view, params = [], query = {}) {
  const next = buildHash(view, params, query);
  if (globalThis.location.hash === next) {
    globalThis.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    globalThis.location.hash = next;
  }
}

export function onRoute(handler) {
  const run = () => handler(parseHash(globalThis.location.hash));
  globalThis.addEventListener("hashchange", run);
  run();
}
