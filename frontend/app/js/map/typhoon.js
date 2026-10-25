/*
 * Typhoon symbol for the map: an illustration in the style of enhanced
 * infrared satellite imagery (SVG), the wind-extent circle as GeoJSON, and
 * the pixel size for a radius at a zoom.
 *
 * The colors and shape are illustrative, not satellite data. How strong the
 * storm looks follows its stated strength (PAGASA intensity scale); its size
 * on the map follows the stated wind extent only.
 */

const EARTH_RADIUS_KM = 6371.0088;
const EARTH_CIRCUMFERENCE_M = 40075016.686;

/* PAGASA tropical cyclone intensity scale (maximum sustained winds, km/h). */
export const INTENSITY = [
  { id: "td", minKmh: 0, maxKmh: 61 },
  { id: "ts", minKmh: 62, maxKmh: 88 },
  { id: "sts", minKmh: 89, maxKmh: 117 },
  { id: "ty", minKmh: 118, maxKmh: 184 },
  { id: "sty", minKmh: 185, maxKmh: null },
];

// On-screen size (px) when the article gives no wind extent: shows strength, not area.
const UNSCALED_PX = [58, 74, 92, 114, 138];

/**
 * Strength level 0-4 from the stated maximum winds, else from the stated
 * category name. null when the article gives neither.
 */
export function intensityLevel(typhoon) {
  const kmh = typhoon?.max_wind_kmh?.value;
  if (Number.isFinite(kmh)) {
    for (let i = INTENSITY.length - 1; i >= 0; i--) if (kmh >= INTENSITY[i].minKmh) return i;
  }
  const category = String(typhoon?.storm?.category || "").toLowerCase();
  if (category.startsWith("super typhoon")) return 4;
  if (category.startsWith("typhoon")) return 3;
  if (category.startsWith("severe tropical storm")) return 2;
  if (category.startsWith("tropical storm")) return 1;
  if (category.startsWith("tropical depression")) return 0;
  return null;
}

export function unscaledSize(level) {
  return UNSCALED_PX[level ?? 2];
}

/** Point at a distance (km) and bearing (deg) from [lon, lat], great circle. */
export function destination([lon, lat], bearingDeg, distanceKm) {
  const d = distanceKm / EARTH_RADIUS_KM;
  const b = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [((l2 * 180) / Math.PI + 540) % 360 - 180, (p2 * 180) / Math.PI];
}

/** GeoJSON polygon of a circle with a radius in km. */
export function circlePolygon(center, radiusKm, steps = 96) {
  const ring = [];
  for (let i = 0; i <= steps; i++) ring.push(destination(center, (i / steps) * 360, radiusKm));
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { radius_km: radiusKm } };
}

