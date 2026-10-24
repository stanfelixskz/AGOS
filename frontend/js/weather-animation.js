/*
 * AGOS — Open-Meteo Weather Markers
 * Complete replacement for frontend/js/weather-animation.js
 *
 * Twelve independent weather markers for Bataan. Each marker has its own
 * weather request, weather graphic, animation, error state, and
 * 15-minute refresh cycle. Graphics are display-only: no popup, no click
 * action, and no municipality camera/selection behavior.
 */
(() => {
    "use strict";

    const CONFIG = {
        // Backend address comes from js/config.js.
        endpoint: `${window.AGOS_CONFIG ? window.AGOS_CONFIG.apiBase : "http://127.0.0.1:8000"}/weather`,
        refreshInterval: 15 * 60 * 1000,
        requestTimeout: 15000,
        defaultMunicipality: "Balanga",
    };

    // Keep these coordinates aligned with frontend/js/map.js.
    const MUNICIPALITIES = {
        Abucay: [120.5348, 14.7213],
        Bagac: [120.3922, 14.5967],
        Balanga: [120.5409, 14.6795],
        Dinalupihan: [120.4631, 14.8663],
        Hermosa: [120.5075, 14.8312],
        Limay: [120.5949, 14.5625],
        Mariveles: [120.4903, 14.4356],
        Morong: [120.2652, 14.6779],
        Orani: [120.5367, 14.8007],
        Orion: [120.5802, 14.6198],
        Pilar: [120.5528, 14.6669],
        Samal: [120.5421, 14.7693]
    };
    const NAMES = Object.keys(MUNICIPALITIES);

    const state = {
        map: null,
        markers: new Map(),
        weather: new Map(),
        updated: new Map(),
        errors: new Map(),
        controllers: new Map(),
        inFlight: new Set(),
        timer: null,
        retryTimer: null,
        running: false,
        stylesAdded: false,
        selected: CONFIG.defaultMunicipality
    };

    const $ = id => document.getElementById(id);
    const selectedSelector = () => $("agos-municipality-select") || $("municipalitySelect");

    function normalizeName(value) {
        const clean = String(value || "").trim().replace(/\s+/g, " ");
        return NAMES.find(name => name.toLowerCase() === clean.toLowerCase()) || clean;
    }

    function selectedName() {
        const selector = selectedSelector();
        const name = selector && selector.value ? normalizeName(selector.value) : CONFIG.defaultMunicipality;
        return MUNICIPALITIES[name] ? name : CONFIG.defaultMunicipality;
    }

    function status(message) {
        for (const id of ["weatherStatus", "weather-status", "weatherConnectionStatus"]) {
            const node = $(id);
            if (node) { node.textContent = message; return; }
        }
        console.info("[AGOS Weather]", message);
    }

    function esc(value) {
        return String(value ?? "").replace(/[&<>"']/g, char => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
        })[char]);
    }

    function num(value) {
        if (value === undefined || value === null || value === "") return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function first(...values) {
        return values.find(value => value !== undefined && value !== null && value !== "");
    }

    function temp(value) { return value == null ? "—°C" : `${Math.round(value)}°C`; }

    function updatedText(date) {
        return date ? date.toLocaleString("en-PH", {
            timeZone: "Asia/Manila", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit", hour12: true
        }) : "Not available";
    }

    function presentation(weather) {
        const code = weather.code;
        const wet = (weather.precipitation || 0) > 0 || (weather.rain || 0) > 0 || (weather.showers || 0) > 0;
        const day = weather.isDay !== 0;
        if (code === null) return wet
            ? { icon: "🌧️", label: "Rain", animation: "rain" }
            : { icon: "🌡️", label: "Weather unavailable", animation: "none" };
        if (code === 0) return day
            ? { icon: "☀️", label: "Clear sky", animation: "sun" }
            : { icon: "🌙", label: "Clear night", animation: "night" };
        if (code === 1) return day
            ? { icon: "🌤️", label: "Mainly clear", animation: "sun" }
            : { icon: "🌙", label: "Mostly clear night", animation: "night" };
        if (code === 2) return { icon: day ? "⛅" : "☁️", label: "Partly cloudy", animation: "cloud" };
        if (code === 3) return { icon: "☁️", label: "Overcast", animation: "cloud" };
        if (code === 45 || code === 48) return { icon: "🌫️", label: "Fog", animation: "fog" };
        if (code >= 51 && code <= 57) return { icon: "🌦️", label: "Drizzle", animation: "rain" };
        if (code >= 61 && code <= 67) return { icon: "🌧️", label: "Rain", animation: "rain" };
        if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: "🌨️", label: "Snow", animation: "snow" };
        if (code >= 80 && code <= 82) return { icon: "🌦️", label: "Rain showers", animation: "rain" };
        if (code >= 95 && code <= 99) return { icon: "⛈️", label: "Thunderstorm", animation: "storm" };
        return wet ? { icon: "🌧️", label: "Precipitation", animation: "rain" }
            : { icon: "🌡️", label: "Weather unavailable", animation: "none" };
    }

    function normalize(payload, municipality) {
        const candidates = [payload?.current, payload?.data?.current, payload?.weather?.current,
            payload?.result?.current, payload?.data?.weather?.current, payload?.current_weather,
            payload?.data?.current_weather, payload?.weather, payload?.data, payload?.result, payload];
        const raw = candidates.find(item => item && typeof item === "object" && [
            "weather_code", "weatherCode", "temperature_2m", "temperature_c", "temperature", "is_day", "isDay"
        ].some(key => item[key] !== undefined));
        if (!raw) throw new Error("Weather response has no recognizable current-weather fields.");
        const w = {
            municipality,
            code: num(first(raw.weather_code, raw.weatherCode, raw.condition_code, raw.conditionCode, raw.code)),
            isDay: num(first(raw.is_day, raw.isDay)),
            temperature: num(first(raw.temperature_2m, raw.temperature_c, raw.temperature, raw.temp_c)),
            feelsLike: num(first(raw.apparent_temperature, raw.feelslike_c, raw.feels_like, raw.apparentTemperature)),
            humidity: num(first(raw.relative_humidity_2m, raw.humidity_percent, raw.humidity, raw.relativeHumidity)),
            clouds: num(first(raw.cloud_cover, raw.cloud_percent, raw.clouds, raw.cloudCover)),
            precipitation: num(first(raw.precipitation, raw.precipitation_mm, raw.precipitationMm)),
            rain: num(first(raw.rain, raw.rain_mm, raw.rainMm)),
            showers: num(first(raw.showers, raw.showers_mm, raw.showersMm)),
            wind: num(first(raw.wind_speed_10m, raw.wind_kph, raw.wind_speed, raw.windSpeed)),
            windDirection: num(first(raw.wind_direction_10m, raw.wind_direction, raw.windDirection)),
            conditionText: first(raw.condition_text, raw.conditionText, raw.weather_description, raw.description),
            sourceTime: first(raw.time, raw.model_time, raw.last_updated, raw.updated_at),
            raw
        };
        w.view = presentation(w);
        return w;
    }

    function injectStyles() {
        if (state.stylesAdded || $("agos-weather-animation-styles")) { state.stylesAdded = true; return; }
        const style = document.createElement("style");
        style.id = "agos-weather-animation-styles";
        style.textContent = `
            .agos-weather-marker{position:relative;width:48px;height:48px;display:flex;align-items:center;justify-content:center;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important;cursor:default;user-select:none;pointer-events:none;z-index:3}
            .agos-weather-icon{position:relative;z-index:3;font-size:38px;line-height:1;filter:drop-shadow(0 2px 4px #0008)}
            .agos-weather-temperature{display:none!important}.agos-weather-marker[data-weather-state=error] .agos-weather-icon{filter:grayscale(1) drop-shadow(0 2px 4px #0008)}
            .agos-weather-cloud{position:absolute;top:4px;left:4px;font-size:18px;opacity:.7;pointer-events:none;animation:agosCloudFloat 4s ease-in-out infinite}
            .agos-weather-rain{position:absolute;inset:0;overflow:visible;border-radius:0;pointer-events:none}.agos-weather-drop{position:absolute;top:-10px;width:2px;height:10px;border-radius:2px;background:#79ddff;animation:agosRainFall .7s linear infinite}
            .agos-weather-drop:nth-child(1){left:22%}.agos-weather-drop:nth-child(2){left:43%;animation-delay:.2s}.agos-weather-drop:nth-child(3){left:65%;animation-delay:.1s}.agos-weather-drop:nth-child(4){left:82%;animation-delay:.35s}
            .agos-weather-storm-glow{position:absolute;inset:-2px;border:0;border-radius:0;animation:agosStormPulse 1.4s ease-in-out infinite;pointer-events:none}
            .agos-weather-fog{position:absolute;inset:12px -6px;border-top:2px solid #dcf5ff99;border-bottom:2px solid #dcf5ff77;border-radius:0;animation:agosFogMove 3s ease-in-out infinite alternate;pointer-events:none}
            .agos-weather-sun-glow{position:absolute;inset:-2px;border:0;border-radius:0;animation:agosStormPulse 3s ease-in-out infinite;pointer-events:none}
            .agos-weather-popup{min-width:220px;color:#eaf5ff;font:13px/1.5 system-ui,-apple-system,BlinkMacSystemFont,sans-serif}.agos-weather-popup-title{margin:0 0 8px;color:#61dcff;font-size:14px;font-weight:800}
            .agos-weather-popup-main{display:flex;align-items:center;gap:10px;margin-bottom:10px}.agos-weather-popup-icon{font-size:34px;line-height:1}.agos-weather-popup-temp{font-size:25px;font-weight:800;line-height:1.1}.agos-weather-popup-condition{color:#d1e8f6;font-size:12px}
            .agos-weather-popup-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:10px}.agos-weather-popup-stat{padding:7px;border:1px solid #70c3e238;border-radius:8px;background:#1c3f5b80}.agos-weather-popup-stat-label{display:block;color:#9bb9cd;font-size:10px}.agos-weather-popup-stat-value{display:block;color:#f2fbff;font-size:12px;font-weight:700}.agos-weather-popup-updated{margin-top:10px;color:#8daabd;font-size:10px}.agos-weather-popup-error{color:#ffcf9e;font-size:12px}
            .maplibregl-popup-content{color:#eaf5ff;background:#0b1d32;border:1px solid #5cdcff59;border-radius:12px;box-shadow:0 8px 30px #0006}.maplibregl-popup-tip{border-top-color:#0b1d32!important;border-bottom-color:#0b1d32!important}
            @keyframes agosRainFall{0%{transform:translateY(-10px);opacity:0}20%{opacity:.9}100%{transform:translateY(65px);opacity:0}}@keyframes agosCloudFloat{0%,100%{transform:translateX(0)}50%{transform:translateX(6px)}}@keyframes agosStormPulse{0%,100%{opacity:.25;transform:scale(.96)}50%{opacity:1;transform:scale(1.04)}}@keyframes agosFogMove{from{transform:translateX(-3px);opacity:.35}to{transform:translateX(5px);opacity:.8}}
            @media(prefers-reduced-motion:reduce){.agos-weather-cloud,.agos-weather-drop,.agos-weather-storm-glow,.agos-weather-fog,.agos-weather-sun-glow{animation:none!important}}
        `;
        document.head.appendChild(style);
        state.stylesAdded = true;
    }

    function markerId(name) { return `agos-weather-marker-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`; }

    function renderWeather(name) {
        const element = $(markerId(name));
        const w = state.weather.get(name);
        if (!element || !w) return;
        element.querySelector(".agos-weather-icon").textContent = w.view.icon;
        element.dataset.weatherState = "ready";
        element.setAttribute("aria-label", `${name}: ${w.view.label}`);
        element.removeAttribute("title");
        element.querySelectorAll(".agos-weather-rain,.agos-weather-cloud,.agos-weather-storm-glow,.agos-weather-fog,.agos-weather-sun-glow").forEach(node => node.remove());
        const add = (className, tag = "span") => { const node = document.createElement(tag); node.className = className; element.appendChild(node); };
        if (w.view.animation === "rain" || w.view.animation === "storm") {
            const rain = document.createElement("div"); rain.className = "agos-weather-rain";
            for (let i = 0; i < 4; i++) { const drop = document.createElement("span"); drop.className = "agos-weather-drop"; rain.appendChild(drop); }
            element.appendChild(rain);
        }
        if (w.view.animation === "cloud") { const cloud = document.createElement("span"); cloud.className = "agos-weather-cloud"; cloud.textContent = "☁"; element.appendChild(cloud); }
        if (w.view.animation === "storm") add("agos-weather-storm-glow");
        if (w.view.animation === "fog") add("agos-weather-fog");
        if (w.view.animation === "sun") add("agos-weather-sun-glow");
    }

    function renderError(name, error) {
        const element = $(markerId(name));
        if (element) { element.dataset.weatherState = "error"; element.setAttribute("aria-label", `${name}: weather unavailable`); element.removeAttribute("title"); }
    }

    function createMarker(name) {
        if (state.markers.has(name)) return true;
        const element = document.createElement("div");
        element.id = markerId(name);
        element.className = "agos-weather-marker";
        element.dataset.municipality = name;
        element.dataset.weatherState = "loading";
        element.setAttribute("aria-hidden", "true");
        element.innerHTML = `<span class="agos-weather-icon" aria-hidden="true">☁️</span>`;

        // A weather graphic is purely visual. It must not open a popup,
        // select a municipality, or trigger any map zoom/camera movement.
        const marker = new window.maplibregl.Marker({
            element,
            anchor: "center"
        }).setLngLat(MUNICIPALITIES[name]).addTo(state.map);

        state.markers.set(name, marker);
        return true;
    }

    function hideOldStaticMarkers() {
        // These layer IDs are used by the current map.js. Keep the source and
        // click handlers intact, but hide the duplicate visual circles/labels.
        try {
            // Weather markers are now the only municipality point markers.
            // Keep the boundary polygons/labels available as a separate map layer.
            const ids = [
                "agos-municipality-marker-circles",
                "agos-municipality-marker-labels",
                "agos-selected-municipality-halo",
                "agos-selected-municipality-dot",
                "agos-selected-municipality-label"
            ];
            for (const id of ids) {
                if (state.map.getLayer(id)) state.map.setLayoutProperty(id, "visibility", "none");
            }
            // Also remove older DOM-based municipality markers if an earlier
            // version of the script created them.
            document.querySelectorAll(".agos-municipality-marker").forEach(node => node.remove());
        } catch (error) { console.warn("[AGOS Weather] Could not hide old municipality markers:", error); }
    }

    function buildURL(name) { const url = new URL(CONFIG.endpoint, window.location.href); url.searchParams.set("municipality", name); return url.toString(); }

    async function fetchWeather(name) {
        const previous = state.controllers.get(name);
        if (previous) previous.abort();
        const controller = new AbortController(); state.controllers.set(name, controller);
        let timedOut = false;
        const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, CONFIG.requestTimeout);
        try {
            const response = await fetch(buildURL(name), { method: "GET", headers: { Accept: "application/json" }, cache: "no-store", signal: controller.signal });
            if (!response.ok) throw new Error(`Weather API returned HTTP ${response.status}.`);
            const payload = await response.json();
            if (payload?.error) throw new Error(typeof payload.error === "string" ? payload.error : "Weather service reported an error.");
            return normalize(payload, name);
        } catch (error) {
            if (timedOut) throw new Error(`Weather request timed out for ${name}.`);
            throw error;
        } finally {
            window.clearTimeout(timeout);
            if (state.controllers.get(name) === controller) state.controllers.delete(name);
        }
    }

    async function refreshMunicipality(name) {
        name = normalizeName(name);
        if (!state.running || !MUNICIPALITIES[name] || state.inFlight.has(name)) return null;
        state.inFlight.add(name);
        const element = $(markerId(name));
        if (element && !state.weather.has(name)) { element.dataset.weatherState = "loading"; element.title = `${name}: loading weather`; }
        try {
            const w = await fetchWeather(name);
            if (!state.running) return null;
            const now = new Date();
            state.weather.set(name, w); state.updated.set(name, now); state.errors.delete(name);
            renderWeather(name);
            console.info("[AGOS Weather] Updated", { municipality: name, condition: w.view.label, temperature: w.temperature, weatherCode: w.code });
            return w;
        } catch (error) {
            if (error.name === "AbortError" || !state.running) return null;
            state.errors.set(name, error); renderError(name, error);
            console.error(`[AGOS Weather] Could not update ${name}:`, error);
            return null;
        } finally {
            state.inFlight.delete(name);
            if (state.running) updateStatus();
        }
    }

    async function refresh() {
        if (!state.running) return;
        state.selected = selectedName();
        status(`Updating weather for ${NAMES.length} Bataan municipalities…`);
        await Promise.allSettled(NAMES.map(name => refreshMunicipality(name)));
        if (state.running) updateStatus();
    }

    async function refreshSelectedMunicipality() {
        if (!state.running) return;
        const name = selectedName(); state.selected = name;
        status(`Updating ${name} weather…`);
        await refreshMunicipality(name);
        if (state.running) updateStatus();
    }

    function updateStatus() {
        const name = selectedName();
        const w = state.weather.get(name); const error = state.errors.get(name);
        if (w) status(`${name}: ${w.view.label} · ${temp(w.temperature)} · Updated ${updatedText(state.updated.get(name))}`);
        else if (error) status(`Weather unavailable for ${name}. Check that the AGOS backend is running.`);
        else status(`Loading weather: ${state.weather.size}/${NAMES.length} municipalities updated.`);
    }

    function selectMunicipality(name, flyTo) {
        name = normalizeName(name); if (!MUNICIPALITIES[name]) return;
        state.selected = name;
        const selector = selectedSelector();
        if (selector && normalizeName(selector.value) !== name) {
            selector.value = name;
            selector.dispatchEvent(new Event("change", { bubbles: true }));
        }
        // Only ONE controller may animate the camera. AGOSMap.selectMunicipality()
        // already calls flyTo(); running a second flyTo here makes the weather
        // marker and the municipality marker fight over the map zoom/center.
        let cameraHandledByAGOS = false;
        if (flyTo && window.AGOSMap && typeof window.AGOSMap.selectMunicipality === "function") {
            try {
                cameraHandledByAGOS = window.AGOSMap.selectMunicipality(name) !== false;
            } catch (error) {
                console.warn("[AGOS Weather] AGOSMap selection callback failed:", error);
            }
        }
        if (flyTo && !cameraHandledByAGOS && state.map && typeof state.map.flyTo === "function") {
            state.map.flyTo({ center: MUNICIPALITIES[name], zoom: 12, duration: 1200, essential: true });
        }
        // The old map.js selection callback may turn its highlight layers back on.
        hideOldStaticMarkers();
        refreshSelectedMunicipality();
    }

    function bindSelector() {
        const selector = selectedSelector();
        if (!selector || selector.dataset.agosWeatherBound === "true") return;
        selector.addEventListener("change", () => { state.selected = selectedName(); refreshSelectedMunicipality(); });
        selector.dataset.agosWeatherBound = "true";
    }

    function findMap() {
        return window.AGOSMap && typeof window.AGOSMap.getMap === "function" ? window.AGOSMap.getMap() : null;
    }

    function start() {
        if (state.running) return;
        if (state.retryTimer) { window.clearTimeout(state.retryTimer); state.retryTimer = null; }
        state.map = findMap();
        if (!state.map) { state.retryTimer = window.setTimeout(start, 1000); return; }
        if (!window.maplibregl) { console.error("[AGOS Weather] MapLibre GL JS is not loaded."); return; }
        injectStyles(); hideOldStaticMarkers();
        state.selected = selectedName();
        NAMES.forEach(createMarker);
        bindSelector(); state.running = true;
        status("Connecting to Open-Meteo through AGOS…");
        refresh();
        state.timer = window.setInterval(refresh, CONFIG.refreshInterval);
        console.info(`[AGOS Weather] Started: ${state.markers.size}/${NAMES.length} markers.`);
    }

    function stop() {
        state.running = false;
        if (state.timer) { window.clearInterval(state.timer); state.timer = null; }
        if (state.retryTimer) { window.clearTimeout(state.retryTimer); state.retryTimer = null; }
        for (const controller of state.controllers.values()) controller.abort();
        state.controllers.clear(); state.inFlight.clear();
        for (const marker of state.markers.values()) marker.remove();
        state.markers.clear(); state.weather.clear(); state.updated.clear(); state.errors.clear();
        // Do not restore the old municipality point markers: weather markers
        // are the intended replacement. Province boundaries remain untouched.
        console.info("[AGOS Weather] Stopped.");
    }

    function initialize() {
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
        else start();
    }

    window.AGOSWeatherAnimation = {
        start, stop, refresh, refreshSelectedMunicipality, refreshMunicipality,
        getState() {
            const name = selectedName(); const w = state.weather.get(name); const err = state.errors.get(name);
            return {
                running: state.running, municipality: name, markerCount: state.markers.size,
                lastUpdated: state.updated.get(name) || null, lastError: err ? err.message : null,
                municipalities: NAMES.map(municipality => {
                    const item = state.weather.get(municipality); const error = state.errors.get(municipality);
                    return { municipality, hasMarker: state.markers.has(municipality), lastUpdated: state.updated.get(municipality) || null,
                        error: error ? error.message : null,
                        weather: item ? { condition: item.view.label, weatherCode: item.code, isDay: item.isDay, temperature: item.temperature } : null };
                }),
                lastWeather: w ? { municipality: w.municipality, condition: w.view.label, weatherCode: w.code, isDay: w.isDay, temperature: w.temperature } : null
            };
        }
    };

    initialize();
})();
