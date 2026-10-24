
(function () {
    "use strict";

    const VIEW_CONFIG = {
        dashboard: {
            title: "Flood Monitoring & Forecast",
            subtitle: "Bataan conditions and monitoring overview."
        },
        map: {
            title: "Flood Map",
            subtitle: "Explore flood evidence, candidate zones, and evacuation resources."
        },
        analytics: {
            title: "Analytics",
            subtitle: "Review available evidence and candidate-zone summaries."
        },
        reports: {
            title: "Reports",
            subtitle: "Submit and review flood-related reports."
        },
        evacuation: {
            title: "Evacuation Centers",
            subtitle: "Review available evacuation-center records."
        },
        system: {
            title: "About AGOS",
            subtitle: "System scope, data sources, and interpretation."
        }
    };

    let currentView = "dashboard";
    let evidenceVisible = true;

    const VALID_MAP_ACTIONS = new Set([
        "evidence",
        "risk",
        "centers",
        "reports"
    ]);

    const MAP_LAYER_GROUPS = {
        evidence: "evidence",
        risk: "candidate",
        centers: "evacuation"
    };

    function getElement(id) {
        return document.getElementById(id);
    }

    function safeCall(callback) {
        try {
            if (typeof callback === "function") {
                return callback();
            }
        } catch (error) {
            console.warn("AGOS action failed:", error);
        }

        return null;
    }

    function setSystemStatus(message) {
        const status = getElement("systemStatus");

        if (status) {
            status.textContent = message;
        }

        console.info("AGOS:", message);
    }

    function getMapAPI() {
        return window.AGOSMap || null;
    }

    function resizeMap() {
        const agosMap = getMapAPI();

        if (!agosMap) {
            return;
        }

        if (typeof agosMap.invalidateSize === "function") {
            safeCall(() => agosMap.invalidateSize());
            return;
        }

        if (typeof agosMap.getMap === "function") {
            const map = agosMap.getMap();

            if (map && typeof map.resize === "function") {
                safeCall(() => map.resize());
            }
        }
    }

    function showView(viewName) {
        if (!VIEW_CONFIG[viewName]) {
            console.warn("AGOS: Unknown view:", viewName);
            return;
        }

        /*
         * Navigation in index.html owns the actual view
         * visibility and dispatches agos:viewchange.
         * Request navigation through that existing handler.
         */
        document.dispatchEvent(
            new CustomEvent("agos:navigate", {
                detail: { view: viewName }
            })
        );
    }

    function setupViewEvents() {
        document.addEventListener("agos:viewchange", function (event) {
            const viewName = event.detail && event.detail.view;

            if (!VIEW_CONFIG[viewName]) {
                return;
            }

            currentView = viewName;

            if (viewName === "map") {
                requestAnimationFrame(resizeMap);
            }

            if (viewName === "analytics") {
                /*
                 * Analytics.js also listens for this event.
                 * Avoid calling its update method a second time.
                 */
                if (
                    window.AGOSAnalytics &&
                    typeof window.AGOSAnalytics.update === "function"
                ) {
                    safeCall(() => window.AGOSAnalytics.update());
                }
            }

            if (viewName === "reports") {
                document.dispatchEvent(
                    new CustomEvent("agos:reports-view-opened")
                );
            }

            const config = VIEW_CONFIG[viewName];

            const title = getElement("pageTitle");
            const subtitle = getElement("pageSubtitle");

            if (title) {
                title.textContent = config.title;
            }

            if (subtitle) {
                subtitle.textContent = config.subtitle;
            }
        });
    }

    function setupMapActions() {
        const fitButton = getElement("mapFitBataan");
        const evidenceButton = getElement("mapHeatmapToggle");

        if (fitButton) {
            fitButton.addEventListener("click", function () {
                const agosMap = getMapAPI();

                if (
                    agosMap &&
                    typeof agosMap.fitBataan === "function"
                ) {
                    safeCall(() => agosMap.fitBataan());
                } else {
                    console.warn(
                        "AGOS: The map fit function is not available yet."
                    );
                }
            });
        }

        if (evidenceButton) {
            evidenceButton.addEventListener("click", function () {
                const agosMap = getMapAPI();

                if (
                    !agosMap ||
                    typeof agosMap.setLayerVisibility !== "function"
                ) {
                    setSystemStatus("Map layers are not ready yet.");
                    return;
                }

                const nextVisibility = !evidenceVisible;

                const changed = agosMap.setLayerVisibility(
                    "evidence",
                    nextVisibility
                );

                if (changed === false) {
                    setSystemStatus(
                        "The evidence layer is not available."
                    );
                    return;
                }

                evidenceVisible = nextVisibility;

                evidenceButton.textContent = evidenceVisible
                    ? "Hide evidence"
                    : "Show evidence";

                evidenceButton.setAttribute(
                    "aria-pressed",
                    String(evidenceVisible)
                );
            });
        }
    }

    function setupMapControls() {
        document.querySelectorAll(".map-control").forEach(function (button) {
            button.addEventListener("click", function () {
                const action = button.dataset.action;

                if (!VALID_MAP_ACTIONS.has(action)) {
                    return;
                }

                const agosMap = getMapAPI();

                /*
                 * Toggle the requested layer group without
                 * confusing candidate zones with observations.
                 */
                const layerName = MAP_LAYER_GROUPS[action];

                if (
                    layerName &&
                    agosMap &&
                    typeof agosMap.setLayerVisibility === "function"
                ) {
                    const wasActive = button.classList.contains("active");
                    const visible = !wasActive;

                    const changed = agosMap.setLayerVisibility(
                        layerName,
                        visible
                    );

                    if (changed === false) {
                        setSystemStatus(
                            "That map layer is not available."
                        );
                        return;
                    }
                }

                /*
                 * Reports are a separate data category.
                 * Do not show them as flood observations.
                 */
                document.querySelectorAll(".map-control").forEach(
                    function (item) {
                        item.classList.remove("active");
                    }
                );

                button.classList.add("active");

                document.dispatchEvent(
                    new CustomEvent("agos:map-control", {
                        detail: { action: action }
                    })
                );
            });
        });
    }

    function setupDataEvents() {
        document.addEventListener("agos:data-ready", function () {
            setSystemStatus("Map data loading completed.");
        });

        document.addEventListener("agos:data-error", function (event) {
            const detail = event.detail;

            setSystemStatus(
                detail && detail.message
                    ? "Data loading issue: " + detail.message
                    : "Some datasets could not be loaded."
            );
        });

        document.addEventListener("agos:assessment-ready", function () {
            setSystemStatus("An assessment-ready event was received.");
        });
    }

    function setupMapReadiness() {
        /*
         * Map initialization is handled by map.js.
         * Do not initialize a second map here.
         */
        const agosMap = getMapAPI();

        if (agosMap) {
            setSystemStatus("Map module detected.");
        } else {
            setSystemStatus(
                "Waiting for the map module to initialize."
            );
        }
    }

    function initialize() {
        setupViewEvents();
        setupMapActions();
        setupMapControls();
        setupDataEvents();
        setupMapReadiness();

        /*
         * The inline navigation handler in index.html
         * already activates the Dashboard initially.
         */
        currentView = "dashboard";
    }

    window.AGOSApp = {
        showView: showView,

        getCurrentView: function () {
            return currentView;
        },

        setSystemStatus: setSystemStatus,

        resizeMap: resizeMap
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize, {
            once: true
        });
    } else {
        initialize();
    }
})();
