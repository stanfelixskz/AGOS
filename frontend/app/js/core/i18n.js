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
