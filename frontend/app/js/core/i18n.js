/*
 * AGOS interface text in English and Filipino.
 * Every key must exist in both languages (checked by tests/i18n.test.js).
 * Data values (municipality names, numbers, source names) are not translated.
 */

export const STRINGS = {
  en: {
    "app.name": "AGOS",
    "app.tagline": "Bataan flood monitoring",
    "app.disclaimer": "AGOS is a student research prototype. It is not an official PAGASA or NDRRMC warning service. Follow your LGU and PAGASA during emergencies.",
    "skip": "Skip to content",

    "nav.overview": "Overview",
    "nav.map": "Map",
    "nav.analytics": "Analytics",
    "nav.evacuate": "Evacuate",
    "nav.report": "Report",
    "nav.sources": "Sources & About",

    "title.overview": "Overview",
    "sub.overview": "Is my area safe right now?",
    "title.map": "Flood map",
    "sub.map": "Rain, hazard layers and municipalities",
    "title.municipality": "Municipality",
    "sub.municipality": "Everything AGOS knows about one town",
    "title.analytics": "Analytics",
    "sub.analytics": "History and forecast accuracy",
    "title.evacuate": "Evacuate",
    "sub.evacuate": "Find the nearest evacuation center",
    "title.report": "Report flooding",
    "sub.report": "Tell others what you see",
    "title.sources": "Sources & About",
    "sub.sources": "Where every number comes from",
    "title.notfound": "Page not found",

    "theme.toggle": "Switch light or dark theme",
    "lang.toggle": "Filipino",
    "lang.label": "Language",

    "status.checking": "Checking backend…",
    "status.online": "Backend online",
    "status.offline": "Backend offline",
    "status.offlineHelp": "Start the backend (uvicorn app.main:app) to load live data.",

    "common.loading": "Loading…",
    "common.notAvailable": "Not available",
    "common.retry": "Try again",
    "common.source": "Source",
    "common.updated": "Updated",
    "common.why": "Why this color?",
    "common.close": "Close",
    "common.openMap": "Open on map",
    "common.details": "Details",
    "common.unverified": "Unverified",
    "common.notOfficial": "Not an official warning",
    "common.seeAll": "See all",
    "common.municipality": "Municipality",
    "common.allMunicipalities": "All municipalities",
    "common.legacy": "Open the previous version",
    "common.comingSoon": "Coming soon",

    "placeholder.title": "This page is being redesigned",
    "placeholder.body": "The new version of this page arrives in a later update. The previous version still works.",

    "sources.intro": "AGOS combines public data sources. Each one has limits. This page lists them, shows how fresh the data is, and explains what AGOS does and does not claim.",
    "sources.live": "Live system status",
    "sources.list": "Data sources",
    "sources.method": "How AGOS works",
    "sources.limits": "What AGOS does not claim",
    "sources.what": "What it is",
    "sources.limitsLabel": "Limits",
    "sources.usedFor": "Used for",

    "map.aria": "Interactive flood map of Bataan",
    "map.noMapHint": "The map could not load, but rain levels are still listed on the Overview page.",
    "map.loading": "Loading the map…",
    "map.panel": "Map layers, legend and rain forecast",
    "map.panelShort": "Layers & rain",
    "map.search": "Search towns or centers",
    "map.locate": "Use my location",
    "map.rainForecast": "Rain forecast",
    "map.mode": "How to color the towns",
    "map.modePeak": "Next 24 h peak",
    "map.modeHour": "Hour by hour",
    "map.play": "Play forecast",
    "map.pause": "Pause",
    "map.hour": "Forecast hour",
    "map.peakLabel": "Each town shows its heaviest forecast hour in the next 24 hours.",
    "map.layers": "Layers",
    "map.basemap": "Basemap",
    "map.precipTime": "Tile hour",
    "map.summaryWarn": "{n} town(s) at yellow level or above",
    "map.reportsNoLocation": "Reports without GPS location are listed in town details only.",
    "map.locateUnsupported": "This browser cannot share your location.",
    "map.locateDenied": "Location was not shared. You can search for your town instead.",
    "map.nearestTown": "Nearest town point: {name} ({km} km).",
    "map.outsideBataan": "You seem to be outside Bataan.",
    "map.layer.rain": "Rain level by town",
    "map.layer.mgb": "Flood susceptibility (MGB)",
    "map.layer.precip": "Precipitation tiles",
    "map.layer.evacuation": "Evacuation centers",
    "map.layer.reports": "Community reports",
    "map.layer.boundaries": "Municipal boundaries",
    "map.swatch.center": "Listed evacuation center (unverified)",
    "map.swatch.report": "Community report (unverified)",
    "map.swatch.boundary": "Municipal outline (reference only)",
    "detail.rain": "Rain forecast",
    "detail.next24": "Next 24 hours",
    "detail.peakAt": "heaviest {mm} mm/h at {time}",
    "detail.total6": "Next 6 h",
    "detail.total24": "Next 24 h",
    "detail.total48": "Next 48 h",
    "detail.rainChart": "Hourly rain forecast for the next 48 hours",
    "detail.weather": "Current weather",
    "detail.temp": "Temperature",
    "detail.humidity": "Humidity",
    "detail.rainNow": "Rain now",
    "detail.wind": "Wind",
    "detail.modelNote": "model value at the town point",
    "detail.river": "River flow (modeled)",
    "detail.riverNoData": "GloFAS returned no discharge values for this point. This is missing data, not zero flow.",
    "detail.susceptibility": "Flood susceptibility",
    "detail.susceptibilityNA": "Municipality-level susceptibility is not computed yet. Turn on the MGB layer on the map to see mapped susceptibility.",
    "detail.centers": "Evacuation centers",
    "detail.noCenters": "No evacuation centers are listed for this area.",
    "detail.fromTownPoint": "from the town point",
    "detail.directions": "Directions",
    "detail.reports": "Community reports",
    "detail.noReports": "No community reports for this town yet.",
    "detail.openPage": "Open full town page",
    "detail.center": "Evacuation center",
    "detail.capacity": "Capacity",
    "detail.status": "Status",
    "detail.centerWarning": "Listed from public map data. Not confirmed open, available or safe. Check with your barangay or MDRRMO before going.",
    "detail.centerSource": "Source: AGOS list compiled from public Google Maps listings.",
    "detail.report": "Community report",
    "detail.severity": "Severity",
    "detail.depth": "Water depth",
    "detail.estimate": "reporter’s estimate",
    "detail.observed": "Observed",
    "detail.reportSource": "Submitted by a resident; not yet verified",
  },

  fil: {
    "app.name": "AGOS",
    "app.tagline": "Pagbabantay sa baha sa Bataan",
    "app.disclaimer": "Ang AGOS ay isang student research prototype. Hindi ito opisyal na babala ng PAGASA o NDRRMC. Sundin ang inyong LGU at PAGASA tuwing may emergency.",
    "skip": "Lumaktaw sa nilalaman",

    "nav.overview": "Buod",
    "nav.map": "Mapa",
    "nav.analytics": "Analytics",
    "nav.evacuate": "Lumikas",
    "nav.report": "Mag-ulat",
    "nav.sources": "Pinagmulan at Tungkol",

    "title.overview": "Buod",
    "sub.overview": "Ligtas ba ang lugar ko ngayon?",
    "title.map": "Mapa ng baha",
    "sub.map": "Ulan, hazard layers at mga bayan",
    "title.municipality": "Bayan",
    "sub.municipality": "Lahat ng alam ng AGOS tungkol sa isang bayan",
    "title.analytics": "Analytics",
    "sub.analytics": "Kasaysayan at katumpakan ng forecast",
    "title.evacuate": "Lumikas",
    "sub.evacuate": "Hanapin ang pinakamalapit na evacuation center",
    "title.report": "Mag-ulat ng baha",
    "sub.report": "Ibahagi ang nakikita mo",
    "title.sources": "Pinagmulan at Tungkol",
    "sub.sources": "Saan galing ang bawat numero",
    "title.notfound": "Hindi nahanap ang pahina",

    "theme.toggle": "Palitan ang light o dark theme",
    "lang.toggle": "English",
    "lang.label": "Wika",

    "status.checking": "Sinusuri ang backend…",
    "status.online": "Online ang backend",
    "status.offline": "Offline ang backend",
    "status.offlineHelp": "Patakbuhin ang backend (uvicorn app.main:app) para makakuha ng live na datos.",

    "common.loading": "Naglo-load…",
    "common.notAvailable": "Walang datos",
    "common.retry": "Subukan muli",
    "common.source": "Pinagmulan",
    "common.updated": "Na-update",
    "common.why": "Bakit ganito ang kulay?",
    "common.close": "Isara",
    "common.openMap": "Buksan sa mapa",
    "common.details": "Detalye",
    "common.unverified": "Hindi pa beripikado",
    "common.notOfficial": "Hindi opisyal na babala",
    "common.seeAll": "Tingnan lahat",
    "common.municipality": "Bayan",
    "common.allMunicipalities": "Lahat ng bayan",
    "common.legacy": "Buksan ang lumang bersyon",
    "common.comingSoon": "Malapit na",

    "placeholder.title": "Ginagawa pa ang bagong disenyo ng pahinang ito",
    "placeholder.body": "Darating ang bagong bersyon sa susunod na update. Gumagana pa rin ang lumang bersyon.",

    "sources.intro": "Pinagsasama ng AGOS ang mga pampublikong pinagmulan ng datos. May limitasyon ang bawat isa. Nakalista rito ang mga ito, kung gaano kasariwa ang datos, at kung ano ang sinasabi at hindi sinasabi ng AGOS.",
    "sources.live": "Kalagayan ng sistema",
    "sources.list": "Mga pinagmulan ng datos",
    "sources.method": "Paano gumagana ang AGOS",
    "sources.limits": "Ang hindi sinasabi ng AGOS",
    "sources.what": "Ano ito",
    "sources.limitsLabel": "Limitasyon",
    "sources.usedFor": "Ginagamit para sa",

    "map.aria": "Interactive na mapa ng baha sa Bataan",
    "map.noMapHint": "Hindi na-load ang mapa, pero makikita pa rin ang antas ng ulan sa pahinang Buod.",
    "map.loading": "Nilo-load ang mapa…",
    "map.panel": "Layers, legend at forecast ng ulan",
    "map.panelShort": "Layers at ulan",
    "map.search": "Maghanap ng bayan o center",
    "map.locate": "Gamitin ang lokasyon ko",
    "map.rainForecast": "Forecast ng ulan",
    "map.mode": "Paano kukulayan ang mga bayan",
    "map.modePeak": "Pinakamalakas sa 24 oras",
    "map.modeHour": "Bawat oras",
    "map.play": "I-play ang forecast",
    "map.pause": "I-pause",
    "map.hour": "Oras ng forecast",
    "map.peakLabel": "Ipinapakita ng bawat bayan ang pinakamalakas na oras ng ulan sa susunod na 24 oras.",
    "map.layers": "Layers",
    "map.basemap": "Basemap",
    "map.precipTime": "Oras ng tile",
    "map.summaryWarn": "{n} bayan ang nasa yellow level o mas mataas",
    "map.reportsNoLocation": "Ang mga ulat na walang GPS ay makikita lang sa detalye ng bayan.",
    "map.locateUnsupported": "Hindi kayang ibahagi ng browser na ito ang lokasyon mo.",
    "map.locateDenied": "Hindi naibahagi ang lokasyon. Maaari mong hanapin ang bayan mo.",
    "map.nearestTown": "Pinakamalapit na town point: {name} ({km} km).",
    "map.outsideBataan": "Mukhang nasa labas ka ng Bataan.",
    "map.layer.rain": "Antas ng ulan bawat bayan",
    "map.layer.mgb": "Flood susceptibility (MGB)",
    "map.layer.precip": "Precipitation tiles",
    "map.layer.evacuation": "Mga evacuation center",
    "map.layer.reports": "Mga ulat ng komunidad",
    "map.layer.boundaries": "Hangganan ng mga bayan",
    "map.swatch.center": "Nakalistang evacuation center (hindi beripikado)",
    "map.swatch.report": "Ulat ng komunidad (hindi beripikado)",
    "map.swatch.boundary": "Balangkas ng bayan (sanggunian lamang)",
    "detail.rain": "Forecast ng ulan",
    "detail.next24": "Susunod na 24 oras",
    "detail.peakAt": "pinakamalakas na {mm} mm/h sa {time}",
    "detail.total6": "Susunod na 6 oras",
    "detail.total24": "Susunod na 24 oras",
    "detail.total48": "Susunod na 48 oras",
    "detail.rainChart": "Forecast ng ulan bawat oras sa susunod na 48 oras",
    "detail.weather": "Kasalukuyang panahon",
    "detail.temp": "Temperatura",
    "detail.humidity": "Halumigmig",
    "detail.rainNow": "Ulan ngayon",
    "detail.wind": "Hangin",
    "detail.modelNote": "model value sa town point",
    "detail.river": "Daloy ng ilog (modeled)",
    "detail.riverNoData": "Walang discharge value mula sa GloFAS para sa puntong ito. Kulang ang datos; hindi ibig sabihin ay walang daloy.",
    "detail.susceptibility": "Flood susceptibility",
    "detail.susceptibilityNA": "Hindi pa kinakalkula ang susceptibility bawat bayan. Buksan ang MGB layer sa mapa para makita ang mapped susceptibility.",
    "detail.centers": "Mga evacuation center",
    "detail.noCenters": "Walang nakalistang evacuation center para sa lugar na ito.",
    "detail.fromTownPoint": "mula sa town point",
    "detail.directions": "Direksyon",
    "detail.reports": "Mga ulat ng komunidad",
    "detail.noReports": "Wala pang ulat ng komunidad para sa bayang ito.",
    "detail.openPage": "Buksan ang buong pahina ng bayan",
    "detail.center": "Evacuation center",
    "detail.capacity": "Kapasidad",
    "detail.status": "Katayuan",
    "detail.centerWarning": "Mula sa pampublikong map data. Hindi kumpirmadong bukas, may espasyo o ligtas. Magtanong muna sa barangay o MDRRMO bago pumunta.",
    "detail.centerSource": "Pinagmulan: listahan ng AGOS mula sa pampublikong Google Maps listings.",
    "detail.report": "Ulat ng komunidad",
    "detail.severity": "Tindi",
    "detail.depth": "Lalim ng tubig",
    "detail.estimate": "tantiya ng nag-ulat",
    "detail.observed": "Nakita noong",
    "detail.reportSource": "Isinumite ng residente; hindi pa beripikado",
  },
};

export const LANGS = ["en", "fil"];
const STORAGE_KEY = "agos.lang";
let current = "en";

function readStored() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function initLang() {
  const stored = readStored();
  current = LANGS.includes(stored) ? stored : "en";
  if (globalThis.document) document.documentElement.lang = current === "fil" ? "fil" : "en";
  return current;
}

export function getLang() {
  return current;
}

export function setLang(lang) {
  if (!LANGS.includes(lang)) return;
  current = lang;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage can be blocked; the choice still applies to this visit */
  }
  if (globalThis.document) {
    document.documentElement.lang = lang === "fil" ? "fil" : "en";
    document.dispatchEvent(new CustomEvent("agos:lang", { detail: { lang } }));
  }
}

/** Translate a key; {name} placeholders are filled from vars. Falls back to English, then the key. */
export function t(key, vars = {}, lang = current) {
  const text = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? `{${name}}`));
}
