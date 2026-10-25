/* "Why this color?" explanations in English and Filipino. Each one names its source and limits. */

import { openDialog } from "./ui.js";
import { escapeHTML } from "./format.js";
import { LEVELS, LEVEL_IDS, levelRange } from "./levels.js";
import { getLang, t } from "./i18n.js";

function swatchList(rows) {
  return `<ul class="list">${rows
    .map(([color, label, note]) => `<li class="row" style="gap:10px"><span class="dot" style="background:${color};width:14px;height:14px"></span><span><strong>${escapeHTML(label)}</strong>${note ? ` <span class="subtle">· ${escapeHTML(note)}</span>` : ""}</span></li>`)
    .join("")}</ul>`;
}

function sourceLink(label, id) {
  return `<p class="subtle">${escapeHTML(t("explain.details"))}: <a href="#/sources?s=${escapeHTML(id)}">${escapeHTML(label)}</a></p>`;
}

const mgbRows = () => [["#002673", t("mgb.veryHigh")], ["#5900ff", t("mgb.high")], ["#b045ff", t("mgb.moderate")], ["#e3d1ff", t("mgb.low")]];

const TEXT = {
  rainLevels: {
    en: () => ({
      title: "Rain level colors",
      body: `
        <p>Each circle shows the <strong>heaviest forecast hour</strong> for that municipality (Open-Meteo model forecast at one reference point).</p>
        ${swatchList(LEVEL_IDS.map((id) => [LEVELS[id].color, LEVELS[id].en, levelRange(id, "en")]))}
        <p><strong>Yellow, orange and red</strong> use PAGASA's Heavy Rainfall Warning intensity criteria (7.5, 15 and 30 mm per hour). AGOS applies them to a model forecast, so they are <strong>PAGASA-equivalent levels, not official PAGASA warnings</strong>. The thresholds come from news explainers of PAGASA criteria and have not been confirmed on a PAGASA page.</p>
        <p>The two blue colors are AGOS display bands, not PAGASA categories.</p>
        ${sourceLink("PAGASA-equivalent levels", "pagasa-levels")}`,
    }),
    fil: () => ({
      title: "Kulay ng antas ng ulan",
      body: `
        <p>Ipinapakita ng bawat bilog ang <strong>pinakamalakas na oras ng ulan sa forecast</strong> para sa bayan (Open-Meteo model forecast sa isang reference point).</p>
        ${swatchList(LEVEL_IDS.map((id) => [LEVELS[id].color, LEVELS[id].fil, levelRange(id, "fil")]))}
        <p>Ang <strong>yellow, orange at red</strong> ay batay sa intensity criteria ng PAGASA Heavy Rainfall Warning (7.5, 15 at 30 mm bawat oras). Inilalapat ito ng AGOS sa model forecast, kaya ito ay <strong>PAGASA-equivalent level, hindi opisyal na babala ng PAGASA</strong>. Ang mga threshold ay mula sa mga news explainer tungkol sa PAGASA criteria at hindi pa nakukumpirma sa pahina ng PAGASA.</p>
        <p>Ang dalawang asul na kulay ay display band ng AGOS, hindi kategorya ng PAGASA.</p>
        ${sourceLink("PAGASA-equivalent levels", "pagasa-levels")}`,
    }),
  },
  rainAnim: {
    en: () => ({
      title: "Rain animation",
      body: `<p>Moving streaks inside each town show how hard the <strong>model forecast</strong> says it is raining in the hour shown: more and faster streaks mean heavier rain. Below 0.1 mm per hour there are no streaks.</p>
        <p>In "Next 24 h peak" mode the animation shows the <strong>current hour</strong>, not the peak. In "Hour by hour" mode it follows the slider.</p>
        <p>The streaks fall at a fixed slant. AGOS has no wind direction data, so the slant does not show wind. It is Open-Meteo model output, not radar or a rain gauge reading.</p>
        ${sourceLink("Open-Meteo forecast", "open-meteo-forecast")}`,
    }),
    fil: () => ({
      title: "Animasyon ng ulan",
      body: `<p>Ipinapakita ng mga gumagalaw na guhit sa loob ng bawat bayan kung gaano kalakas ang ulan ayon sa <strong>model forecast</strong> sa oras na ipinapakita: mas marami at mas mabilis na guhit, mas malakas ang ulan. Kapag mababa sa 0.1 mm bawat oras, walang guhit.</p>
        <p>Sa "Pinakamalakas sa 24 oras" ipinapakita nito ang <strong>kasalukuyang oras</strong>, hindi ang peak. Sa "Bawat oras" sumusunod ito sa slider.</p>
        <p>Pirmi ang hilig ng pagbagsak ng mga guhit. Walang datos ng direksyon ng hangin ang AGOS, kaya hindi ito nagpapakita ng hangin. Output ito ng Open-Meteo model, hindi radar o sukat ng rain gauge.</p>
        ${sourceLink("Open-Meteo forecast", "open-meteo-forecast")}`,
    }),
  },
  mgb: {
    en: () => ({
      title: "Flood susceptibility (MGB)",
      body: `<p>Mapped flood susceptibility from the DENR–Mines and Geosciences Bureau. Darker means more susceptible.</p>
        ${swatchList(mgbRows())}
        <p>This is a long-term hazard map. It does not change with the weather and does not mean an area is flooded now.</p>
        ${sourceLink("DENR–MGB", "mgb")}`,
    }),
    fil: () => ({
      title: "Pagiging bahain ng lugar (MGB)",
      body: `<p>Mapa ng flood susceptibility mula sa DENR–Mines and Geosciences Bureau. Mas madilim, mas madaling bahain.</p>
        ${swatchList(mgbRows())}
        <p>Pangmatagalang hazard map ito. Hindi ito nagbabago ayon sa panahon at hindi ibig sabihin na binabaha ang lugar ngayon.</p>
        ${sourceLink("DENR–MGB", "mgb")}`,
    }),
  },
  precipitation: {
    en: () => ({
      title: "Precipitation tiles",
      body: `<p>Hourly precipitation tiles from WeatherAPI.com, drawn in the provider's own color scale. AGOS does not recolor them, so there is no numeric key.</p>
        <p>Rain on these tiles is not a flood observation.</p>
        ${sourceLink("WeatherAPI.com", "weatherapi-tiles")}`,
    }),
    fil: () => ({
      title: "Mga tile ng ulan",
      body: `<p>Mga tile ng ulan bawat oras mula sa WeatherAPI.com, sa sariling kulay ng provider. Hindi ito kinukulayan muli ng AGOS, kaya walang numerong susi.</p>
        <p>Ang ulan sa mga tile ay hindi obserbasyon ng baha.</p>
        ${sourceLink("WeatherAPI.com", "weatherapi-tiles")}`,
    }),
  },
  evacuation: {
    en: () => ({
      title: "Evacuation centers",
      body: `${swatchList([["#16a34a", "Listed evacuation center"]])}
        <p>Green only marks a location from public map listings. It does <strong>not</strong> mean the center is open, has space or is safe. Capacity and status are unverified; confirm with your barangay or MDRRMO.</p>
        ${sourceLink("Evacuation list", "evacuation-centers")}`,
    }),
    fil: () => ({
      title: "Mga evacuation center",
      body: `${swatchList([["#16a34a", "Nakalistang evacuation center"]])}
        <p>Lokasyon lang mula sa pampublikong map listing ang ibig sabihin ng berde. <strong>Hindi</strong> ito nangangahulugang bukas, may espasyo o ligtas ang center. Hindi beripikado ang kapasidad at katayuan; kumpirmahin sa inyong barangay o MDRRMO.</p>
        ${sourceLink("Listahan ng evacuation center", "evacuation-centers")}`,
    }),
  },
  boundaries: {
    en: () => ({
      title: "Municipal boundaries",
      body: `<p>Outlines of the 12 municipalities of Bataan (PSA PSGC codes, 31 December 2023). The faint fill only separates towns; it does not mean water.</p>
        <p>Simplified for display and not an official survey boundary.</p>
        ${sourceLink("Municipal boundaries (PSGC 2023)", "boundaries")}`,
    }),
    fil: () => ({
      title: "Hangganan ng mga bayan",
      body: `<p>Balangkas ng 12 bayan ng Bataan (PSGC code ng PSA, 31 Disyembre 2023). Panghiwalay lang ng bayan ang mapusyaw na kulay; hindi ito tubig.</p>
        <p>Pinasimple para sa display at hindi opisyal na survey boundary.</p>
        ${sourceLink("Hangganan ng mga bayan (PSGC 2023)", "boundaries")}`,
    }),
  },
  reports: {
    en: () => ({
      title: "Community reports",
      body: `${swatchList([["#7c3aed", "Community report (unverified)"]])}
        <p>Reports submitted by residents. They are unverified until reviewed, and the depth is the reporter's estimate.</p>
        ${sourceLink("Community reports", "community-reports")}`,
    }),
    fil: () => ({
      title: "Mga ulat ng komunidad",
      body: `${swatchList([["#7c3aed", "Ulat ng komunidad (hindi beripikado)"]])}
        <p>Mga ulat mula sa mga residente. Hindi beripikado hangga't hindi nasusuri, at tantiya ng nag-ulat ang lalim.</p>
        ${sourceLink("Mga ulat ng komunidad", "community-reports")}`,
    }),
  },
  discharge: {
    en: () => ({
      title: "River discharge",
      body: `<p>Daily simulated river discharge (m³/s) from GloFAS through the Open-Meteo Flood API, for the river grid cell near the municipality point.</p>
        <p>It is a model, not an observed river level, and the grid cell may not be the river you expect. Discharge alone does not confirm flooding.</p>
        ${sourceLink("GloFAS", "glofas")}`,
    }),
    fil: () => ({
      title: "Daloy ng ilog",
      body: `<p>Simulated na daloy ng ilog bawat araw (m³/s) mula sa GloFAS sa pamamagitan ng Open-Meteo Flood API, para sa river grid cell na malapit sa town point.</p>
        <p>Model ito, hindi nasukat na taas ng ilog, at maaaring hindi ito ang ilog na inaasahan mo. Hindi sapat ang daloy lang para kumpirmahin ang baha.</p>
        ${sourceLink("GloFAS", "glofas")}`,
    }),
  },
};

export function explain(id) {
  const entry = TEXT[id];
  if (!entry) return null;
  const { title, body } = (entry[getLang()] || entry.en)();
  return openDialog(title, body);
}

/** Backwards-compatible map: EXPLAIN.rainLevels() etc. */
export const EXPLAIN = Object.fromEntries(Object.keys(TEXT).map((id) => [id, () => explain(id)]));

export const EXPLAIN_IDS = Object.keys(TEXT);
export const EXPLAIN_TEXT = TEXT;
