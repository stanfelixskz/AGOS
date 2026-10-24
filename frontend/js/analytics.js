/*
 * AGOS — Weather Intelligence Analytics
 * Complete replacement for frontend/js/analytics.js
 *
 * Data source: Open-Meteo Forecast API
 * Time zone: Asia/Manila
 *
 * IMPORTANT DATA NOTES
 * - Coordinates are representative query points, not authoritative LGU centroids.
 * - Open-Meteo forecast endpoint values are model output, not guaranteed station observations.
 * - Rainfall comparisons use per-location values. Province-wide hourly rainfall is an
 *   average across available locations, never a sum across municipalities.
 * - Weather indicators are not proof of flooding. Flood-risk labels are contextual
 *   weather signals only; actual flood status requires verified flood/river evidence.
 * - Chart.js must be loaded before this file.
 */

(function () {
    "use strict";

    const API = "https://api.open-meteo.com/v1/forecast";
    const TIMEZONE = "Asia/Manila";
    const REFRESH_MS = 15 * 60 * 1000;
    const REQUEST_CONCURRENCY = 4;

    const MUNICIPALITIES = [
        { name: "Abucay", lat: 14.722, lon: 120.533 },
        { name: "Bagac", lat: 14.596, lon: 120.393 },
        { name: "Balanga City", lat: 14.676, lon: 120.536 },
        { name: "Dinalupihan", lat: 14.879, lon: 120.464 },
        { name: "Hermosa", lat: 14.832, lon: 120.508 },
        { name: "Limay", lat: 14.561, lon: 120.598 },
        { name: "Mariveles", lat: 14.433, lon: 120.485 },
        { name: "Morong", lat: 14.679, lon: 120.267 },
        { name: "Orani", lat: 14.801, lon: 120.537 },
        { name: "Orion", lat: 14.620, lon: 120.582 },
        { name: "Pilar", lat: 14.660, lon: 120.565 },
        { name: "Samal", lat: 14.767, lon: 120.543 }
    ];

    const WEATHER_CODES = {
        0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
        45: "Fog", 48: "Depositing rime fog", 51: "Light drizzle",
        53: "Moderate drizzle", 55: "Dense drizzle", 56: "Light freezing drizzle",
        57: "Dense freezing drizzle", 61: "Slight rain", 63: "Moderate rain",
        65: "Heavy rain", 66: "Light freezing rain", 67: "Heavy freezing rain",
        71: "Slight snowfall", 73: "Moderate snowfall", 75: "Heavy snowfall",
        77: "Snow grains", 80: "Slight rain showers", 81: "Moderate rain showers",
        82: "Violent rain showers", 85: "Slight snow showers", 86: "Heavy snow showers",
        95: "Thunderstorm", 96: "Thunderstorm with slight hail",
        97: "Heavy thunderstorm", 99: "Thunderstorm with heavy hail"
    };

    const METRICS = {
        precipitation: { label: "Precipitation", unit: "mm", aggregation: "sum", color: "#2878d0", group: "Rainfall" },
        precipitation_probability: { label: "Precipitation probability", unit: "%", aggregation: "mean", color: "#6b68d8", group: "Rainfall" },
        temperature_2m: { label: "Temperature", unit: "°C", aggregation: "mean", color: "#e79b32", group: "Temperature" },
        apparent_temperature: { label: "Feels-like temperature", unit: "°C", aggregation: "mean", color: "#d86b45", group: "Temperature" },
        relative_humidity_2m: { label: "Relative humidity", unit: "%", aggregation: "mean", color: "#169b78", group: "Atmosphere" },
        dew_point_2m: { label: "Dew point", unit: "°C", aggregation: "mean", color: "#258e9e", group: "Atmosphere" },
        wind_speed_10m: { label: "Wind speed (10 m)", unit: "km/h", aggregation: "mean", color: "#19a7c7", group: "Wind" },
        wind_gusts_10m: { label: "Wind gusts", unit: "km/h", aggregation: "max", color: "#6554c0", group: "Wind" },
        wind_direction_10m: { label: "Wind direction", unit: "°", aggregation: "direction", color: "#4f79bd", group: "Wind" },
        cloud_cover: { label: "Total cloud cover", unit: "%", aggregation: "mean", color: "#7b8794", group: "Clouds" },
        cloud_cover_low: { label: "Low cloud cover", unit: "%", aggregation: "mean", color: "#9aa5b1", group: "Clouds" },
        cloud_cover_mid: { label: "Mid cloud cover", unit: "%", aggregation: "mean", color: "#6d8299", group: "Clouds" },
        cloud_cover_high: { label: "High cloud cover", unit: "%", aggregation: "mean", color: "#a8b6c4", group: "Clouds" },
        pressure_msl: { label: "Sea-level pressure", unit: "hPa", aggregation: "mean", color: "#8b5fc7", group: "Atmosphere" },
        surface_pressure: { label: "Surface pressure", unit: "hPa", aggregation: "mean", color: "#a36cc7", group: "Atmosphere" },
        visibility: { label: "Visibility", unit: "km", aggregation: "mean", color: "#4d9e9a", group: "Visibility" },
        shortwave_radiation: { label: "Shortwave radiation", unit: "W/m²", aggregation: "mean", color: "#d6a32b", group: "Solar" },
        vapour_pressure_deficit: { label: "Vapour pressure deficit", unit: "kPa", aggregation: "mean", color: "#b27b47", group: "Soil & evaporation" },
        et0_fao_evapotranspiration: { label: "Reference evapotranspiration", unit: "mm", aggregation: "sum", color: "#5c9b62", group: "Soil & evaporation" },
        soil_temperature_0cm: { label: "Soil / surface temperature", unit: "°C", aggregation: "mean", color: "#bb7757", group: "Soil & evaporation" },
        soil_moisture_0_to_1cm: { label: "Surface soil moisture", unit: "m³/m³", aggregation: "mean", color: "#507b57", group: "Soil & evaporation" },
        cape: { label: "Convective available potential energy", unit: "J/kg", aggregation: "mean", color: "#bc5a5a", group: "Storm environment" }
    };

    const CURRENT_VARIABLES = [
        "temperature_2m", "relative_humidity_2m", "apparent_temperature",
        "precipitation", "rain", "showers", "weather_code", "cloud_cover",
        "pressure_msl", "surface_pressure", "wind_speed_10m", "wind_direction_10m",
        "wind_gusts_10m", "is_day"
    ];

    const HOURLY_VARIABLES = [
        "temperature_2m", "relative_humidity_2m", "dew_point_2m", "apparent_temperature",
        "precipitation_probability", "precipitation", "rain", "showers", "weather_code",
        "pressure_msl", "surface_pressure", "cloud_cover", "cloud_cover_low", "cloud_cover_mid",
        "cloud_cover_high", "visibility", "et0_fao_evapotranspiration", "vapour_pressure_deficit",
        "wind_speed_10m", "wind_speed_80m", "wind_direction_10m", "wind_gusts_10m",
        "shortwave_radiation", "soil_temperature_0cm", "soil_temperature_6cm",
        "soil_temperature_18cm", "soil_temperature_54cm", "soil_moisture_0_to_1cm",
        "soil_moisture_1_to_3cm", "soil_moisture_3_to_9cm", "soil_moisture_9_to_27cm",
        "soil_moisture_27_to_81cm", "cape"
    ];

    const DAILY_VARIABLES = [
        "weather_code", "temperature_2m_max", "temperature_2m_min", "apparent_temperature_max",
        "apparent_temperature_min", "uv_index_max", "uv_index_clear_sky_max", "sunrise", "sunset",
        "daylight_duration", "sunshine_duration", "rain_sum", "showers_sum", "precipitation_sum",
        "precipitation_hours", "precipitation_probability_max", "wind_speed_10m_max",
        "wind_gusts_10m_max", "wind_direction_10m_dominant", "shortwave_radiation_sum",
        "et0_fao_evapotranspiration"
    ];

    const state = {
        initialized: false,
        loading: false,
        records: new Map(),
        errors: new Map(),
        selectedMunicipality: "all",
        selectedMeteogramMunicipality: "Balanga City",
        period: "past24",
        metric: "precipitation",
        resolution: "hourly",
        charts: {},
        echarts: {},
        echartsLoading: false,
        lastUpdated: null,
        requestId: 0,
        controller: null,
        refreshTimer: null
    };

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

    function escapeHTML(value) {
        return String(value ?? "").replace(/[&<>"']/g, ch => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[ch]);
    }

    function number(value, digits = 1) {
        const n = Number(value);
        return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : "—";
    }

    function mean(values) {
        const valid = values.map(Number).filter(Number.isFinite);
        return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
    }

    function total(values) {
        const valid = values.map(Number).filter(Number.isFinite);
        return valid.length ? valid.reduce((a, b) => a + b, 0) : null;
    }

    function maxValue(values) {
        const valid = values.map(Number).filter(Number.isFinite);
        return valid.length ? Math.max(...valid) : null;
    }

    function minValue(values) {
        const valid = values.map(Number).filter(Number.isFinite);
        return valid.length ? Math.min(...valid) : null;
    }

    function getRoot() {
        return document.getElementById("view-analytics");
    }

    function localDateParts(date = new Date()) {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", hourCycle: "h23"
        }).formatToParts(date);
        return Object.fromEntries(parts.map(part => [part.type, part.value]));
    }

    function parseApiTime(value) {
        if (!value) return NaN;
        // Open-Meteo returns timezone-local ISO timestamps without an offset when timezone is named.
        // Convert using an explicit +08:00 offset for Asia/Manila to avoid browser-local ambiguity.
        const text = String(value);
        if (/Z$|[+-]\d\d:\d\d$/.test(text)) return Date.parse(text);
        return Date.parse(`${text}+08:00`);
    }

    function formatLocalTime(value, includeDate = false) {
        const timestamp = typeof value === "number" ? value : parseApiTime(value);
        if (!Number.isFinite(timestamp)) return String(value ?? "—");
        return new Intl.DateTimeFormat("en-PH", {
            timeZone: TIMEZONE,
            ...(includeDate ? { month: "short", day: "numeric" } : {}),
            hour: "2-digit", minute: "2-digit", hour12: true
        }).format(new Date(timestamp));
    }

    function formatMetric(value, metric) {
        if (!Number.isFinite(Number(value))) return "—";
        const definition = METRICS[metric];
        if (!definition) return number(value);
        const digits = metric === "relative_humidity_2m" || metric.includes("probability") || metric.includes("cloud_cover") ? 0 : 1;
        return `${number(value, digits)} ${definition.unit}`;
    }

    function metricOptions() {
        const groups = {};
        Object.entries(METRICS).forEach(([key, metric]) => {
            (groups[metric.group] ||= []).push({ key, label: `${metric.label} (${metric.unit})` });
        });
        return Object.entries(groups).map(([group, items]) => `
            <optgroup label="${escapeHTML(group)}">
                ${items.map(item => `<option value="${item.key}">${escapeHTML(item.label)}</option>`).join("")}
            </optgroup>
        `).join("");
    }

    function makeURL(place) {
        const params = new URLSearchParams({
            latitude: String(place.lat), longitude: String(place.lon), timezone: TIMEZONE,
            past_days: "7", forecast_days: "7",
            current: CURRENT_VARIABLES.join(","),
            hourly: HOURLY_VARIABLES.join(","),
            daily: DAILY_VARIABLES.join(","),
            temperature_unit: "celsius", wind_speed_unit: "kmh", precipitation_unit: "mm",
            timeformat: "iso8601"
        });
        return `${API}?${params.toString()}`;
    }

    async function fetchMunicipality(place, signal) {
        const response = await fetch(makeURL(place), { signal, cache: "no-store" });
        if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
        const data = await response.json();
        if (data.error) throw new Error(data.reason || "Open-Meteo returned an error.");
        if (!data.hourly || !Array.isArray(data.hourly.time) || !data.current) {
            throw new Error("Weather response is incomplete.");
        }
        return { place, data, fetchedAt: new Date().toISOString() };
    }

    function mountDashboard(root) {
        root.innerHTML = `
            <div class="analytics-shell">
                <header class="analytics-header">
                    <div>
                        <div class="analytics-eyebrow">AGOS WEATHER INTELLIGENCE</div>
                        <h1 class="analytics-title">Weather Analytics</h1>
                        <p class="analytics-subtitle">An interactive weather and environmental intelligence workspace for all 12 Bataan LGUs. Forecast-model data is labeled separately from verified flood evidence.</p>
                    </div>
                    <div class="analytics-header-actions">
                        <div class="analytics-updated" id="analyticsUpdated">Waiting for weather data…</div>
                        <button class="analytics-button" id="analyticsRefresh" type="button">↻ Refresh data</button>
                    </div>
                </header>

                <div class="analytics-status" id="analyticsStatus" role="status" aria-live="polite" data-state="loading">Loading weather data from Open-Meteo…</div>

                <section class="analytics-toolbar" aria-label="Analytics filters">
                    <div class="analytics-field"><label for="analyticsMunicipality">Geographic scope</label><select id="analyticsMunicipality"><option value="all">All Bataan — 12 LGUs</option>${MUNICIPALITIES.map(p => `<option value="${escapeHTML(p.name)}">${escapeHTML(p.name)}</option>`).join("")}</select></div>
                    <div class="analytics-field"><label for="analyticsPeriod">Time window</label><select id="analyticsPeriod"><option value="past24">Previous 24 hours</option><option value="past72">Previous 72 hours</option><option value="past168">Previous 7 days</option><option value="next24">Next 24 hours</option><option value="next72">Next 72 hours</option><option value="next168">Next 7 days</option><option value="all336">Past 7 days + next 7 days</option></select></div>
                    <div class="analytics-field"><label for="analyticsMetric">Main chart variable</label><select id="analyticsMetric">${metricOptions()}</select></div>
                    <div class="analytics-field"><label for="analyticsResolution">Chart interval</label><select id="analyticsResolution"><option value="hourly">Hourly</option><option value="daily">Daily</option></select></div>
                </section>

                <section class="analytics-section">
                    <div class="analytics-section-heading"><div><h2>Provincial weather overview</h2><p>Current conditions are averages of available representative model points, not province-wide station measurements.</p></div><span class="analytics-chip" id="analyticsCoverage">0 / 12 LGUs</span></div>
                    <div class="analytics-kpi-grid">
                        <article class="analytics-kpi" style="--kpi-color:#2878d0;--kpi-tint:#edf5ff"><div class="analytics-kpi-top"><span class="analytics-kpi-label">Mean rainfall · selected window</span><span class="analytics-kpi-icon">🌧</span></div><div class="analytics-kpi-value" id="analyticsRainfall">—</div><div class="analytics-kpi-note" id="analyticsRainfallNote">Average accumulation per available LGU</div></article>
                        <article class="analytics-kpi" style="--kpi-color:#e79b32;--kpi-tint:#fff5e6"><div class="analytics-kpi-top"><span class="analytics-kpi-label">Mean current temperature</span><span class="analytics-kpi-icon">🌡</span></div><div class="analytics-kpi-value" id="analyticsTemperature">—</div><div class="analytics-kpi-note" id="analyticsTemperatureNote">Current model conditions</div></article>
                        <article class="analytics-kpi" style="--kpi-color:#169b78;--kpi-tint:#eaf8f2"><div class="analytics-kpi-top"><span class="analytics-kpi-label">Mean relative humidity</span><span class="analytics-kpi-icon">💧</span></div><div class="analytics-kpi-value" id="analyticsHumidity">—</div><div class="analytics-kpi-note">Current model conditions</div></article>
                        <article class="analytics-kpi" style="--kpi-color:#19a7c7;--kpi-tint:#e8f9fc"><div class="analytics-kpi-top"><span class="analytics-kpi-label">Mean wind speed</span><span class="analytics-kpi-icon">💨</span></div><div class="analytics-kpi-value" id="analyticsWind">—</div><div class="analytics-kpi-note" id="analyticsWindNote">10 m above ground</div></article>
                        <article class="analytics-kpi" style="--kpi-color:#7759bb;--kpi-tint:#f1edfb"><div class="analytics-kpi-top"><span class="analytics-kpi-label">Highest daily rain forecast</span><span class="analytics-kpi-icon">📈</span></div><div class="analytics-kpi-value" id="analyticsPeakRain">—</div><div class="analytics-kpi-note" id="analyticsPeakRainNote">Maximum daily total among loaded LGUs</div></article>
                        <article class="analytics-kpi" style="--kpi-color:#c35d56;--kpi-tint:#fff0ef"><div class="analytics-kpi-top"><span class="analytics-kpi-label">Highest forecast gust</span><span class="analytics-kpi-icon">🌀</span></div><div class="analytics-kpi-value" id="analyticsPeakGust">—</div><div class="analytics-kpi-note" id="analyticsPeakGustNote">Daily maximum among loaded LGUs</div></article>
                    </div>
                </section>

                <section class="analytics-section">
                    <div class="analytics-section-heading"><div><h2>Weather trends</h2><p id="analyticsTrendDescription">Explore the selected variable across the chosen time window.</p></div></div>
                    <div class="analytics-chart-grid">
                        <article class="analytics-panel analytics-panel-wide"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title" id="analyticsTrendTitle">Precipitation over time</h3><p class="analytics-panel-description" id="analyticsTrendSub">Province view uses mean rainfall per available location.</p></div><span class="analytics-chip" id="analyticsTrendUnit">mm</span></div><div class="analytics-chart-container"><canvas id="analyticsTrendChart" role="img" aria-label="Selected weather variable over time"></canvas><div class="analytics-empty" id="analyticsTrendEmpty" hidden>No chart data is available yet.</div></div></article>
                        <article class="analytics-panel"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title">Daily rainfall forecast</h3><p class="analytics-panel-description">Daily precipitation totals for the next 7 days.</p></div></div><div class="analytics-chart-container analytics-chart-short"><canvas id="analyticsDailyRainChart" role="img" aria-label="Daily rainfall forecast chart"></canvas><div class="analytics-empty" id="analyticsDailyRainEmpty" hidden>No daily forecast data is available.</div></div></article>
                        <article class="analytics-panel"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title">Temperature range</h3><p class="analytics-panel-description">Daily minimum and maximum temperature.</p></div></div><div class="analytics-chart-container analytics-chart-short"><canvas id="analyticsTemperatureChart" role="img" aria-label="Daily temperature range chart"></canvas><div class="analytics-empty" id="analyticsTemperatureEmpty" hidden>No temperature forecast data is available.</div></div></article>
                        <article class="analytics-panel"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title">Wind and gust outlook</h3><p class="analytics-panel-description">Daily maximum wind speed and gusts.</p></div></div><div class="analytics-chart-container analytics-chart-short"><canvas id="analyticsWindChart" role="img" aria-label="Daily wind and gust chart"></canvas><div class="analytics-empty" id="analyticsWindEmpty" hidden>No wind forecast data is available.</div></div></article>
                        <article class="analytics-panel"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title">Atmospheric snapshot</h3><p class="analytics-panel-description">Current humidity, cloud cover and pressure averages.</p></div></div><div class="analytics-chart-container analytics-chart-short"><canvas id="analyticsAtmosphereChart" role="img" aria-label="Current atmospheric conditions chart"></canvas><div class="analytics-empty" id="analyticsAtmosphereEmpty" hidden>No atmospheric data is available.</div></div></article>
                    </div>
                </section>

                <section class="analytics-section">
                    <div class="analytics-section-heading"><div><h2>Rainfall timing across Bataan</h2><p>Heatmap of forecast hourly precipitation by representative location for the next 72 hours. Darker cells indicate higher forecast rainfall.</p></div><span class="analytics-chip">mm / hour</span></div>
                    <article class="analytics-panel analytics-panel-wide"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title">Municipality × time rainfall heatmap</h3><p class="analytics-panel-description">Hover a cell for the LGU, local time and modelled rainfall. Missing values remain blank.</p></div><span class="analytics-chip">Open-Meteo forecast</span></div><div id="analyticsRainHeatmap" class="analytics-echarts-container" role="img" aria-label="Rainfall heatmap for all twelve Bataan municipalities"><div class="analytics-empty">Loading heatmap library and weather data…</div></div><p class="analytics-source-note">Forecast estimates at representative coordinate points, not measured rain gauges. This heatmap is a planning aid, not a flood warning.</p></article>
                </section>

                <section class="analytics-section">
                    <div class="analytics-section-heading"><div><h2>Municipality weather explorer</h2><p>Inspect how rain, temperature, and wind evolve together at one location.</p></div></div>
                    <div class="analytics-chart-grid">
                        <article class="analytics-panel analytics-panel-wide"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title">Selected-LGU meteogram</h3><p class="analytics-panel-description">Next 72 hours · precipitation columns, temperature line, and wind-speed line.</p></div><div class="analytics-field analytics-inline-field"><label for="analyticsMeteogramMunicipality">Municipality</label><select id="analyticsMeteogramMunicipality">${MUNICIPALITIES.map(p => `<option value="${escapeHTML(p.name)}">${escapeHTML(p.name)}</option>`).join("")}</select></div></div><div class="analytics-chart-container analytics-meteogram-container"><canvas id="analyticsMeteogramChart" role="img" aria-label="Hourly precipitation, temperature and wind forecast for the selected municipality"></canvas><div class="analytics-empty" id="analyticsMeteogramEmpty" hidden>No meteogram data is available.</div></div></article>
                        <article class="analytics-panel"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title">Rainfall vs. wind gusts</h3><p class="analytics-panel-description">Each bubble is an LGU. X = forecast rainfall total, Y = maximum gust; bubble size = precipitation probability.</p></div></div><div class="analytics-chart-container analytics-chart-short"><canvas id="analyticsRiskBubbleChart" role="img" aria-label="Bubble chart comparing rainfall, wind gusts and precipitation probability by municipality"></canvas><div class="analytics-empty" id="analyticsRiskBubbleEmpty" hidden>No comparable rainfall and wind data is available.</div></div><p class="analytics-source-note">This is a weather-condition comparison, not a validated flood-risk score.</p></article>
                    </div>
                </section>

                <section class="analytics-section">
                    <div class="analytics-section-heading"><div><h2>12-LGU comparison</h2><p id="analyticsRankingDescription">Rank locations by the selected weather metric.</p></div></div>
                    <div class="analytics-chart-grid">
                        <article class="analytics-panel"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title">Municipality ranking</h3><p class="analytics-panel-description">Location-specific values; not a sum across LGUs.</p></div></div><div class="analytics-ranking" id="analyticsRanking"><div class="analytics-empty">Waiting for weather data…</div></div></article>
                        <article class="analytics-panel"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title">Weather comparison</h3><p class="analytics-panel-description">Compare current conditions across all loaded locations.</p></div></div><div class="analytics-chart-container analytics-chart-short"><canvas id="analyticsComparisonChart" role="img" aria-label="Municipality weather comparison chart"></canvas><div class="analytics-empty" id="analyticsComparisonEmpty" hidden>No comparison data is available.</div></div></article>
                    </div>
                </section>

                <section class="analytics-section">
                    <div class="analytics-section-heading"><div><h2>Environmental intelligence</h2><p>Additional variables available from the selected weather model; coverage may vary by variable and location.</p></div></div>
                    <div class="analytics-chart-grid">
                        <article class="analytics-panel"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title">Solar radiation and UV</h3><p class="analytics-panel-description">Daily shortwave radiation and maximum UV index.</p></div></div><div class="analytics-chart-container analytics-chart-short"><canvas id="analyticsSolarChart" role="img" aria-label="Solar radiation and UV forecast"></canvas><div class="analytics-empty" id="analyticsSolarEmpty" hidden>No solar forecast data is available.</div></div></article>
                        <article class="analytics-panel"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title">Soil moisture profile</h3><p class="analytics-panel-description">Mean hourly soil moisture at modelled depth bands for the selected scope.</p></div></div><div class="analytics-chart-container analytics-chart-short"><canvas id="analyticsSoilChart" role="img" aria-label="Soil moisture by depth chart"></canvas><div class="analytics-empty" id="analyticsSoilEmpty" hidden>No soil moisture data is available.</div></div></article>
                    </div>
                </section>

                <section class="analytics-section">
                    <article class="analytics-panel"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title">Municipality weather matrix</h3><p class="analytics-panel-description">Select a location above to inspect one LGU. The full view lists all 12.</p></div></div><div class="analytics-table-wrap"><table class="analytics-table"><thead><tr><th>LGU</th><th>Condition</th><th>Temp.</th><th>Feels like</th><th>Humidity</th><th>Rain · window</th><th>Daily rain max</th><th>Wind</th><th>Gust</th><th>Clouds</th><th>Pressure</th><th>Status</th></tr></thead><tbody id="analyticsTableBody"><tr><td colspan="12">Loading weather records…</td></tr></tbody></table></div><p class="analytics-source-note">Source: <a href="https://open-meteo.com/en/docs" target="_blank" rel="noopener noreferrer">Open-Meteo Forecast API</a>. These are model-derived estimates for representative coordinate points. The 12 points are not authoritative administrative centroids. Forecast weather is not a confirmed flood observation.</p></article>
                </section>

                <section class="analytics-section">
                    <article class="analytics-panel"><div class="analytics-panel-header"><div><h3 class="analytics-panel-title">Weather signal interpretation</h3><p class="analytics-panel-description">Contextual indicators to support investigation—not official warnings or proof of flooding.</p></div></div><div class="analytics-insight-grid" id="analyticsInsights"><div class="analytics-empty">Waiting for weather data…</div></div></article>
                </section>
            </div>
        `;

        $("#analyticsMunicipality", root).addEventListener("change", event => {
            state.selectedMunicipality = event.target.value;
            render();
        });
        $("#analyticsPeriod", root).addEventListener("change", event => {
            state.period = event.target.value;
            render();
        });
        $("#analyticsMetric", root).value = state.metric;
        $("#analyticsMetric", root).addEventListener("change", event => {
            state.metric = event.target.value;
            render();
        });
        $("#analyticsResolution", root).addEventListener("change", event => {
            state.resolution = event.target.value;
            render();
        });
        $("#analyticsMeteogramMunicipality", root).value = state.selectedMeteogramMunicipality;
        $("#analyticsMeteogramMunicipality", root).addEventListener("change", event => {
            state.selectedMeteogramMunicipality = event.target.value;
            renderMeteogram();
        });
        $("#analyticsRefresh", root).addEventListener("click", () => loadData(true));
        ensureECharts();
        window.addEventListener("resize", resizeECharts, { passive: true });
    }

    function getSelectedRecords() {
        if (state.selectedMunicipality !== "all") {
            const record = state.records.get(state.selectedMunicipality);
            return record ? [record] : [];
        }
        return MUNICIPALITIES.map(place => state.records.get(place.name)).filter(Boolean);
    }

    function getWindowBounds() {
        const now = Date.now();
        const hour = 60 * 60 * 1000;
        const windows = {
            past24: [now - 24 * hour, now],
            past72: [now - 72 * hour, now],
            past168: [now - 168 * hour, now],
            next24: [now, now + 24 * hour],
            next72: [now, now + 72 * hour],
            next168: [now, now + 168 * hour],
            all336: [now - 168 * hour, now + 168 * hour]
        };
        return windows[state.period] || windows.past24;
    }

    function isForecastWindow() {
        return ["next24", "next72", "next168"].includes(state.period);
    }

    function selectedHourly(record, variable, overridePeriod = null) {
        const hourly = record.data.hourly || {};
        const times = hourly.time || [];
        const values = hourly[variable] || [];
        const bounds = overridePeriod ? getWindowBoundsFor(overridePeriod) : getWindowBounds();
        const [start, end] = bounds;
        const points = [];
        times.forEach((time, index) => {
            const timestamp = parseApiTime(time);
            const value = Number(values[index]);
            if (Number.isFinite(timestamp) && timestamp >= start && timestamp <= end && Number.isFinite(value)) {
                points.push({ time, timestamp, value });
            }
        });
        return points;
    }

    function getWindowBoundsFor(period) {
        const current = state.period;
        state.period = period;
        const bounds = getWindowBounds();
        state.period = current;
        return bounds;
    }

    function dailySeries(record, variable, futureOnly = false) {
        const daily = record.data.daily || {};
        const times = daily.time || [];
        const values = daily[variable] || [];
        const today = localDateParts().year + "-" + localDateParts().month + "-" + localDateParts().day;
        return times.map((time, index) => ({ time, value: Number(values[index]) }))
            .filter(point => Number.isFinite(point.value) && (!futureOnly || point.time >= today));
    }

    function currentValue(record, key) {
        const value = Number(record.data.current?.[key]);
        return Number.isFinite(value) ? value : null;
    }

    function dailyValue(record, variable, reducer = "max") {
        const points = dailySeries(record, variable, true).map(point => point.value);
        if (reducer === "sum") return total(points);
        if (reducer === "mean") return mean(points);
        if (reducer === "min") return minValue(points);
        return maxValue(points);
    }

    function windowValue(record, variable) {
        const points = selectedHourly(record, variable).map(point => point.value);
        if (!points.length) return null;
        const rule = METRICS[variable]?.aggregation || "mean";
        if (rule === "sum") return total(points);
        if (rule === "max") return maxValue(points);
        if (rule === "min") return minValue(points);
        if (rule === "direction") {
            const radians = points.map(value => value * Math.PI / 180);
            const x = mean(radians.map(value => Math.cos(value)));
            const y = mean(radians.map(value => Math.sin(value)));
            if (x === null || y === null) return null;
            return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
        }
        return mean(points);
    }

    function setText(id, value) {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    }

    function setStatus(message, status = "success") {
        const element = $("#analyticsStatus");
        if (!element) return;
        element.textContent = message;
        element.dataset.state = status;
    }

    function destroyChart(name) {
        if (state.charts[name]) {
            state.charts[name].destroy();
            state.charts[name] = null;
        }
    }

    function chartAvailable(canvasId, emptyId, name, hasData) {
        const canvas = document.getElementById(canvasId);
        const empty = document.getElementById(emptyId);
        if (!canvas || !empty) return false;
        if (typeof Chart === "undefined" || !hasData) {
            destroyChart(name);
            canvas.hidden = true;
            empty.hidden = false;
            empty.textContent = typeof Chart === "undefined"
                ? "Chart.js is not loaded. Load Chart.js before analytics.js."
                : "No data is available for this chart and selection.";
            return false;
        }
        canvas.hidden = false;
        empty.hidden = true;
        return true;
    }

    function chartDefaults() {
        return {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: "index" },
            plugins: {
                legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8, padding: 14 } },
                tooltip: { callbacks: { label(context) {
                    const label = context.dataset.label ? `${context.dataset.label}: ` : "";
                    return `${label}${number(context.parsed.y)}${context.dataset.unit ? ` ${context.dataset.unit}` : ""}`;
                } } }
            },
            scales: {
                x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
                y: { beginAtZero: false, ticks: { maxTicksLimit: 6 } }
            }
        };
    }

    function buildChart(name, canvasId, emptyId, type, data, options = {}) {
        const hasLabelData = Array.isArray(data?.labels) && data.labels.length > 0 &&
            (data.datasets || []).some(dataset => (dataset.data || []).some(value => value !== null && value !== undefined && Number.isFinite(Number(value))));
        const hasPointData = Array.isArray(data?.datasets) && data.datasets.some(dataset =>
            (dataset.data || []).some(point => point && typeof point === "object"
                ? Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
                : point !== null && point !== undefined && Number.isFinite(Number(point))));
        const hasData = hasLabelData || hasPointData;
        if (!chartAvailable(canvasId, emptyId, name, hasData)) return;
        destroyChart(name);
        const canvas = document.getElementById(canvasId);
        const base = chartDefaults();
        const merged = {
            ...base,
            ...options,
            plugins: { ...base.plugins, ...(options.plugins || {}) },
            scales: { ...base.scales, ...(options.scales || {}) }
        };
        state.charts[name] = new Chart(canvas, { type, data, options: merged });
    }

    function ensureECharts() {
        if (window.echarts) { renderRainHeatmap(); return; }
        if (state.echartsLoading) return;
        state.echartsLoading = true;
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js";
        script.async = true;
        script.onload = () => { state.echartsLoading = false; renderRainHeatmap(); };
        script.onerror = () => {
            state.echartsLoading = false;
            const container = document.getElementById("analyticsRainHeatmap");
            if (container) container.innerHTML = '<div class="analytics-empty">The ECharts library could not load. Check your internet connection or CDN access.</div>';
        };
        document.head.appendChild(script);
    }

    function resizeECharts() {
        Object.values(state.echarts).forEach(chart => { if (chart && !chart.isDisposed()) chart.resize(); });
    }

    function renderRainHeatmap() {
        const container = document.getElementById("analyticsRainHeatmap");
        if (!container || !state.records.size) return;
        if (!window.echarts) { ensureECharts(); return; }
        const places = MUNICIPALITIES.filter(place => state.records.has(place.name));
        const timelineMap = new Map();
        const rows = [];
        places.forEach(place => {
            const record = state.records.get(place.name);
            const points = selectedHourly(record, "precipitation", "next72");
            points.forEach(point => timelineMap.set(point.timestamp, point.time));
            rows.push({ name: place.name, values: points.map(point => [point.timestamp, point.value]) });
        });
        const timestamps = [...timelineMap.keys()].sort((a, b) => a - b);
        if (!timestamps.length) {
            container.innerHTML = '<div class="analytics-empty">No hourly forecast rainfall is available for this window.</div>';
            if (state.echarts.rainHeatmap) { state.echarts.rainHeatmap.dispose(); delete state.echarts.rainHeatmap; }
            return;
        }
        let max = 0;
        const data = [];
        rows.forEach((row, y) => {
            const lookup = new Map(row.values);
            timestamps.forEach((timestamp, x) => {
                if (!lookup.has(timestamp)) return;
                const value = lookup.get(timestamp);
                if (!Number.isFinite(value)) return;
                max = Math.max(max, value);
                data.push([x, y, value]);
            });
        });
        if (state.echarts.rainHeatmap) state.echarts.rainHeatmap.dispose();
        container.innerHTML = "";
        const chart = window.echarts.init(container);
        state.echarts.rainHeatmap = chart;
        const labels = timestamps.map(timestamp => new Intl.DateTimeFormat("en-PH", { timeZone: TIMEZONE, weekday: "short", day: "numeric", hour: "2-digit", hour12: true }).format(new Date(timestamp)));
        chart.setOption({
            animation: false,
            grid: { left: 105, right: 30, top: 28, bottom: 70 },
            tooltip: { position: "top", formatter(params) {
                const [x, y, value] = params.data;
                return `<strong>${escapeHTML(rows[y].name)}</strong><br>${escapeHTML(formatLocalTime(timestamps[x], true))}<br>Forecast precipitation: <b>${number(value, 2)} mm</b>`;
            } },
            xAxis: { type: "category", data: labels, splitArea: { show: true }, axisLabel: { interval: Math.max(0, Math.floor(labels.length / 12)), rotate: 35, hideOverlap: true, color: "#65758b" }, axisLine: { lineStyle: { color: "#d7e0e9" } }, axisTick: { show: false } },
            yAxis: { type: "category", data: rows.map(row => row.name), splitArea: { show: true }, axisLabel: { color: "#42536a" }, axisLine: { show: false }, axisTick: { show: false } },
            visualMap: { min: 0, max: Math.max(0.1, max), calculable: true, orient: "horizontal", left: "center", bottom: 0, text: ["Higher", "Lower"], inRange: { color: ["#f3f8ff", "#9bc9f5", "#3b82c4", "#154c91", "#54278f"] }, textStyle: { color: "#65758b" } },
            series: [{ name: "Forecast precipitation", type: "heatmap", data, progressive: 1000, emphasis: { itemStyle: { borderColor: "#1f2937", borderWidth: 1 } } }]
        });
    }

    function renderMeteogram() {
        const name = state.selectedMeteogramMunicipality;
        const record = state.records.get(name);
        if (!record) return;
        const rain = selectedHourly(record, "precipitation", "next72");
        const temp = new Map(selectedHourly(record, "temperature_2m", "next72").map(point => [point.timestamp, point.value]));
        const wind = new Map(selectedHourly(record, "wind_speed_10m", "next72").map(point => [point.timestamp, point.value]));
        const timestamps = rain.map(point => point.timestamp).filter(timestamp => temp.has(timestamp) || wind.has(timestamp));
        const labels = timestamps.map(timestamp => formatLocalTime(timestamp, true));
        const datasets = [
            { type: "bar", label: "Precipitation (mm/h)", data: timestamps.map(timestamp => rain.find(point => point.timestamp === timestamp)?.value ?? null), yAxisID: "yRain", backgroundColor: "rgba(43, 130, 204, 0.45)", borderColor: "#2878d0", borderWidth: 1, order: 3 },
            { type: "line", label: "Temperature (°C)", data: timestamps.map(timestamp => temp.get(timestamp) ?? null), yAxisID: "yTemp", borderColor: "#e79b32", backgroundColor: "#e79b32", pointRadius: 0, borderWidth: 2, tension: 0.25, spanGaps: true, order: 1 },
            { type: "line", label: "Wind speed (km/h)", data: timestamps.map(timestamp => wind.get(timestamp) ?? null), yAxisID: "yWind", borderColor: "#169b78", backgroundColor: "#169b78", pointRadius: 0, borderWidth: 2, borderDash: [5, 3], tension: 0.25, spanGaps: true, order: 2 }
        ];
        buildChart("meteogram", "analyticsMeteogramChart", "analyticsMeteogramEmpty", "bar", { labels, datasets }, {
            interaction: { mode: "index", intersect: false },
            plugins: { title: { display: true, text: `${name} · next 72 hours` }, tooltip: { callbacks: { label(context) { const value = context.parsed.y; return `${context.dataset.label}: ${Number.isFinite(value) ? number(value, 1) : "—"}`; } } } },
            scales: {
                x: { grid: { display: false }, ticks: { maxTicksLimit: 10, maxRotation: 0 } },
                yRain: { type: "linear", position: "left", beginAtZero: true, title: { display: true, text: "Rain (mm/h)" }, grid: { color: "rgba(130,145,160,.12)" } },
                yTemp: { type: "linear", position: "right", title: { display: true, text: "Temperature (°C)" }, grid: { drawOnChartArea: false } },
                yWind: { type: "linear", position: "right", display: false, beginAtZero: true, grid: { drawOnChartArea: false } }
            }
        });
    }

    function renderRiskBubble(records) {
        const rows = records.map(record => ({
            name: record.place.name,
            rain: windowValue(record, "precipitation"),
            gust: windowValue(record, "wind_gusts_10m"),
            probability: mean(selectedHourly(record, "precipitation_probability").map(point => point.value))
        })).filter(row => Number.isFinite(row.rain) && Number.isFinite(row.gust));
        const colors = ["#2878d0", "#169b78", "#e79b32", "#8b5fc7", "#d86b45", "#258e9e", "#6554c0", "#bb7757", "#4d9e9a", "#bc5a5a", "#19a7c7", "#7b8794"];
        const datasets = rows.map((row, index) => ({
            label: row.name,
            data: [{ x: row.rain, y: row.gust, r: 5 + Math.max(0, Math.min(100, row.probability ?? 0)) / 7, probability: row.probability }],
            backgroundColor: colors[index % colors.length] + "bb", borderColor: colors[index % colors.length], borderWidth: 1.5
        }));
        buildChart("riskBubble", "analyticsRiskBubbleChart", "analyticsRiskBubbleEmpty", "bubble", { datasets }, {
            plugins: { tooltip: { callbacks: { label(context) { const point = context.raw; return `${context.dataset.label}: ${number(point.x)} mm rain · ${number(point.y)} km/h gust · ${Number.isFinite(point.probability) ? `${number(point.probability, 0)}% precipitation probability` : "probability unavailable"}`; } } } },
            scales: {
                x: { type: "linear", beginAtZero: true, title: { display: true, text: "Rainfall in selected window (mm)" }, grid: { color: "rgba(130,145,160,.12)" } },
                y: { beginAtZero: true, title: { display: true, text: "Maximum gust in selected window (km/h)" }, grid: { color: "rgba(130,145,160,.12)" } }
            }
        });
    }

    function renderKPIs(records) {
        const rainValues = records.map(record => windowValue(record, "precipitation")).filter(Number.isFinite);
        const tempValues = records.map(record => currentValue(record, "temperature_2m")).filter(Number.isFinite);
        const humidityValues = records.map(record => currentValue(record, "relative_humidity_2m")).filter(Number.isFinite);
        const windValues = records.map(record => currentValue(record, "wind_speed_10m")).filter(Number.isFinite);
        const futureRain = records.map(record => dailyValue(record, "precipitation_sum", "max")).filter(Number.isFinite);
        const futureGust = records.map(record => dailyValue(record, "wind_gusts_10m_max", "max")).filter(Number.isFinite);
        const allLoaded = state.selectedMunicipality === "all" ? MUNICIPALITIES.length : 1;

        setText("analyticsRainfall", mean(rainValues) === null ? "—" : `${number(mean(rainValues))} mm`);
        setText("analyticsRainfallNote", isForecastWindow() ? "Mean forecast accumulation per available location" : "Mean accumulation per available location; model data");
        setText("analyticsTemperature", mean(tempValues) === null ? "—" : `${number(mean(tempValues))} °C`);
        setText("analyticsHumidity", mean(humidityValues) === null ? "—" : `${number(mean(humidityValues), 0)}%`);
        setText("analyticsWind", mean(windValues) === null ? "—" : `${number(mean(windValues))} km/h`);
        setText("analyticsPeakRain", maxValue(futureRain) === null ? "—" : `${number(maxValue(futureRain))} mm`);
        setText("analyticsPeakGust", maxValue(futureGust) === null ? "—" : `${number(maxValue(futureGust))} km/h`);
        setText("analyticsCoverage", `${records.length} / ${allLoaded} LGUs loaded`);
        setText("analyticsPeakRainNote", "Highest daily precipitation total among loaded locations");
        setText("analyticsPeakGustNote", "Highest daily maximum gust forecast among loaded locations");
    }

    function aggregateSeries(records, variable, resolution) {
        const buckets = new Map();
        records.forEach(record => {
            selectedHourly(record, variable).forEach(point => {
                const date = new Date(point.timestamp);
                const parts = localDateParts(date);
                const key = resolution === "daily"
                    ? `${parts.year}-${parts.month}-${parts.day}`
                    : `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push({ value: point.value, place: record.place.name });
            });
        });
        return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([time, values]) => {
            const nums = values.map(item => item.value);
            const aggregation = METRICS[variable]?.aggregation || "mean";
            // Do not sum rainfall from different LGUs. Sum each location's samples within a daily bucket,
            // then average those location totals for a province-wide daily rainfall series.
            let value;
            if (variable === "precipitation" && resolution === "daily") {
                const byPlace = new Map();
                values.forEach(item => byPlace.set(item.place, (byPlace.get(item.place) || 0) + item.value));
                value = mean([...byPlace.values()]);
            } else if (aggregation === "sum" && variable !== "precipitation") {
                const byPlace = new Map();
                values.forEach(item => byPlace.set(item.place, (byPlace.get(item.place) || 0) + item.value));
                value = mean([...byPlace.values()]);
            } else if (aggregation === "max") {
                value = maxValue(nums);
            } else {
                value = mean(nums);
            }
            return { time, value };
        }).filter(point => Number.isFinite(point.value));
    }

    function renderTrend(records) {
        const metric = state.metric;
        const definition = METRICS[metric] || METRICS.precipitation;
        const resolution = state.resolution;
        const series = aggregateSeries(records, metric, resolution);
        const title = `${definition.label} ${isForecastWindow() ? "forecast" : "trend"}`;
        setText("analyticsTrendTitle", title);
        setText("analyticsTrendDescription", `${periodLabel()} · Asia/Manila · province view averages available location values`);
        setText("analyticsTrendSub", metric === "precipitation"
            ? "Rainfall is averaged across available LGUs, not summed across the province."
            : "Series shows the mean of available representative model points.");
        setText("analyticsTrendUnit", definition.unit);
        const labels = series.map(point => {
            const timestamp = parseApiTime(point.time.includes("T") && point.time.length === 13 ? `${point.time}:00` : point.time);
            if (resolution === "daily") return point.time;
            return Number.isFinite(timestamp) ? formatLocalTime(timestamp, true) : point.time;
        });
        buildChart("trend", "analyticsTrendChart", "analyticsTrendEmpty", "line", {
            labels,
            datasets: [{
                label: `${definition.label} (${definition.unit})`,
                data: series.map(point => point.value),
                unit: definition.unit,
                borderColor: definition.color,
                backgroundColor: `${definition.color}22`,
                borderWidth: 2.5,
                pointRadius: series.length > 80 ? 0 : 2,
                pointHoverRadius: 5,
                fill: true,
                tension: 0.25,
                spanGaps: true
            }]
        }, {
            scales: { y: { title: { display: true, text: definition.unit }, beginAtZero: metric === "precipitation" || metric === "precipitation_probability" } },
            plugins: { legend: { display: false }, tooltip: { callbacks: { label(context) { return `${number(context.parsed.y)} ${definition.unit}`; } } } }
        });
    }

    function averageDailyAcrossRecords(variable, reducer = "mean") {
        const buckets = new Map();
        getSelectedRecords().forEach(record => {
            dailySeries(record, variable, true).forEach(point => {
                if (!buckets.has(point.time)) buckets.set(point.time, []);
                buckets.get(point.time).push(point.value);
            });
        });
        return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([time, values]) => ({
            time,
            value: reducer === "sum" ? mean(values) : reducer === "max" ? mean(values) : mean(values)
        }));
    }

    function renderDailyRain(records) {
        const buckets = new Map();
        records.forEach(record => dailySeries(record, "precipitation_sum", true).forEach(point => {
            if (!buckets.has(point.time)) buckets.set(point.time, []);
            buckets.get(point.time).push(point.value);
        }));
        const rows = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
        buildChart("dailyRain", "analyticsDailyRainChart", "analyticsDailyRainEmpty", "bar", {
            labels: rows.map(([day]) => day),
            datasets: [{ label: "Mean daily precipitation", data: rows.map(([, values]) => mean(values)), unit: "mm", backgroundColor: "#2878d0bb", borderColor: "#2878d0", borderWidth: 1, borderRadius: 5 }]
        }, { scales: { y: { beginAtZero: true, title: { display: true, text: "mm/day" } } }, plugins: { legend: { display: false } } });
    }

    function renderTemperature(records) {
        const buckets = new Map();
        records.forEach(record => {
            const daily = record.data.daily || {};
            (daily.time || []).forEach((day, index) => {
                if (day < localDateParts().year + "-" + localDateParts().month + "-" + localDateParts().day) return;
                if (!buckets.has(day)) buckets.set(day, { min: [], max: [] });
                const lo = Number(daily.temperature_2m_min?.[index]);
                const hi = Number(daily.temperature_2m_max?.[index]);
                if (Number.isFinite(lo)) buckets.get(day).min.push(lo);
                if (Number.isFinite(hi)) buckets.get(day).max.push(hi);
            });
        });
        const rows = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
        buildChart("temperature", "analyticsTemperatureChart", "analyticsTemperatureEmpty", "line", {
            labels: rows.map(([day]) => day),
            datasets: [
                { label: "Mean daily minimum", data: rows.map(([, values]) => mean(values.min)), unit: "°C", borderColor: "#2878d0", backgroundColor: "#2878d022", tension: 0.25, fill: false },
                { label: "Mean daily maximum", data: rows.map(([, values]) => mean(values.max)), unit: "°C", borderColor: "#e79b32", backgroundColor: "#e79b3222", tension: 0.25, fill: false }
            ]
        }, { scales: { y: { title: { display: true, text: "°C" } } } });
    }

    function renderWind(records) {
        const buckets = new Map();
        records.forEach(record => {
            const daily = record.data.daily || {};
            (daily.time || []).forEach((day, index) => {
                if (day < localDateParts().year + "-" + localDateParts().month + "-" + localDateParts().day) return;
                if (!buckets.has(day)) buckets.set(day, { wind: [], gust: [] });
                const wind = Number(daily.wind_speed_10m_max?.[index]);
                const gust = Number(daily.wind_gusts_10m_max?.[index]);
                if (Number.isFinite(wind)) buckets.get(day).wind.push(wind);
                if (Number.isFinite(gust)) buckets.get(day).gust.push(gust);
            });
        });
        const rows = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
        buildChart("wind", "analyticsWindChart", "analyticsWindEmpty", "bar", {
            labels: rows.map(([day]) => day),
            datasets: [
                { label: "Mean max wind", data: rows.map(([, v]) => mean(v.wind)), unit: "km/h", backgroundColor: "#19a7c7bb", borderRadius: 4 },
                { label: "Mean max gust", data: rows.map(([, v]) => mean(v.gust)), unit: "km/h", backgroundColor: "#6554c0bb", borderRadius: 4 }
            ]
        }, { scales: { y: { beginAtZero: true, title: { display: true, text: "km/h" } } } });
    }

    function renderAtmosphere(records) {
        const specs = [
            ["Humidity", "relative_humidity_2m", "%", "#169b78"],
            ["Cloud cover", "cloud_cover", "%", "#7b8794"],
            ["Sea-level pressure", "pressure_msl", "hPa", "#8b5fc7"]
        ];
        const rows = specs.map(([label, key, unit, color]) => ({
            label, unit, color, value: mean(records.map(record => currentValue(record, key)).filter(Number.isFinite))
        })).filter(row => Number.isFinite(row.value));
        buildChart("atmosphere", "analyticsAtmosphereChart", "analyticsAtmosphereEmpty", "bar", {
            labels: rows.map(row => row.label),
            datasets: [{ label: "Mean current value", data: rows.map(row => row.value), unit: "", backgroundColor: rows.map(row => row.color), borderRadius: 5 }]
        }, {
            scales: { y: { beginAtZero: false, title: { display: true, text: "Native units vary by variable" } } },
            plugins: { legend: { display: false }, tooltip: { callbacks: { label(context) { const row = rows[context.dataIndex]; return `${number(context.parsed.y)} ${row.unit}`; } } } }
        });
    }

    function renderComparison(records) {
        const metric = state.metric;
        const definition = METRICS[metric] || METRICS.precipitation;
        const rows = records.map(record => ({ name: record.place.name, value: windowValue(record, metric) }))
            .filter(row => Number.isFinite(row.value)).sort((a, b) => b.value - a.value);
        buildChart("comparison", "analyticsComparisonChart", "analyticsComparisonEmpty", "bar", {
            labels: rows.map(row => row.name),
            datasets: [{ label: `${definition.label} (${definition.unit})`, data: rows.map(row => row.value), unit: definition.unit, backgroundColor: rows.map((_, index) => index === 0 ? definition.color : `${definition.color}99`), borderRadius: 4 }]
        }, {
            indexAxis: "y",
            scales: { x: { beginAtZero: metric === "precipitation" || metric === "precipitation_probability", title: { display: true, text: definition.unit } }, y: { grid: { display: false }, ticks: { autoSkip: false } } },
            plugins: { legend: { display: false }, tooltip: { callbacks: { label(context) { return `${number(context.parsed.x)} ${definition.unit}`; } } } }
        });
    }

    function renderSolar(records) {
        const buckets = new Map();
        records.forEach(record => {
            const daily = record.data.daily || {};
            (daily.time || []).forEach((day, index) => {
                if (day < localDateParts().year + "-" + localDateParts().month + "-" + localDateParts().day) return;
                if (!buckets.has(day)) buckets.set(day, { radiation: [], uv: [] });
                const radiation = Number(daily.shortwave_radiation_sum?.[index]);
                const uv = Number(daily.uv_index_max?.[index]);
                if (Number.isFinite(radiation)) buckets.get(day).radiation.push(radiation);
                if (Number.isFinite(uv)) buckets.get(day).uv.push(uv);
            });
        });
        const rows = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
        buildChart("solar", "analyticsSolarChart", "analyticsSolarEmpty", "line", {
            labels: rows.map(([day]) => day),
            datasets: [
                { label: "Shortwave radiation sum", data: rows.map(([, v]) => mean(v.radiation)), unit: "MJ/m²", borderColor: "#d6a32b", backgroundColor: "#d6a32222", tension: 0.2, yAxisID: "y" },
                { label: "Maximum UV index", data: rows.map(([, v]) => mean(v.uv)), unit: "index", borderColor: "#bc5a5a", backgroundColor: "#bc5a5a22", tension: 0.2, yAxisID: "y1" }
            ]
        }, { scales: {
            y: { position: "left", title: { display: true, text: "MJ/m²" } },
            y1: { position: "right", title: { display: true, text: "UV index" }, grid: { drawOnChartArea: false }, beginAtZero: true }
        } });
    }

    function renderSoil(records) {
        const vars = [
            ["0–1 cm", "soil_moisture_0_to_1cm"], ["1–3 cm", "soil_moisture_1_to_3cm"],
            ["3–9 cm", "soil_moisture_3_to_9cm"], ["9–27 cm", "soil_moisture_9_to_27cm"],
            ["27–81 cm", "soil_moisture_27_to_81cm"]
        ];
        const rows = vars.map(([label, key]) => ({ label, value: mean(records.flatMap(record => selectedHourly(record, key).map(point => point.value))) }));
        buildChart("soil", "analyticsSoilChart", "analyticsSoilEmpty", "bar", {
            labels: rows.map(row => row.label),
            datasets: [{ label: "Mean modelled soil moisture", data: rows.map(row => row.value), unit: "m³/m³", backgroundColor: ["#2e6e45bb", "#3b8053bb", "#55956bbb", "#78a883bb", "#9ac0a5bb"], borderRadius: 4 }]
        }, { scales: { y: { beginAtZero: true, title: { display: true, text: "m³/m³" } } }, plugins: { legend: { display: false } } });
    }

    function renderRanking(records) {
        const container = $("#analyticsRanking");
        const metric = state.metric;
        const definition = METRICS[metric] || METRICS.precipitation;
        const rows = records.map(record => ({ name: record.place.name, value: windowValue(record, metric) }))
            .filter(row => Number.isFinite(row.value)).sort((a, b) => b.value - a.value);
        setText("analyticsRankingDescription", `${definition.label}: ${periodLabel().toLowerCase()}. Values are per representative location.`);
        if (!rows.length) {
            container.innerHTML = `<div class="analytics-empty">No comparable data is available for this selection.</div>`;
            return;
        }
        const max = Math.max(...rows.map(row => row.value), 0);
        container.innerHTML = rows.map((row, index) => {
            const width = max > 0 ? Math.max(0, row.value / max * 100) : 0;
            return `<div class="analytics-ranking-row"><span class="analytics-ranking-rank">${index + 1}</span><span class="analytics-ranking-name" title="${escapeHTML(row.name)}">${escapeHTML(row.name)}</span><div class="analytics-ranking-track" aria-label="${escapeHTML(row.name)}"><div class="analytics-ranking-fill" style="width:${width}%;background:${definition.color}"></div></div><span class="analytics-ranking-value">${escapeHTML(formatMetric(row.value, metric))}</span></div>`;
        }).join("");
    }

    function currentWeatherLabel(record) {
        const code = currentValue(record, "weather_code");
        return code === null ? "Unavailable" : (WEATHER_CODES[Math.round(code)] || `Weather code ${code}`);
    }

    function renderTable(records) {
        const body = $("#analyticsTableBody");
        const places = state.selectedMunicipality === "all" ? MUNICIPALITIES : MUNICIPALITIES.filter(place => place.name === state.selectedMunicipality);
        body.innerHTML = places.map(place => {
            const record = state.records.get(place.name);
            if (!record) {
                return `<tr><td>${escapeHTML(place.name)}</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>${escapeHTML(state.errors.get(place.name) || "Loading")}</td></tr>`;
            }
            const current = record.data.current || {};
            const temp = currentValue(record, "temperature_2m");
            const feels = currentValue(record, "apparent_temperature");
            const humidity = currentValue(record, "relative_humidity_2m");
            const wind = currentValue(record, "wind_speed_10m");
            const gust = currentValue(record, "wind_gusts_10m");
            const cloud = currentValue(record, "cloud_cover");
            const pressure = currentValue(record, "pressure_msl");
            const rain = windowValue(record, "precipitation");
            const dailyRain = dailyValue(record, "precipitation_sum", "max");
            return `<tr><td>${escapeHTML(place.name)}</td><td>${escapeHTML(currentWeatherLabel(record))}</td><td>${temp === null ? "—" : `${number(temp)} °C`}</td><td>${feels === null ? "—" : `${number(feels)} °C`}</td><td>${humidity === null ? "—" : `${number(humidity, 0)}%`}</td><td>${rain === null ? "—" : `${number(rain)} mm`}</td><td>${dailyRain === null ? "—" : `${number(dailyRain)} mm`}</td><td>${wind === null ? "—" : `${number(wind)} km/h`}</td><td>${gust === null ? "—" : `${number(gust)} km/h`}</td><td>${cloud === null ? "—" : `${number(cloud, 0)}%`}</td><td>${pressure === null ? "—" : `${number(pressure, 0)} hPa`}</td><td><span class="analytics-table-status">Loaded</span></td></tr>`;
        }).join("");
    }

    function renderInsights(records) {
        const container = $("#analyticsInsights");
        const rain = records.map(record => ({ name: record.place.name, value: windowValue(record, "precipitation") })).filter(row => Number.isFinite(row.value)).sort((a, b) => b.value - a.value);
        const gusts = records.map(record => ({ name: record.place.name, value: dailyValue(record, "wind_gusts_10m_max", "max") })).filter(row => Number.isFinite(row.value)).sort((a, b) => b.value - a.value);
        const probs = records.map(record => ({ name: record.place.name, value: dailyValue(record, "precipitation_probability_max", "max") })).filter(row => Number.isFinite(row.value)).sort((a, b) => b.value - a.value);
        const humid = mean(records.map(record => currentValue(record, "relative_humidity_2m")).filter(Number.isFinite));
        const cards = [];
        if (rain.length) cards.push({ title: "Rainfall signal", value: `${rain[0].name} · ${number(rain[0].value)} mm`, note: `Highest location-specific accumulation for ${periodLabel().toLowerCase()}. This is a weather signal, not confirmation of inundation.`, tone: "blue" });
        if (probs.length) cards.push({ title: "Precipitation probability", value: `${probs[0].name} · ${number(probs[0].value, 0)}%`, note: "Highest daily maximum precipitation probability among loaded locations.", tone: "purple" });
        if (gusts.length) cards.push({ title: "Wind gust outlook", value: `${gusts[0].name} · ${number(gusts[0].value)} km/h`, note: "Highest daily maximum gust forecast. Check official advisories for operational decisions.", tone: "orange" });
        if (humid !== null) cards.push({ title: "Humidity context", value: `${number(humid, 0)}% mean`, note: "Mean current relative humidity across loaded representative model points; humidity alone does not establish flood risk.", tone: "green" });
        if (!cards.length) {
            container.innerHTML = `<div class="analytics-empty">Insights will appear when weather data is available.</div>`;
            return;
        }
        container.innerHTML = cards.map(card => `<article class="analytics-insight-card" data-tone="${card.tone}"><div class="analytics-insight-title">${escapeHTML(card.title)}</div><div class="analytics-insight-value">${escapeHTML(card.value)}</div><p>${escapeHTML(card.note)}</p></article>`).join("");
    }

    function periodLabel() {
        return ({
            past24: "Previous 24 hours", past72: "Previous 72 hours", past168: "Previous 7 days",
            next24: "Next 24 hours", next72: "Next 72 hours", next168: "Next 7 days",
            all336: "Past 7 days + next 7 days"
        })[state.period] || "Previous 24 hours";
    }

    function render() {
        const root = getRoot();
        if (!root || !state.initialized) return;
        const records = getSelectedRecords();
        renderKPIs(records);
        renderTrend(records);
        renderDailyRain(records);
        renderTemperature(records);
        renderWind(records);
        renderAtmosphere(records);
        renderRanking(records);
        renderComparison(records);
        renderSolar(records);
        renderSoil(records);
        renderTable(records);
        renderInsights(records);
        renderRainHeatmap();
        renderMeteogram();
        renderRiskBubble(records);

        if (state.lastUpdated) {
            setText("analyticsUpdated", `Updated ${new Intl.DateTimeFormat("en-PH", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }).format(state.lastUpdated)} · Asia/Manila`);
        }
        const expected = state.selectedMunicipality === "all" ? MUNICIPALITIES.length : 1;
        if (state.errors.size > 0) {
            setStatus(`${records.length} of ${expected} selected location(s) loaded; ${state.errors.size} request(s) failed. Missing data is shown as unavailable, not zero.`, "warning");
        } else if (records.length) {
            setStatus(`Weather data loaded for ${records.length} selected location(s). ${isForecastWindow() ? "Forecast window selected." : "Historical portion is recent model data, not necessarily station observation."} Source: Open-Meteo.`, "success");
        } else {
            setStatus("No weather data is currently available. Check your connection and refresh.", "error");
        }
    }

    async function loadData(force = false) {
        if (state.loading && !force) return;
        const root = getRoot();
        if (!root) return;

        if (state.controller) state.controller.abort();
        const controller = new AbortController();
        state.controller = controller;
        const requestId = ++state.requestId;
        state.loading = true;
        state.errors.clear();

        const refresh = $("#analyticsRefresh");
        if (refresh) { refresh.disabled = true; refresh.textContent = "Loading…"; }
        setStatus("Requesting hourly, daily and current weather variables for the 12 Bataan LGUs…", "loading");

        const queue = [...MUNICIPALITIES];
        const workers = Array.from({ length: REQUEST_CONCURRENCY }, async () => {
            while (queue.length && requestId === state.requestId) {
                const place = queue.shift();
                try {
                    const record = await fetchMunicipality(place, controller.signal);
                    if (requestId !== state.requestId) return;
                    state.records.set(place.name, record);
                    state.errors.delete(place.name);
                } catch (error) {
                    if (requestId !== state.requestId) return;
                    if (error.name !== "AbortError") state.errors.set(place.name, error.message || "Request failed");
                }
            }
        });

        try {
            await Promise.all(workers);
            if (requestId !== state.requestId) return;
            state.lastUpdated = new Date();
            render();
        } finally {
            if (requestId === state.requestId) {
                state.loading = false;
                if (refresh) { refresh.disabled = false; refresh.textContent = "↻ Refresh data"; }
            }
        }
    }

    function initialize() {
        if (state.initialized) return;
        const root = getRoot();
        if (!root) return;
        state.initialized = true;
        mountDashboard(root);
        loadData();
        if (state.refreshTimer) clearInterval(state.refreshTimer);
        state.refreshTimer = setInterval(() => {
            if (document.visibilityState !== "hidden") loadData();
        }, REFRESH_MS);
    }

    function onViewChange(event) {
        if (event?.detail?.view !== "analytics") return;
        if (!state.initialized) initialize();
        else if (!state.records.size) loadData();
        else render();
    }

    window.AGOSAnalytics = {
        update: render,
        refresh: () => loadData(true),
        getStatus: () => ({ loaded: state.records.size, failed: state.errors.size, lastUpdated: state.lastUpdated, timezone: TIMEZONE }),
        municipalities: MUNICIPALITIES.map(place => ({ ...place })),
        visualizationStatus: () => ({ echartsLoaded: !!window.echarts, newCharts: ["rainfall heatmap", "selected-LGU meteogram", "rainfall-vs-gust bubble chart"] })
    };

    document.addEventListener("agos:viewchange", onViewChange);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
})();
