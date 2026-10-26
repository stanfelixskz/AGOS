/* "Why this color?" explanations in English and Filipino. Each one names its source and limits. */

import { openDialog } from "./ui.js";
import { escapeHTML } from "./format.js";
import { LEVELS, LEVEL_IDS, levelRange } from "./levels.js";
import { getLang, t } from "./i18n.js";
import { RISK_IDS, riskColor } from "./risk.js";

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
  animPlanned: {
    en: () => ({
      title: "Weather animation: what is planned",
      body: `<p>Each kind of weather gets its own checkbox. <strong>Rain</strong> works now.</p>
        <p><strong>Wind</strong> and <strong>clouds and sun</strong> are greyed out on purpose. To draw them honestly AGOS first has to collect the data from the forecast: wind direction for wind, cloud cover and sunshine for clouds and sun. Today it stores wind speed, not direction, and no cloud or sun data. Until then AGOS shows nothing rather than a made-up picture.</p>`,
    }),
    fil: () => ({
      title: "Animasyon ng panahon: ano ang binabalak",
      body: `<p>May sariling checkbox ang bawat uri ng panahon. Gumagana na ang <strong>Ulan</strong>.</p>
        <p>Sadyang naka-grey ang <strong>hangin</strong> at <strong>ulap at araw</strong>. Para matapat na maiguhit ang mga ito, kailangan munang kolektahin ng AGOS ang datos mula sa forecast: direksyon ng hangin para sa hangin, cloud cover at sikat ng araw para sa ulap at araw. Sa ngayon, bilis ng hangin lang ang iniimbak, hindi direksyon, at walang datos ng ulap o araw. Hanggang doon, wala munang ipapakita ang AGOS kaysa sa gawa-gawang larawan.</p>`,
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
  floodRisk: {
    en: () => ({
      title: "Flood-risk indicator (draft)",
      body: `<p>An AGOS <strong>screening indicator</strong> per municipality. It is <strong>not a flood forecast</strong>: the rules are a draft for review, and they have not been checked against past floods.</p>
        ${swatchList(RISK_IDS.map((id) => [riskColor(id), t(`risk.level.${id}`, {}, "en")]))}
        <p><strong>Weather points</strong> (Open-Meteo, at each town's reference point): heaviest forecast hour in the next 24 h (yellow +2, orange +3, red +4); heaviest 3 hours (≥30 mm +1, ≥60 +2); forecast rain in the next 24 h (≥50 mm +1, ≥100 +2, ≥200 +3) and 72 h (≥150 mm +1, ≥300 +2); rain in the past 72 h (≥50 mm +1, ≥100 +2); soil moisture 0–10 cm (≥0.40 m³/m³ +1); GloFAS river flow over the next 3 days against its 30-day median (≥1.5× +1, ≥3× +2); and, for coastal towns, a next-24 h modeled sea-level peak at or above the 90th percentile of the past 30 days' daily highs, i.e. one of the highest-tide days of the month (+1; tides only, no storm surge).</p>
        <p><strong>Place points</strong>, which only count when the weather already gives at least 2 points, so a flood-prone town is not shown at risk on a dry day: share of the town that is low ground, meaning ≤5 m above sea level, or ≤10 m within 300 m of a mapped waterway (≥12% +1, ≥22% +2; Copernicus 90 m elevation and OpenStreetMap waterways on 1 km cells); share rated High or Very High on the DENR–MGB flood susceptibility map (≥25% +1, ≥50% +2; sample points about 2 km apart).</p>
        <p>Total: 0–2 low, 3–5 moderate, 6–8 high, 9 or more very high.</p>
        <p><strong>Storm from an article:</strong> a town inside the storm's <em>stated</em> wind radius goes up one level. The storm's rain is already in the Open-Meteo forecast, so it is not counted again. An old article's storm is not today's weather; AGOS only uses it when you tick the box.</p>
        <p>Missing data is shown as missing, never as zero.</p>
        ${sourceLink("AGOS flood-risk indicator", "agos-flood-risk")}`,
    }),
    fil: () => ({
      title: "Flood-risk indicator (draft)",
      body: `<p>Isang <strong>screening indicator</strong> ng AGOS bawat bayan. <strong>Hindi ito forecast ng baha</strong>: draft pa ang mga patakaran para suriin, at hindi pa ito naikukumpara sa mga nakaraang baha.</p>
        ${swatchList(RISK_IDS.map((id) => [riskColor(id), t(`risk.level.${id}`, {}, "fil")]))}
        <p><strong>Puntos mula sa panahon</strong> (Open-Meteo, sa reference point ng bawat bayan): pinakamalakas na oras ng forecast sa susunod na 24 oras (yellow +2, orange +3, red +4); pinakamalakas na 3 oras (≥30 mm +1, ≥60 +2); forecast na ulan sa susunod na 24 oras (≥50 mm +1, ≥100 +2, ≥200 +3) at 72 oras (≥150 mm +1, ≥300 +2); ulan sa nakaraang 72 oras (≥50 mm +1, ≥100 +2); soil moisture 0–10 cm (≥0.40 m³/m³ +1); daloy ng ilog ng GloFAS sa susunod na 3 araw kumpara sa 30-araw na median (≥1.5× +1, ≥3× +2); at, para sa mga bayan sa baybayin, pinakamataas na modeled na taas ng dagat sa susunod na 24 oras na abot o lampas sa 90th percentile ng araw-araw na high tide sa nakaraang 30 araw, ibig sabihin isa sa pinakamataas na tide ng buwan (+1; tides lang, walang storm surge).</p>
        <p><strong>Puntos mula sa lugar</strong>, na binibilang lang kapag may hindi bababa sa 2 puntos mula sa panahon, para hindi lumabas na delikado ang bayang bahain sa araw na tuyo: bahagi ng bayan na mababang lupa, ibig sabihin ≤5 m mula sa dagat, o ≤10 m at nasa loob ng 300 m mula sa ilog o sapa (≥12% +1, ≥22% +2; Copernicus 90 m elevation at mga ilog ng OpenStreetMap sa 1 km na cells); bahagi na High o Very High sa flood susceptibility map ng DENR–MGB (≥25% +1, ≥50% +2; mga sample point na mga 2 km ang pagitan).</p>
        <p>Kabuuan: 0–2 mababa, 3–5 katamtaman, 6–8 mataas, 9 pataas napakataas.</p>
        <p><strong>Bagyo mula sa artikulo:</strong> tumataas ng isang antas ang bayang nasa loob ng <em>nakasulat</em> na radius ng hangin ng bagyo. Kasama na sa forecast ng Open-Meteo ang ulan ng bagyo, kaya hindi na ito binibilang ulit. Hindi panahon ngayon ang bagyo mula sa lumang artikulo; ginagamit lang ito ng AGOS kapag na-tsek mo ang kahon.</p>
        <p>Ipinapakitang walang datos ang nawawalang datos, hindi zero.</p>
        ${sourceLink("AGOS flood-risk indicator", "agos-flood-risk")}`,
    }),
  },
  typhoon: {
    en: () => ({
      title: "Typhoon from an article",
      body: `<p>Paste a link to a news article or a PAGASA bulletin. AGOS reads the page text and picks out only what it states: name, category, position, winds, movement and size.</p>
        <p><strong>Position</strong>, most precise first: (1) coordinates written in the article; (2) a distance and direction from a named place, in km or nautical miles (“320 km East of Virac”, “120 km silangan ng Virac”); (3) a place the storm is over or made landfall at (“over the coastal waters of Morong”, “made landfall in Casiguran”), shown as <em>approximate</em>; (4) a direction with no distance (“east of Aurora”), shown only as an arrow from that place, with no storm symbol. Places are located with the Open-Meteo geocoder. Sentences about where a storm <em>may</em> go (“may make landfall over…”) are not used. If none of these is written, nothing is drawn.</p>
        ${swatchList([["#dc2626", "Dashed circle", "wind-extent radius stated in the article"]])}
        <p>The <strong>storm symbol</strong> imitates enhanced infrared satellite images (red where cloud tops are coldest), but it is an illustration, <strong>not satellite data</strong>. It turns counter-clockwise like storms north of the equator.</p>
        <p><strong>How strong it looks</strong> follows the stated maximum winds on the PAGASA scale: Tropical Depression (up to 61 km/h), Tropical Storm (62–88), Severe Tropical Storm (89–117), Typhoon (118–184), Super Typhoon (185 or more). Stronger storms get a redder core, and typhoons an eye.</p>
        <p><strong>Its size on the map</strong> is the stated wind extent. Wind speed does not tell how wide a storm is, so AGOS does not estimate an area from it: without a stated extent the symbol has a fixed screen size by strength and is not to scale. The small arrow shows the stated direction of movement, not a forecast track.</p>
        <p>All of this is <strong>unverified and may be outdated</strong>. Follow PAGASA bulletins and your LGU.</p>
        ${sourceLink("Typhoon details from an article link", "typhoon-article")}`,
    }),
    fil: () => ({
      title: "Bagyo mula sa artikulo",
      body: `<p>Idikit ang link ng balita o PAGASA bulletin. Babasahin ng AGOS ang teksto ng pahina at kukunin lang ang nakasulat: pangalan, kategorya, lokasyon, hangin, galaw at laki.</p>
        <p>Ang <strong>lokasyon</strong>, mula sa pinakaeksakto: (1) coordinates na nakasulat sa artikulo; (2) layo at direksyon mula sa isang lugar, sa km o nautical miles (“320 km East of Virac”, “120 km silangan ng Virac”); (3) lugar na kinaroroonan o binagsakan ng bagyo (“over the coastal waters of Morong”, “nag-landfall sa Casiguran”), na ipinapakitang <em>tantiya</em>; (4) direksyon na walang layo (“east of Aurora”), na arrow lang mula sa lugar na iyon ang ipinapakita, walang simbolo ng bagyo. Hinahanap ang mga lugar gamit ang Open-Meteo geocoder. Hindi ginagamit ang mga pangungusap tungkol sa kung saan <em>maaaring</em> pumunta ang bagyo (“may make landfall over…”). Kung wala ang alinman, walang iguguhit.</p>
        ${swatchList([["#dc2626", "Putol-putol na bilog", "radius ng lawak ng hangin na nakasulat sa artikulo"]])}
        <p>Ginagaya ng <strong>simbolo ng bagyo</strong> ang enhanced infrared na satellite image (pula kung saan pinakamalamig ang tuktok ng ulap), pero paglalarawan lang ito, <strong>hindi satellite data</strong>. Umiikot ito pakaliwa gaya ng mga bagyo sa hilaga ng ekwador.</p>
        <p><strong>Ang hitsura ng lakas</strong> ay batay sa nakasulat na pinakamalakas na hangin ayon sa sukatan ng PAGASA: Tropical Depression (hanggang 61 km/h), Tropical Storm (62–88), Severe Tropical Storm (89–117), Typhoon (118–184), Super Typhoon (185 pataas). Mas pula ang gitna ng mas malalakas na bagyo, at may mata ang typhoon.</p>
        <p><strong>Ang laki nito sa mapa</strong> ay ang nakasulat na lawak ng hangin. Hindi sinasabi ng bilis ng hangin kung gaano kalapad ang bagyo, kaya hindi tinatantiya ng AGOS ang lawak mula rito: kung walang nakasulat na lawak, nakapirmi ang laki ng simbolo sa screen ayon sa lakas at hindi ito ayon sa sukat. Ang maliit na arrow ay ang nakasulat na direksyon ng galaw, hindi forecast track.</p>
        <p>Lahat ng ito ay <strong>hindi beripikado at maaaring luma na</strong>. Sundin ang PAGASA bulletin at ang inyong LGU.</p>
        ${sourceLink("Typhoon details from an article link", "typhoon-article")}`,
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
