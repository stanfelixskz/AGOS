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
  rivers: {
    en: () => ({
      title: "Rivers (OpenStreetMap)",
      body: `<p>Lines for the rivers, streams and canals that volunteers have mapped in OpenStreetMap. Thicker lines are rivers; thinner lines are streams and canals.</p>
        <p><strong>Context only.</strong> Rivers are not part of the warning sign. The map does not show water level, flow or flood depth, and it does not show which rivers are rising.</p>
        <p>OpenStreetMap is mapped by volunteers, so it may be incomplete: about 1 in 10 lines has a name, and a river that exists may be missing. Lines are simplified to about 30 m. Dikes and drainage are not shown because AGOS found no public dataset.</p>
        <p>© OpenStreetMap contributors, Open Database Licence (ODbL).</p>
        ${sourceLink("OpenStreetMap waterways", "rivers")}`,
    }),
    fil: () => ({
      title: "Mga ilog (OpenStreetMap)",
      body: `<p>Mga linya ng ilog, sapa at kanal na minapa ng mga boluntaryo sa OpenStreetMap. Ang mas makapal na linya ay ilog; ang mas manipis ay sapa at kanal.</p>
        <p><strong>Konteksto lamang.</strong> Hindi bahagi ng babalang tanda ang mga ilog. Hindi ipinapakita ng mapa ang taas ng tubig, daloy o lalim ng baha, at hindi nito sinasabi kung aling ilog ang tumataas.</p>
        <p>Minapa ng mga boluntaryo ang OpenStreetMap kaya maaaring kulang: mga 1 sa 10 linya ang may pangalan, at maaaring wala sa mapa ang isang umiiral na ilog. Pinasimple ang mga linya sa mga 30 m. Hindi ipinapakita ang dike at drainage dahil walang nahanap na pampublikong datos ang AGOS.</p>
        <p>© mga contributor ng OpenStreetMap, Open Database Licence (ODbL).</p>
        ${sourceLink("OpenStreetMap waterways", "rivers")}`,
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
  factors: {
    en: () => ({
      title: "Flood factors",
      body: `
    <p>AGOS puts side by side what it can measure for the town: <strong>rain</strong> (the tested warning sign), <strong>wet ground</strong> (rain over the last 14 days), <strong>flood-prone ground</strong> (the official DENR–MGB map) and <strong>listed past floods</strong>.</p>
    <p>"Rain is raised" comes only from the <strong>rain warning sign</strong>: the 3-day rain is in the top 5% of the town's own record. No weights or probabilities were invented. When rain is raised, the flood-prone ground in the town <em>could</em> flood; depth and extent are not shown.</p>
    <p><strong>Wet ground</strong> is context only. It has not been tested on past floods yet, so it is not part of the sign.</p>
    <p><strong>Chance, next 3 days</strong> compares today with past days that had equally unusual incoming rain (top 10% of the town's record). Wet ground (rain in the previous 14 days) and the share of the town the official DENR–MGB map rates high or very high for flooding were the only extra factors that improved the test on held-out years; spring tide and storm did not. Past days are ranked by that score and grouped; the chance shown is what actually happened in today's group: how often a listed flood hit the town within 3 days. It is low confidence: only about 109 past town floods, small floods are missing from the list (so the true rate is higher) and the rain is modeled. Not a forecast and not an official warning.</p>
    <p><strong>Past frequency</strong> counts how often spells of unusual rain (some town's 3-day rain in its top 5%) ended in a listed flood since 2011, for the sign's level or higher, with a 95% range. It is a count of the past across all of Bataan, not a forecast and not the chance for today. The flood list misses small floods, so the true rate is higher, and confidence is never "high". Storm distance and spring tide were tested on the same floods and did not help, so they are left out.</p>
    <p><strong>Rivers</strong> (named OpenStreetMap waterways and their mapped length) are shown for context only and are not part of the sign.</p>
    <p><strong>Spring tide</strong> is worked out from the moon (new and full moon give the biggest tide range), not from a tide gauge. It is context only: on the 28 dated floods in the list the link is weak and could be chance, so it is not part of the sign. When unusual rain and a spring tide fall in the same days, a separate precaution line is shown.</p>
    <p><strong>Not included:</strong> tide height and high-tide hours (no gauge or official table yet), storms (AGOS has no live storm feed) and dikes and drainage.</p>
    <p>Rain is Open-Meteo model forecast, not a rain gauge. This is not an official warning and not a flood probability. Follow PAGASA and your MDRRMO.</p>
        ${sourceLink("DENR–MGB flood susceptibility", "mgb")}`,
    }),
    fil: () => ({
      title: "Mga salik ng baha",
      body: `
    <p>Pinagsasama ng AGOS dito ang mga bagay na kaya nitong sukatin para sa bayan: <strong>ulan</strong> (ang tinestang babalang tanda), <strong>basang lupa</strong> (ulan sa nakaraang 14 araw), <strong>lupang madaling bahain</strong> (opisyal na mapa ng DENR–MGB) at <strong>mga nakalistang nakaraang baha</strong>.</p>
    <p>Ang "Mataas ang ulan" ay galing lang sa <strong>babalang tanda mula sa ulan</strong>: kung ang 3-araw na ulan ay nasa nangungunang 5% ng sariling talaan ng bayan. Walang ginawang timbang o porsiyento ng posibilidad. Kapag mataas ang ulan, ang lupang madaling bahain sa bayan ang <em>maaaring</em> bahain; hindi ipinapakita ang lalim o lawak.</p>
    <p>Ang <strong>basang lupa</strong> ay konteksto lamang. Hindi pa ito nasusubok sa mga nakaraang baha, kaya hindi ito bahagi ng tanda.</p>
    <p>Ikinukumpara ng <strong>tsansa, susunod na 3 araw</strong> ang ngayon sa mga nakaraang araw na kasing-di-karaniwan ang paparating na ulan (nangungunang 10% ng talaan ng bayan). Ang basang lupa (ulan sa nakaraang 14 araw) at ang bahagi ng bayan na mataas o napakataas ang panganib ng baha ayon sa opisyal na mapa ng DENR–MGB ang tanging dagdag na salik na nagpabuti sa pagsubok sa mga taong hindi ginamit sa pagbuo; hindi nakatulong ang spring tide at bagyo. Inuuri ang mga nakaraang araw ayon sa markang iyon at pinagsasama-sama; ang ipinapakita ay ang aktuwal na nangyari sa grupo ngayon: gaano kadalas tinamaan ng nakalistang baha ang bayan sa loob ng 3 araw. Mababa ang kumpiyansa: humigit-kumulang 109 lamang na nakaraang baha sa mga bayan, kulang ang listahan sa maliliit na baha (kaya mas mataas ang totoong bilang) at kinuwenta ang ulan. Hindi hula at hindi opisyal na babala.</p>
    <p>Binibilang ng <strong>dalas sa nakaraan</strong> kung gaano kadalas nauwi sa nakalistang baha ang mga yugto ng di-karaniwang ulan (3-araw na ulan ng alinmang bayan sa nangungunang 5%) mula 2011, para sa antas ng tanda o mas mataas, kasama ang 95% saklaw. Bilang ito ng nakaraan sa buong Bataan, hindi hula at hindi ang tsansa para sa araw na ito. Kulang sa maliliit na baha ang listahan, kaya mas mataas ang totoong bilang, at hindi kailanman "mataas" ang kumpiyansa. Sinubukan sa parehong mga baha ang layo ng bagyo at spring tide at hindi nakatulong, kaya hindi kasama.</p>
    <p>Ang mga <strong>ilog</strong> (mga waterway ng OpenStreetMap na may pangalan at haba sa mapa) ay konteksto lamang at hindi bahagi ng tanda.</p>
    <p><strong>Spring tide</strong> ay kinuwenta mula sa buwan (ang bagong buwan at kabilugan ng buwan ang may pinakamalaking agwat ng tide), hindi mula sa tide gauge. Konteksto lamang: sa 28 na may petsang baha sa listahan, mahina ang ugnayan at maaaring nagkataon lang, kaya hindi ito bahagi ng tanda. Kapag magkasabay ang di-karaniwang ulan at spring tide, may hiwalay na linya ng pag-iingat.</p>
    <p><strong>Hindi kasama:</strong> taas ng tide at oras ng high tide (wala pang gauge o opisyal na talaan), bagyo (walang live na datos ng bagyo ang AGOS), at dike at drainage.</p>
    <p>Ang ulan ay galing sa Open-Meteo model forecast, hindi rain gauge. Hindi ito opisyal na babala at hindi ito posibilidad ng baha. Sundin ang PAGASA at ang inyong MDRRMO.</p>
        ${sourceLink("DENR–MGB flood susceptibility", "mgb")}`,
    }),
  },
  outlook: {
    en: () => ({
      title: "Flood outlook",
      body: `
    <p>This layer shows the <strong>DENR–MGB flood-prone ground</strong> at full strength only in towns where <strong>rain is raised</strong> (warning sign Watch or higher). Other towns and everything outside Bataan are faded.</p>
    <p><strong>Replay</strong> uses recorded rain (ERA5) as if it had been the forecast. It shows what the rule would say with the rain that actually fell, not what the forecast said then. Floods listed around that day are shown beside it so the two can be compared.</p>
    <p>It shows where flooding is <strong>possible</strong>, not depth or extent. It is not an official warning and not a flood probability.</p>`,
    }),
    fil: () => ({
      title: "Tanaw sa baha",
      body: `
    <p>Ipinapakita ng layer na ito ang <strong>lupang madaling bahain ayon sa DENR–MGB</strong> nang buong kulay lamang sa mga bayang <strong>mataas ang ulan</strong> (babalang tanda: Bantayan o mas mataas). Naka-fade ang ibang bayan at ang labas ng Bataan.</p>
    <p>Ang <strong>Replay</strong> ay gumagamit ng ulang naitala (ERA5) na parang ito ang forecast. Ipinapakita nito kung ano ang sasabihin ng patakaran sa ulang talagang bumagsak, hindi ang sinabi ng forecast noon. Katabi nito ang mga bahang nakalista sa paligid ng araw na iyon para maikumpara.</p>
    <p>Ipinapakita nito kung saan <strong>posibleng</strong> bahain, hindi ang lalim o lawak. Hindi ito opisyal na babala at hindi posibilidad ng baha.</p>`,
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
