/*
 * AGOS formatting helpers (pure functions, unit-tested).
 * All displayed times use Philippine time (Asia/Manila).
 */

export const PH_TZ = "Asia/Manila";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Format a number or return the dash used for "not available". */
export function num(value, digits = 1) {
  if (!isNumber(value)) return "—";
  return value.toLocaleString("en-PH", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Number with unit, or "Not available" (never 0 for missing). */
export function withUnit(value, unit, digits = 1) {
  if (!isNumber(value)) return "Not available";
  return `${num(value, digits)} ${unit}`;
}

/**
 * Parse an API timestamp. Open-Meteo local times come without an offset
 * ("2026-09-07T10:00"); those are Philippine time, so +08:00 is added.
 */
export function parseTime(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value);
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(text);
  const isDateOnly = /^\d{4}-\d\d-\d\d$/.test(text);
  const iso = isDateOnly ? `${text}T00:00:00+08:00` : hasZone ? text : `${text}+08:00`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTime(value, { withDate = true } = {}) {
  const date = parseTime(value);
  if (!date) return "—";
  const options = { timeZone: PH_TZ, hour: "numeric", minute: "2-digit" };
  if (withDate) Object.assign(options, { month: "short", day: "numeric" });
  return date.toLocaleString("en-PH", options);
}

export function formatHour(value) {
  const date = parseTime(value);
  if (!date) return "—";
  return date.toLocaleString("en-PH", { timeZone: PH_TZ, hour: "numeric" });
}

export function formatDate(value) {
  const date = parseTime(value);
  if (!date) return "—";
  return date.toLocaleDateString("en-PH", { timeZone: PH_TZ, month: "short", day: "numeric", year: "numeric" });
}

/** "5 min ago", "3 h ago", "2 days ago"; future times say "in …". */
export function relativeTime(value, now = new Date()) {
  const date = parseTime(value);
  if (!date) return "unknown time";
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  const abs = Math.abs(seconds);
  let text;
  if (abs < 60) text = "just now";
  else if (abs < 3600) text = `${Math.round(abs / 60)} min`;
  else if (abs < 86400) text = `${Math.round(abs / 3600)} h`;
  else text = `${Math.round(abs / 86400)} day${Math.round(abs / 86400) === 1 ? "" : "s"}`;
  if (text === "just now") return text;
  return seconds >= 0 ? `${text} ago` : `in ${text}`;
}

/** Great-circle distance in km between two [lon, lat] points. */
export function distanceKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function slug(value) {
  return String(value || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
