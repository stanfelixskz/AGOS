import { test } from "node:test";
import assert from "node:assert/strict";
import { STRINGS, t } from "../js/core/i18n.js";

test("every English key has a Filipino translation and vice versa", () => {
  const en = Object.keys(STRINGS.en).sort();
  const fil = Object.keys(STRINGS.fil).sort();
  assert.deepEqual(fil, en);
  for (const key of en) assert.ok(STRINGS.fil[key].trim(), `empty fil text for ${key}`);
});

test("placeholders are kept in both languages", () => {
  for (const key of Object.keys(STRINGS.en)) {
    const names = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(names(STRINGS.fil[key]), names(STRINGS.en[key]), key);
  }
});

test("t fills placeholders and falls back to the key", () => {
  assert.equal(t("nav.map", {}, "fil"), "Mapa");
  assert.equal(t("no.such.key"), "no.such.key");
});
