/*
 * AGOS API client. Every call has a timeout and returns a clear error kind
 * so pages can say WHY data is missing instead of showing a blank.
 */

export class ApiError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind; // "offline" | "timeout" | "http" | "parse"
    this.status = status;
  }
}

export function apiBase() {
  const config = globalThis.window?.AGOS_CONFIG;
  return config && typeof config.apiBase === "string" ? config.apiBase : "http://127.0.0.1:8000";
}

export function apiUrl(path) {
  if (/^https?:\/\//.test(path)) return path;
  return `${apiBase()}${path.startsWith("/") ? "" : "/"}${path}`;
}

const inflight = new Map();
const cache = new Map();

/**
 * GET JSON. Identical concurrent requests share one fetch. Optional short
 * in-memory cache (ttlMs) so switching pages does not refetch everything.
 */
export async function getJSON(path, { timeoutMs = 20000, ttlMs = 0, fetchImpl = globalThis.fetch } = {}) {
  const url = apiUrl(path);
  const hit = cache.get(url);
  if (ttlMs > 0 && hit && Date.now() - hit.at < ttlMs) return hit.data;
  if (inflight.has(url)) return inflight.get(url);

  const task = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new ApiError("timeout", `The AGOS backend did not answer within ${Math.round(timeoutMs / 1000)} s.`);
      }
      throw new ApiError("offline", "Cannot reach the AGOS backend. Is it running?");
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      if (!response.ok) throw new ApiError("http", `Backend error ${response.status}.`, response.status);
      throw new ApiError("parse", "The backend sent a response that is not JSON.");
    }
    if (!response.ok) {
      const detail = typeof body?.detail === "string" ? body.detail : body?.detail?.message;
      throw new ApiError("http", detail || `Backend error ${response.status}.`, response.status);
    }
    if (ttlMs > 0) cache.set(url, { at: Date.now(), data: body });
    return body;
  })();

  inflight.set(url, task);
  try {
    return await task;
  } finally {
    inflight.delete(url);
  }
}

/** POST multipart form data (used by community reports). */
export async function postForm(path, formData, { timeoutMs = 30000, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(apiUrl(path), { method: "POST", body: formData, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new ApiError("timeout", "The upload took too long.");
    throw new ApiError("offline", "Cannot reach the AGOS backend. Is it running?");
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = Array.isArray(body?.detail)
      ? body.detail.map((item) => item.msg).join("; ")
      : typeof body?.detail === "string" ? body.detail : null;
    throw new ApiError("http", detail || `Backend error ${response.status}.`, response.status);
  }
  return body;
}

export function clearApiCache() {
  cache.clear();
}
