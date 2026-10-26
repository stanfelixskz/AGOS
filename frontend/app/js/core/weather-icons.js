/*
 * Colored weather icons (sun, moon, clouds, rain, thunder, fog) in the style
 * of weather apps. Drawn for AGOS; the condition comes from the backend
 * (consensus_service.condition), never from an API icon.
 */

import { t } from "./i18n.js";

export const CONDITIONS = ["clear", "partly_cloudy", "mostly_cloudy", "overcast", "fog", "light_rain", "rain", "heavy_rain", "thunder", "unknown"];

const SUN = (cx, cy, r) => {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const x1 = cx + Math.cos(a) * (r + 4), y1 = cy + Math.sin(a) * (r + 4);
    const x2 = cx + Math.cos(a) * (r + 9), y2 = cy + Math.sin(a) * (r + 9);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  }).join("");
  return `<g class="wx-sun"><g stroke="#F59E0B" stroke-width="3" stroke-linecap="round">${rays}</g><circle cx="${cx}" cy="${cy}" r="${r}" fill="#FBBF24"/></g>`;
};

/* Crescent: a disc with an offset disc masked out. Each icon gets its own mask id. */
let maskId = 0;
const MOON = (cx, cy, r) => {
  const id = `wx-moon-${++maskId}`;
  return `<mask id="${id}"><rect width="64" height="64" fill="#fff"/><circle cx="${cx + r * 0.55}" cy="${cy - r * 0.4}" r="${r * 0.85}" fill="#000"/></mask>
    <circle class="wx-moon" cx="${cx}" cy="${cy}" r="${r}" fill="#FCD34D" mask="url(#${id})"/>`;
};

const CLOUD_PATH = "M20 48H46A9 9 0 0 0 47 30A13 13 0 0 0 22.5 26.5A10.5 10.5 0 0 0 20 48Z";
const CLOUD = (x = 0, y = 0, s = 1, tone = "light") => {
  const fill = { light: "#F1F5F9", grey: "#CBD5E1", dark: "#94A3B8" }[tone];
  const stroke = { light: "#94A3B8", grey: "#94A3B8", dark: "#64748B" }[tone];
  return `<path d="${CLOUD_PATH}" fill="${fill}" stroke="${stroke}" stroke-width="${(2 / s).toFixed(2)}" stroke-linejoin="round" transform="translate(${x} ${y}) scale(${s})"/>`;
};

const DROPS = (xs, y = 52, len = 7, width = 3) =>
  `<g stroke="#3B82F6" stroke-width="${width}" stroke-linecap="round">${xs.map((x) => `<line x1="${x}" y1="${y}" x2="${x - 3}" y2="${y + len}"/>`).join("")}</g>`;

const BOLT = `<path d="M34 47L26 57H32L29 63L39 52H33L36 47Z" fill="#F59E0B" stroke="#B45309" stroke-width="1" stroke-linejoin="round"/>`;
const FOG = `<g stroke="#94A3B8" stroke-width="3" stroke-linecap="round"><line x1="14" y1="52" x2="46" y2="52"/><line x1="20" y1="58" x2="52" y2="58"/></g>`;

const celestial = (isDay, cx, cy, r) => (isDay ? SUN(cx, cy, r) : MOON(cx, cy, r));

const DRAW = {
  clear: (d) => (d ? SUN(32, 32, 12) : MOON(32, 32, 16)),
  partly_cloudy: (d) => celestial(d, 24, 22, d ? 9 : 11) + CLOUD(6, 6, 1),
  mostly_cloudy: (d) => celestial(d, 20, 18, d ? 7 : 9) + CLOUD(-6, -4, 0.85, "grey") + CLOUD(4, 4, 1),
  overcast: () => CLOUD(-8, -6, 0.9, "dark") + CLOUD(2, 2, 1, "grey"),
  fog: () => CLOUD(-2, -8, 1, "grey") + FOG,
  light_rain: (d) => celestial(d, 20, 16, d ? 7 : 9) + CLOUD(0, -4, 1) + DROPS([28, 40], 50),
  rain: () => CLOUD(0, -6, 1, "grey") + DROPS([24, 34, 44], 48),
  heavy_rain: () => CLOUD(0, -8, 1, "dark") + DROPS([20, 28, 36, 44, 52], 46, 10, 3.2),
  thunder: () => CLOUD(0, -8, 1, "dark") + BOLT + DROPS([22, 46], 46),
  unknown: () => `<path d="${CLOUD_PATH}" fill="none" stroke="#94A3B8" stroke-width="2" stroke-dasharray="4 3"/>`,
};

/** SVG string for a condition id. isDay picks sun or moon where it matters. */
export function weatherIcon(condition, isDay = true, size = 32) {
  const draw = DRAW[condition] || DRAW.unknown;
  const label = conditionLabel(condition, isDay);
  return `<svg class="wx-icon" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${label.replace(/"/g, "&quot;")}"><title>${label}</title>${draw(isDay !== false)}</svg>`;
}

/** "Clear" / "Clear night", "Light rain", ... in the current language. */
export function conditionLabel(condition, isDay = true) {
  const key = CONDITIONS.includes(condition) ? condition : "unknown";
  if (isDay === false && (key === "clear" || key === "partly_cloudy")) return t(`wx.${key}.night`);
  return t(`wx.${key}`);
}
