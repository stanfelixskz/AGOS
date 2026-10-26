/*
 * Labels for AGOS's own forecast numbers (backend consensus_service.py):
 * the median of six weather models, with the lowest-highest model range
 * and a chance of rain computed as the share of models forecasting rain.
 */

import { t } from "./i18n.js";
import { num, isNumber } from "./format.js";

/** Source label for a forecast block: AGOS consensus, or the single-model fallback. */
export function methodLabel(method, models = 6) {
  return method === "consensus" ? t("cons.source", { n: models || 6 }) : t("cons.fallback");
}

/** "models 0.0–0.5 mm" (null when there is no range, e.g. on the fallback). */
export function rangeText(low, high, unit = "", digits = 1) {
  if (!isNumber(low) || !isNumber(high)) return null;
  return t("cons.range", { low: num(low, digits), high: num(high, digits), unit });
}
