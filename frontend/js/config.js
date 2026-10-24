/*
 * AGOS — frontend runtime configuration
 *
 * This is the ONLY place the backend address is set. Every other script
 * reads window.AGOS_CONFIG.apiBase (no trailing slash).
 *
 * Local development (page opened from localhost, 127.0.0.1 or file://):
 *   the backend is expected at http://127.0.0.1:8000
 *
 * Deployment:
 *   set DEPLOYED_API_BASE below to the public backend URL, for example
 *   "https://agos-api.example.com". Leave it empty ("") when the backend
 *   serves this frontend from the same origin.
 */
(function () {
  "use strict";

  const LOCAL_API_BASE = "http://127.0.0.1:8000";
  const DEPLOYED_API_BASE = "";

  const hostname = window.location.hostname;
  const isLocal =
    window.location.protocol === "file:" ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";

  const apiBase = (isLocal ? LOCAL_API_BASE : DEPLOYED_API_BASE)
    .trim()
    .replace(/\/+$/, "");

  window.AGOS_CONFIG = Object.freeze({
    apiBase,
    isLocal,
  });
})();
