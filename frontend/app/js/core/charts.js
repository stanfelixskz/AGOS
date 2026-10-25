/*
 * Small SVG charts (no library). Theme colors come from CSS variables.
 * Each bar/point has a <title> so values are readable on hover and by
 * screen readers. Missing values are drawn as gaps, never as 0.
 */

import { escapeHTML, isNumber } from "./format.js";


function niceMax(value) {
  if (!isNumber(value) || value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const n = value / exp;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * exp;
}

/**
 * Bar chart.
 * bars: [{ label, value, color?, title? }]
 * options: { height, unit, ariaLabel, xLabelEvery, guides: [{ value, label, color }] }
 */
export function barChart(bars, options = {}) {
  const { width: W = 640, height = 160, unit = "", ariaLabel = "Chart", xLabelEvery = 6, guides = [], minMax = 0, showLabel = null } = options;
  const padL = 34, padR = 8, padT = 20, padB = 24;
  const innerW = W - padL - padR;
  const innerH = height - padT - padB;
  const values = bars.map((b) => b.value).filter(isNumber);
  const max = niceMax(Math.max(minMax, ...values, ...guides.map((g) => g.value).filter((v) => v <= Math.max(minMax, ...values) * 1.5)));
  const slot = innerW / Math.max(1, bars.length);
  const barW = Math.max(1.5, slot * 0.72);
  const y = (v) => padT + innerH - (Math.min(v, max) / max) * innerH;

  const grid = [0, 0.5, 1].map((f) => {
    const v = max * f;
    const yy = y(v);
    return `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" class="chart-grid"/>
      <text x="${padL - 6}" y="${yy + 4}" text-anchor="end" class="chart-axis">${escapeHTML(Number(v.toFixed(v < 10 ? 1 : 0)).toString())}</text>`;
  }).join("");

  const guideLines = guides.filter((g) => g.value <= max).map((g) => `
    <line x1="${padL}" x2="${W - padR}" y1="${y(g.value)}" y2="${y(g.value)}" stroke="${g.color}" stroke-dasharray="4 4" stroke-width="1.2"/>
    <text x="${W - padR}" y="${y(g.value) - 3}" text-anchor="end" class="chart-axis" fill="${g.color}">${escapeHTML(g.label)}</text>`).join("");

  const rects = bars.map((b, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const tip = escapeHTML(b.title || `${b.label}: ${isNumber(b.value) ? `${b.value} ${unit}` : "no data"}`);
    if (!isNumber(b.value)) {
      return `<g><title>${tip}</title><rect x="${x}" y="${padT + innerH - 2}" width="${barW}" height="2" class="chart-missing"/></g>`;
    }
    const top = y(b.value);
    const h = Math.max(b.value > 0 ? 1.5 : 0.5, padT + innerH - top);
    return `<g><title>${tip}</title><rect x="${x}" y="${padT + innerH - h}" width="${barW}" height="${h}" rx="${Math.min(3, barW / 3)}" fill="${b.color || "var(--brand)"}"/></g>`;
  }).join("");

  const labels = bars.map((b, i) => ((showLabel ? showLabel(i, b) : i % xLabelEvery === 0)
    ? `<text x="${padL + i * slot + slot / 2}" y="${height - 6}" text-anchor="middle" class="chart-axis">${escapeHTML(b.label)}</text>`
    : "")).join("");

  return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${escapeHTML(ariaLabel)}" width="${W}" height="${height}">
    ${grid}${guideLines}${rects}${labels}
    ${unit ? `<text x="4" y="11" class="chart-axis">${escapeHTML(unit)}</text>` : ""}
  </svg>`;
}

/**
 * Line chart with optional band (e.g. p25–p75).
 * series: [{ label, value, low?, high? }]
 */
export function lineChart(points, options = {}) {
  const { width: W = 640, height = 160, unit = "", ariaLabel = "Chart", xLabelEvery = 1, color = "var(--brand)" } = options;
  const padL = 40, padR = 10, padT = 20, padB = 24;
  const innerW = W - padL - padR;
  const innerH = height - padT - padB;
  const all = points.flatMap((p) => [p.value, p.low, p.high]).filter(isNumber);
  const max = niceMax(Math.max(...all, 0));
  const n = Math.max(1, points.length - 1);
  const x = (i) => padL + (i / n) * innerW;
  const y = (v) => padT + innerH - (v / max) * innerH;

  const grid = [0, 0.5, 1].map((f) => {
    const v = max * f;
    return `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="chart-grid"/>
      <text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" class="chart-axis">${escapeHTML(Number(v.toFixed(v < 10 ? 1 : 0)).toString())}</text>`;
  }).join("");

  const bandPts = points.map((p, i) => (isNumber(p.low) && isNumber(p.high) ? [i, p.low, p.high] : null)).filter(Boolean);
  const band = bandPts.length > 1
    ? `<path d="M${bandPts.map(([i, , h]) => `${x(i)},${y(h)}`).join("L")}L${bandPts.reverse().map(([i, l]) => `${x(i)},${y(l)}`).join("L")}Z" fill="${color}" opacity=".14"/>`
    : "";

  // Break the line at missing values (gaps are honest).
  let d = "";
  let pen = false;
  points.forEach((p, i) => {
    if (!isNumber(p.value)) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x(i)},${y(p.value)}`;
    pen = true;
  });

  const dots = points.map((p, i) => (isNumber(p.value)
    ? `<g><title>${escapeHTML(`${p.label}: ${p.value} ${unit}`)}</title><circle cx="${x(i)}" cy="${y(p.value)}" r="3.2" fill="${color}"/></g>`
    : "")).join("");

  const labels = points.map((p, i) => (i % xLabelEvery === 0
    ? `<text x="${x(i)}" y="${height - 6}" text-anchor="middle" class="chart-axis">${escapeHTML(p.label)}</text>` : "")).join("");

  return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${escapeHTML(ariaLabel)}" width="${W}" height="${height}">
    ${grid}${band}<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" vector-effect="non-scaling-stroke"/>${dots}${labels}
    ${unit ? `<text x="4" y="11" class="chart-axis">${escapeHTML(unit)}</text>` : ""}
  </svg>`;
}

/**
 * Render a chart into el at its real width and re-render on resize, so text
 * is never stretched. render(width) must return SVG markup. Returns a cleanup.
 */
export function mountChart(el, render) {
  let last = 0;
  const draw = () => {
    const width = Math.max(240, Math.floor(el.clientWidth));
    if (width === last) return;
    last = width;
    el.innerHTML = render(width);
  };
  draw();
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(draw);
  observer.observe(el);
  return () => observer.disconnect();
}
