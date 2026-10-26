/*
 * Flood-risk indicator (DRAFT rules, computed by the backend in
 * flood_risk_service.py): colors, and the text shown on the map hover card
 * and in the town drawer. Every reason names its value, window and source.
 */

import { t } from "./i18n.js";
import { num, isNumber } from "./format.js";

export const RISK_LEVELS = {
  low: { color: "#4ade80" },
  moderate: { color: "#facc15" },
  high: { color: "#f97316" },
  very_high: { color: "#b91c1c" },
  nodata: { color: "#94a3b8" },
};
export const RISK_IDS = ["low", "moderate", "high", "very_high"];

export function riskColor(level) {
  return (RISK_LEVELS[level] || RISK_LEVELS.nodata).color;
}

/** One reason line for a scored input, e.g. "Forecast 24 h: 120 mm (+2)". */
export function factorText(factor) {
  const label = t(`risk.f.${factor.id}`);
  if (!isNumber(factor.value)) return t("risk.missingValue", { label });
  let value;
  if (factor.id === "peak_24h") value = `${num(factor.value, 1)} mm/h (${t(`risk.peak.${factor.level}`)})`;
  else if (factor.id === "soil") value = `${num(factor.value, 2)} m³/m³`;
  else if (factor.id === "discharge") value = t("risk.dischargeValue", { ratio: num(factor.value, 1), now: num(factor.forecast_max, 1), median: num(factor.median_30d, 1) });
  else if (factor.id === "tide") value = t("risk.tideValue", { peak: num(factor.value, 2), p90: num(factor.p90_30d, 2) });
  else if (factor.unit === "share") value = t("risk.shareValue", { pct: Math.round(factor.value * 100) });
  else value = `${num(factor.value, 1)} mm`;
  // Static layers held back on a dry day: say what they would add.
  const held = factor.held_back ? ` ${t("risk.heldBack", { n: factor.held_back })}` : "";
  return `${label}: ${value}${factor.points ? ` (+${factor.points})` : ""}${held}`;
}

export function stormText(storm) {
  if (!storm) return "";
  const where = storm.inside_radius
    ? t("risk.stormInside", { name: storm.name || t("typhoon.unnamed"), km: storm.distance_km, radius: num(storm.radius_km, 0) })
    : isNumber(storm.radius_km)
      ? t("risk.stormOutside", { name: storm.name || t("typhoon.unnamed"), km: storm.distance_km, radius: num(storm.radius_km, 0) })
      : t("risk.stormNoRadius", { name: storm.name || t("typhoon.unnamed"), km: storm.distance_km });
  return where;
}

/**
 * Hover-card rows for the map engine. Reasons: inputs that scored, highest
 * first; if none scored, the two main rain values so the card still explains
 * why the level is low.
 */
export function riskRows(data, { timeText = "" } = {}) {
  return (data?.municipalities || []).map((town) => {
    const scored = town.factors.filter((f) => f.points > 0).sort((a, b) => b.points - a.points);
    const shown = scored.length
      ? scored
      : town.factors.filter((f) => f.id === "total_24h" || f.id === "past_72h");
    const lines = shown.slice(0, 4).map(factorText);
    if (town.storm) lines.push(stormText(town.storm));
    if (town.level === "nodata") lines.unshift(t("risk.noForecast"));
    return {
      name: town.municipality,
      level: town.level,
      color: riskColor(town.level),
      title: `${t(`risk.level.${town.level}`)}${isNumber(town.score) ? ` · ${t("risk.points", { n: town.score })}` : ""}`,
      lines,
      foot: t("risk.foot", { time: timeText }),
    };
  });
}

/** Query string for /api/flood-risk with an optional storm (needs a position). */
export function riskQuery(storm) {
  if (!storm?.position) return "/api/flood-risk";
  const params = new URLSearchParams({ storm_lat: storm.position.latitude, storm_lon: storm.position.longitude });
  if (isNumber(storm.radius_km?.value)) params.set("storm_radius_km", storm.radius_km.value);
  if (isNumber(storm.strength)) params.set("storm_strength", storm.strength);
  if (storm.storm?.name) params.set("storm_name", storm.storm.name.slice(0, 60));
  return `/api/flood-risk?${params}`;
}
