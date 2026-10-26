import { test } from "node:test";
import assert from "node:assert/strict";
import { weatherIcon, conditionLabel, CONDITIONS } from "../js/core/weather-icons.js";
import { STRINGS, setLang } from "../js/core/i18n.js";

test("every condition has an icon and a label in English and Filipino", () => {
  for (const c of CONDITIONS) {
    assert.match(weatherIcon(c, true), /^<svg class="wx-icon"/, c);
    assert.ok(STRINGS.en[`wx.${c}`] && STRINGS.fil[`wx.${c}`], c);
  }
});

test("night uses the moon for clear and partly cloudy skies", () => {
  assert.match(weatherIcon("clear", false), /wx-moon/);
  assert.doesNotMatch(weatherIcon("clear", false), /wx-sun/);
  assert.match(weatherIcon("clear", true), /wx-sun/);
  assert.equal(conditionLabel("clear", false), "Clear night");
  assert.equal(conditionLabel("rain", false), "Rain");
});

test("every moon gets its own mask id", () => {
  const ids = [weatherIcon("clear", false), weatherIcon("partly_cloudy", false)].map((svg) => svg.match(/mask id="([^"]+)"/)[1]);
  assert.notEqual(ids[0], ids[1]);
});

test("unknown conditions fall back safely", () => {
  assert.match(weatherIcon("tornado", true), /stroke-dasharray/);
  setLang("en");
  assert.equal(conditionLabel("tornado"), "No data");
});
