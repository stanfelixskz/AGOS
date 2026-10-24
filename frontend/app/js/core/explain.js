/* "Why this color?" explanations. Each one names its source and limits. */

import { openDialog } from "./ui.js";
import { escapeHTML } from "./format.js";
import { LEVELS, LEVEL_IDS } from "./levels.js";
import { getLang } from "./i18n.js";

function swatchList(rows) {
  return `<ul class="list">${rows
    .map(([color, label, note]) => `<li class="row" style="gap:10px"><span class="dot" style="background:${color};width:14px;height:14px"></span><span><strong>${escapeHTML(label)}</strong>${note ? ` <span class="subtle">· ${escapeHTML(note)}</span>` : ""}</span></li>`)
    .join("")}</ul>`;
}

function sourceLink(label, href) {
  return `<p class="subtle">Details: <a href="#/sources?s=${escapeHTML(href)}">${escapeHTML(label)}</a></p>`;
}

export const EXPLAIN = {
  rainLevels() {
    const lang = getLang();
    return openDialog("Rain level colors", `
      <p>Each circle shows the <strong>heaviest forecast hour</strong> for that municipality (Open-Meteo model forecast at one reference point).</p>
      ${swatchList(LEVEL_IDS.map((id) => [LEVELS[id].color, lang === "fil" ? LEVELS[id].fil : LEVELS[id].en, LEVELS[id].range]))}
      <p><strong>Yellow, orange and red</strong> use PAGASA's Heavy Rainfall Warning intensity criteria (7.5, 15 and 30 mm per hour). AGOS applies them to a model forecast, so they are <strong>PAGASA-equivalent levels, not official PAGASA warnings</strong>. The thresholds come from news explainers of PAGASA criteria and have not been confirmed on a PAGASA page.</p>
      <p>The two blue colors are AGOS display bands, not PAGASA categories.</p>
      ${sourceLink("PAGASA-equivalent levels", "pagasa-levels")}`);
  },
  mgb() {
    return openDialog("Flood susceptibility (MGB)", `
      <p>Mapped flood susceptibility from the DENR–Mines and Geosciences Bureau. Darker means more susceptible.</p>
      ${swatchList([["#002673", "Very high"], ["#5900ff", "High"], ["#b045ff", "Moderate"], ["#e3d1ff", "Low"]])}
      <p>This is a long-term hazard map. It does not change with the weather and does not mean an area is flooded now.</p>
      ${sourceLink("DENR–MGB", "mgb")}`);
  },
  precipitation() {
    return openDialog("Precipitation tiles", `
      <p>Hourly precipitation tiles from WeatherAPI.com, drawn in the provider's own color scale. AGOS does not recolor them, so there is no numeric key.</p>
      <p>Rain on these tiles is not a flood observation.</p>
      ${sourceLink("WeatherAPI.com", "weatherapi-tiles")}`);
  },
  evacuation() {
    return openDialog("Evacuation centers", `
      ${swatchList([["#16a34a", "Listed evacuation center"]])}
      <p>Green only marks a location from public map listings. It does <strong>not</strong> mean the center is open, has space or is safe. Capacity and status are unverified; confirm with your barangay or MDRRMO.</p>
      ${sourceLink("Evacuation list", "evacuation-centers")}`);
  },
  boundaries() {
    return openDialog("Municipal boundaries", `
      <p>Outlines of the 12 municipalities of Bataan from the AGOS boundary file. The faint fill only separates towns; it does not mean water.</p>
      <p>Not an official survey boundary. If the boundary file is not on this computer, the layer says so instead of drawing anything.</p>`);
  },
  reports() {
    return openDialog("Community reports", `
      ${swatchList([["#7c3aed", "Community report (unverified)"]])}
      <p>Reports submitted by residents. They are unverified until reviewed, and the depth is the reporter's estimate.</p>
      ${sourceLink("Community reports", "community-reports")}`);
  },
  discharge() {
    return openDialog("River discharge", `
      <p>Daily simulated river discharge (m³/s) from GloFAS through the Open-Meteo Flood API, for the river grid cell near the municipality point.</p>
      <p>It is a model, not an observed river level, and the grid cell may not be the river you expect. Discharge alone does not confirm flooding.</p>
      ${sourceLink("GloFAS", "glofas")}`);
  },
};