/** Screen pixels covered by a distance at a latitude and MapLibre zoom (512 px tiles). */
export function kmToPixels(km, lat, zoom) {
  const metersPerPixel = (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
  return (km * 1000) / metersPerPixel;
}

function polar(r, angle) {
  return `${(r * Math.cos(angle)).toFixed(2)},${(r * Math.sin(angle)).toFixed(2)}`;
}

const R_OUT = 97;

/* One spiral rain band from the core out to rEnd. The band follows the same
   spiral whatever rEnd and width are, so stacked copies line up. In screen
   coordinates (y down) a growing angle turns clockwise: the bands trail
   clockwise outward and the storm spins counter-clockwise (northern hemisphere). */
function band(offset, { r0, rEnd, turns, width, share }, steps = 64) {
  const left = [];
  const right = [];
  const span = R_OUT - r0;
  for (let i = 0; i <= steps; i++) {
    const r = r0 + (rEnd - r0) * (i / steps);
    const u = (r - r0) / span; // 0 at the core, 1 at the outer edge of the storm
    const v = i / steps; // taper toward this copy's own end
    // Full band width at this radius; each color layer takes a centered share of it.
    const full = width * (1 - 0.5 * u);
    const w = full * share * Math.sin(Math.PI * Math.min(1, 0.5 + v * 0.5)) ** 0.5 + 0.03;
    const center = offset + turns * 2 * Math.PI * u ** 1.1 + full / 2;
    left.push(polar(r, center - w / 2));
    right.push(polar(r * 0.95, center + w / 2));
  }
  return `M${left.join("L")}L${right.reverse().join("L")}Z`;
}

/* Infrared-style layers, coldest (innermost) last. Each layer is a thinner,
   shorter copy of the same bands, so the colors follow the cloud shape. */
const IR_LAYERS = [
  { color: "#9aa3ad", opacity: 0.7, reach: 1.0, width: 1.0, core: 1.0 },
  { color: "#1d46ff", opacity: 1, reach: 0.84, width: 0.86, core: 0.9 },
  { color: "#27c8ff", opacity: 1, reach: 0.72, width: 0.74, core: 0.8 },
  { color: "#36d34a", opacity: 1, reach: 0.6, width: 0.62, core: 0.7 },
  { color: "#ffe100", opacity: 1, reach: 0.49, width: 0.5, core: 0.6 },
  { color: "#ff8a00", opacity: 1, reach: 0.38, width: 0.4, core: 0.5 },
  { color: "#ff2200", opacity: 1, reach: 0.28, width: 0.3, core: 0.4 },
];

const SHAPE = [
  // td, ts, sts, ty, sty: color layers (stronger = colder core), core size, spiral, eye
  { layers: 4, cdo: 24, bands: 3, turns: 0.6, width: 1.7, eye: 0, rough: 13 },
  { layers: 5, cdo: 32, bands: 3, turns: 0.7, width: 1.8, eye: 0, rough: 12 },
  { layers: 6, cdo: 40, bands: 3, turns: 0.8, width: 1.9, eye: 0, rough: 11 },
  { layers: 7, cdo: 50, bands: 3, turns: 0.85, width: 1.9, eye: 6, rough: 10 },
  { layers: 7, cdo: 58, bands: 3, turns: 0.9, width: 2.0, eye: 7.5, rough: 9 },
];

function svgWrap(defs, body) {
  return `<svg viewBox="-100 -100 200 200" width="100%" height="100%" aria-hidden="true" focusable="false"><defs>${defs}</defs>${body}</svg>`;
}

/* Rough, softly blended cloud edges: noise displacement, then a blur so the
   color bands melt into each other instead of ending in hard lines. */
function cloudFilter(id, { rough, blur, seed }) {
  return `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="4" seed="${seed}" result="noise"/>
    <feDisplacementMap in="SourceGraphic" in2="noise" scale="${rough}" xChannelSelector="R" yChannelSelector="G" result="rough"/>
    <feGaussianBlur in="rough" stdDeviation="${blur}"/>
  </filter>`;
}

const layerCache = new Map();

/**
 * The storm illustration as separate layers (each an SVG, viewBox -100..100),
 * so the page can turn them at different speeds:
 *   haze  – wispy outer cloud shield (slowest)
 *   ghost – a soft, pale copy of the rain bands (drifts against the bands)
 *   bands – the colored spiral rain bands
 *   core  – the round central cloud mass and eye (fastest)
 * Built once per strength level 0-4.
 */
export function typhoonLayers(level = 2) {
  const lv = Math.max(0, Math.min(4, level ?? 2));
  if (layerCache.has(lv)) return layerCache.get(lv);
  const s = SHAPE[lv];
  const r0 = s.cdo * 0.5;
  const used = IR_LAYERS.slice(0, s.layers);
  const id = `ty${lv}`;
  const bandPaths = (layer) => Array.from({ length: s.bands }, (_, k) =>
    `<path d="${band((k * 2 * Math.PI) / s.bands, { r0, rEnd: r0 + (R_OUT - r0) * layer.reach, turns: s.turns, width: s.width, share: layer.width })}"/>`).join("");

  const haze = svgWrap(
    `<radialGradient id="${id}-hz-g"><stop offset="0" stop-color="#dfe5ec" stop-opacity=".55"/><stop offset=".6" stop-color="#c3ccd6" stop-opacity=".28"/><stop offset="1" stop-color="#c3ccd6" stop-opacity="0"/></radialGradient>
     <filter id="${id}-hz" x="0" y="0" width="100%" height="100%">
       <feTurbulence type="fractalNoise" baseFrequency="0.028" numOctaves="4" seed="${3 + lv}"/>
       <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.9 -0.62"/>
       <feComposite in2="SourceGraphic" operator="in"/>
     </filter>`,
    `<circle r="99" fill="url(#${id}-hz-g)" filter="url(#${id}-hz)"/>`,
  );

  const ghost = svgWrap(
    cloudFilter(`${id}-gh`, { rough: s.rough * 1.4, blur: 3.2, seed: 21 + lv }),
    `<g filter="url(#${id}-gh)" fill="#e6ebf1" fill-opacity=".5">${bandPaths(IR_LAYERS[0])}</g>`,
  );

  const bands = svgWrap(
    cloudFilter(`${id}-bd`, { rough: s.rough, blur: 1.3, seed: 11 + lv }),
    `<g filter="url(#${id}-bd)">${used.map((layer) =>
      `<g fill="${layer.color}" fill-opacity="${layer.opacity}">${bandPaths(layer)}</g>`).join("")}</g>`,
  );

  // Central cloud mass: one soft gradient of the warm (cold-cloud) colors that
  // fades out at its edge, so it melts into the roots of the bands.
  const warm = used.slice(3).reverse();
  const plateau = 0.06 * (warm.length - 1); // stronger storms keep a solid cold (red) center
  const coreStops = `<stop offset="0" stop-color="${warm[0].color}"/>`
    + warm.map((layer, i) =>
      `<stop offset="${(plateau + (i / warm.length) * (0.72 - plateau)).toFixed(3)}" stop-color="${layer.color}"/>`).join("")
    + `<stop offset="1" stop-color="${warm[warm.length - 1].color}" stop-opacity="0"/>`;
  const eye = s.eye
    ? `<circle r="${(s.eye * 1.9).toFixed(1)}" fill="url(#${id}-eye)"/>`
    : "";
  const core = svgWrap(
    `${cloudFilter(`${id}-cr`, { rough: s.rough * 0.8, blur: 1.4, seed: 31 + lv })}
     <radialGradient id="${id}-cg">${coreStops}</radialGradient>
     <radialGradient id="${id}-eye"><stop offset="0" stop-color="#1f242b"/><stop offset=".5" stop-color="#2b2f36" stop-opacity=".95"/><stop offset="1" stop-color="#2b2f36" stop-opacity="0"/></radialGradient>`,
    `<circle r="${(s.cdo * 1.2).toFixed(1)}" fill="url(#${id}-cg)" filter="url(#${id}-cr)"/>${eye}`,
  );

  const parts = { haze, ghost, bands, core };
  layerCache.set(lv, parts);
  return parts;
}

/** All layers stacked in one SVG-like string (used for previews and tests). */
export function typhoonSVG(level = 2) {
  const { haze, ghost, bands, core } = typhoonLayers(level);
  return [haze, ghost, bands, core].join("");
}
