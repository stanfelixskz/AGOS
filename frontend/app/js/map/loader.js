/*
 * Load MapLibre GL JS once. Prefers the vendored copy in frontend/vendor/;
 * falls back to the same pinned version on unpkg if the vendored files are
 * missing (run frontend/tools/vendor_maplibre.py to vendor them).
 */

const VERSION = "5.6.2";
const SOURCES = [
  { js: "vendor/maplibre-gl/maplibre-gl.js", css: "vendor/maplibre-gl/maplibre-gl.css", label: "vendored" },
  { js: `https://unpkg.com/maplibre-gl@${VERSION}/dist/maplibre-gl.js`, css: `https://unpkg.com/maplibre-gl@${VERSION}/dist/maplibre-gl.css`, label: "unpkg (fallback)" },
];

let promise = null;
export let loadedFrom = null;

function addScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = resolve;
    el.onerror = () => {
      el.remove();
      reject(new Error(`Could not load ${src}`));
    };
    document.head.append(el);
  });
}

function addStyle(href) {
  if (document.querySelector(`link[data-maplibre="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.maplibre = href;
  document.head.append(link);
}

export function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (promise) return promise;
  promise = (async () => {
    const errors = [];
    for (const source of SOURCES) {
      try {
        await addScript(source.js);
        if (window.maplibregl) {
          addStyle(source.css);
          loadedFrom = source.label;
          return window.maplibregl;
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
    promise = null;
    throw new Error(`The map library could not be loaded (${errors.join("; ")}). Check your internet connection or vendor MapLibre (see frontend/vendor/README.md).`);
  })();
  return promise;
}
