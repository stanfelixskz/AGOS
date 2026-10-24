import { test } from "node:test";
import assert from "node:assert/strict";
import { getJSON, ApiError, clearApiCache } from "../js/core/api.js";

function fakeFetch(handler) {
  let calls = 0;
  const impl = async (url, options) => {
    calls += 1;
    return handler(url, options);
  };
  return { impl, calls: () => calls };
}

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("returns parsed JSON", async () => {
  clearApiCache();
  const f = fakeFetch(() => json({ a: 1 }));
  assert.deepEqual(await getJSON("/x", { fetchImpl: f.impl }), { a: 1 });
});

test("network failure is an offline error", async () => {
  const f = fakeFetch(() => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(getJSON("/offline", { fetchImpl: f.impl }), (error) => error instanceof ApiError && error.kind === "offline");
});

test("HTTP error keeps the backend detail", async () => {
  const f = fakeFetch(() => json({ detail: "Unknown municipality: X" }, 404));
  await assert.rejects(getJSON("/bad", { fetchImpl: f.impl }), (error) => error.kind === "http" && error.status === 404 && /Unknown municipality/.test(error.message));
});

test("timeout becomes a timeout error", async () => {
  const impl = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  await assert.rejects(getJSON("/slow", { fetchImpl: impl, timeoutMs: 20 }), (error) => error.kind === "timeout");
});

test("ttl cache avoids a second request", async () => {
  clearApiCache();
  const f = fakeFetch(() => json({ n: 1 }));
  await getJSON("/cached", { fetchImpl: f.impl, ttlMs: 10000 });
  await getJSON("/cached", { fetchImpl: f.impl, ttlMs: 10000 });
  assert.equal(f.calls(), 1);
});
