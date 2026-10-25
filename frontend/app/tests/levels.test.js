import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { THRESHOLDS, levelFor, LEVELS } from "../js/core/levels.js";

const python = readFileSync(new URL("../../../backend/app/services/overview_service.py", import.meta.url), "utf8");
const css = readFileSync(new URL("../css/agos.css", import.meta.url), "utf8");
const pyNumber = (name) => Number(python.match(new RegExp(`^${name} = ([0-9.]+)`, "m"))[1]);

test("JS thresholds match the backend", () => {
  assert.equal(THRESHOLDS.yellow, pyNumber("YELLOW_MM_H"));
  assert.equal(THRESHOLDS.orange, pyNumber("ORANGE_MM_H"));
  assert.equal(THRESHOLDS.redAbove, pyNumber("RED_ABOVE_MM_H"));
  assert.equal(THRESHOLDS.lightRain, pyNumber("LIGHT_RAIN_MM_H"));
});

test("boundaries follow PAGASA intensity criteria", () => {
  const cases = [[null, "nodata"], [0, "little"], [1, "rain"], [7.49, "rain"], [7.5, "yellow"], [15, "orange"], [30, "orange"], [30.1, "red"]];
  for (const [mm, level] of cases) assert.equal(levelFor(mm), level, String(mm));
});

test("CSS level colors match the level registry", () => {
  for (const id of ["little", "rain", "yellow", "orange", "red", "nodata"]) {
    const m = css.match(new RegExp(`--level-${id}: (#[0-9a-f]{6});`));
    assert.ok(m, `--level-${id} missing`);
    assert.equal(m[1], LEVELS[id].color, id);
  }
});
