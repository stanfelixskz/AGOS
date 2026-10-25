/*
 * Typhoon symbol for the map: a spiral cloud illustration (SVG), the
 * wind-extent circle as GeoJSON, and the pixel size for a radius at a zoom.
 * The spiral's shape is illustrative; only its size follows the article.
 */

const EARTH_RADIUS_KM = 6371.0088;
const EARTH_CIRCUMFERENCE_M = 40075016.686;

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

/* One spiral band: two edges at the same radius, offset in angle, tapered at
   both ends. In screen coordinates (y down) a growing angle turns clockwise,
   so the arms trail clockwise outward and the whole storm spins
   counter-clockwise (northern hemisphere). */
function arm(offset, turns = 1.35, steps = 48) {
  const outer = [];
  const inner = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = 9 + 89 * t ** 0.85;
    const angle = offset + turns * 2 * Math.PI * t;
    const width = 0.95 * Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.7 + 0.05;
    outer.push(polar(r, angle));
    inner.push(polar(r * 0.94, angle + width));
  }
  return `M${outer.join("L")}L${inner.reverse().join("L")}Z`;
}

let svgCache = null;

/** The spiral illustration (viewBox -100..100). Static, so it is built once. */
export function typhoonSVG() {
  if (svgCache) return svgCache;
  const arms = [0, 1, 2, 3].map((k) => `<path d="${arm((k * Math.PI) / 2)}" fill="url(#ty-band)"/>`).join("");
  svgCache = `<svg viewBox="-100 -100 200 200" width="100%" height="100%" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id="ty-glow"><stop offset="0" stop-color="#ffffff" stop-opacity=".55"/><stop offset=".55" stop-color="#dbe6f5" stop-opacity=".22"/><stop offset="1" stop-color="#dbe6f5" stop-opacity="0"/></radialGradient>
      <radialGradient id="ty-band"><stop offset=".08" stop-color="#ffffff" stop-opacity=".98"/><stop offset=".6" stop-color="#eef3fa" stop-opacity=".78"/><stop offset="1" stop-color="#c9d7ea" stop-opacity=".05"/></radialGradient>
    </defs>
    <circle r="98" fill="url(#ty-glow)"/>
    ${arms}
    <circle r="15" fill="#ffffff" fill-opacity=".9"/>
    <circle r="6.5" fill="#1e293b" fill-opacity=".78"/>
  </svg>`;
  return svgCache;
}
