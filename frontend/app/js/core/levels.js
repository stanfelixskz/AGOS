/*
 * PAGASA-equivalent rain levels (AGOS rule on model forecasts).
 * Thresholds must match backend/app/services/overview_service.py
 * (tests/levels.test.js checks this). Colors match the map markers.
 */

export const THRESHOLDS = { lightRain: 1, yellow: 7.5, orange: 15, redAbove: 30 };

export const LEVELS = {
  nodata: { color: "#94a3b8", rank: 0, en: "No data", fil: "Walang datos", range: "Forecast not available" },
  little: { color: "#93c5fd", rank: 1, en: "Little or no rain", fil: "Halos walang ulan", range: "Under 1 mm/h" },
  rain: { color: "#38bdf8", rank: 2, en: "Rain", fil: "Umuulan", range: "1 to under 7.5 mm/h" },
  yellow: { color: "#facc15", rank: 3, en: "Yellow level", fil: "Yellow level", range: "7.5 to under 15 mm/h" },
  orange: { color: "#fb923c", rank: 4, en: "Orange level", fil: "Orange level", range: "15 to 30 mm/h" },
  red: { color: "#ef4444", rank: 5, en: "Red level", fil: "Red level", range: "Over 30 mm/h" },
};

export const LEVEL_IDS = ["red", "orange", "yellow", "rain", "little", "nodata"];

export function levelFor(mmPerHour) {
  if (typeof mmPerHour !== "number" || !Number.isFinite(mmPerHour)) return "nodata";
  if (mmPerHour > THRESHOLDS.redAbove) return "red";
  if (mmPerHour >= THRESHOLDS.orange) return "orange";
  if (mmPerHour >= THRESHOLDS.yellow) return "yellow";
  if (mmPerHour >= THRESHOLDS.lightRain) return "rain";
  return "little";
}

export function levelLabel(level, lang = "en") {
  const entry = LEVELS[level] || LEVELS.nodata;
  return lang === "fil" ? entry.fil : entry.en;
}

export function levelColor(level) {
  return (LEVELS[level] || LEVELS.nodata).color;
}

/** True for the three PAGASA-equivalent warning colors. */
export function isWarningLevel(level) {
  return level === "yellow" || level === "orange" || level === "red";
}
