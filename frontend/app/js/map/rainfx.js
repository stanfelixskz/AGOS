/*
 * Rain animation: moving streaks inside each town's shape.
 *
 * Input is the model's rain rate (mm/h) for the hour shown. More and faster
 * streaks mean heavier rain. It is model output, not radar. The slant is
 * fixed on purpose: AGOS has no wind direction data, so none is drawn.
 *
 * One transparent canvas sits above the map and under the HTML markers. The
 * town outlines are projected to screen pixels only when the map moves; the
 * animation frames just redraw streaks clipped to those outlines.
 */

const MAX_PER_TOWN = 220;
const FRAME_MS = 1000 / 30;
const SLANT = 0.18; // pixels sideways per pixel fallen (constant, not wind)

/** Streaks per 10,000 px² and look, from the rain rate. Below 0.1 mm/h: none. */
export function intensity(mm) {
  if (typeof mm !== "number" || !Number.isFinite(mm) || mm < 0.1) return null;
  if (mm < 1) return { density: 1.2, speed: 280, length: 6, width: 1 };
  if (mm < 7.5) return { density: 3, speed: 380, length: 9, width: 1.1 };
  if (mm < 15) return { density: 6, speed: 520, length: 13, width: 1.3 };
  if (mm <= 30) return { density: 10, speed: 700, length: 17, width: 1.5 };
  return { density: 16, speed: 900, length: 22, width: 1.8 };
}

export function normName(name) {
  return String(name || "").toLowerCase().replace(/city of |city/g, "").trim();
}

function polygonsOf(feature) {
  const g = feature?.geometry;
  if (!g) return [];
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  return [];
}

export function createRainFx(map, { theme = "light", nameOf } = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "rainfx-canvas";
  canvas.setAttribute("aria-hidden", "true");
  map.getCanvasContainer().appendChild(canvas);
  const ctx = canvas.getContext("2d");

  let features = [];          // [{ key, polygons }]
  let rates = new Map();      // key -> mm/h
  let towns = [];             // projected: [{ key, path, box, drops, fx }]
  let enabled = false;
  let dirty = true;
  let raf = 0;
  let last = 0;
  let dpr = 1;
  let color = theme === "dark" ? "rgba(191, 219, 254, 0.8)" : "rgba(30, 64, 175, 0.6)";

  function resize() {
    const el = map.getCanvas();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(el.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(el.clientHeight * dpr));
    canvas.style.width = `${el.clientWidth}px`;
    canvas.style.height = `${el.clientHeight}px`;
    dirty = true;
  }

  /** Project the outlines to screen pixels (only when the map moved). */
  function rebuild() {
    dirty = false;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const previous = new Map(towns.map((town) => [town.key, town]));
    towns = [];
    for (const feature of features) {
      const fx = intensity(rates.get(feature.key));
      const path = new Path2D();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const polygon of feature.polygons) {
        for (const ring of polygon) {
          ring.forEach(([lng, lat], i) => {
            const p = map.project([lng, lat]);
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
            if (i === 0) path.moveTo(p.x, p.y);
            else path.lineTo(p.x, p.y);
          });
          path.closePath();
        }
      }
      // Only the part of the town that is on screen needs streaks.
      const box = { x: Math.max(0, minX), y: Math.max(0, minY), w: Math.min(width, maxX) - Math.max(0, minX), h: Math.min(height, maxY) - Math.max(0, minY) };
      if (!fx || box.w <= 4 || box.h <= 4) {
        towns.push({ key: feature.key, path, box, fx: null, drops: [] });
        continue;
      }
      const wanted = Math.min(MAX_PER_TOWN, Math.round((box.w * box.h * fx.density) / 10000));
      const drops = previous.get(feature.key)?.drops || [];
      while (drops.length < wanted) drops.push({ u: Math.random(), v: Math.random(), k: 0.75 + Math.random() * 0.5 });
      drops.length = wanted;
      towns.push({ key: feature.key, path, box, fx, drops });
    }
  }

  function frame(now) {
    raf = 0;
    if (!enabled || document.hidden) return;
    raf = requestAnimationFrame(frame);
    if (now - last < FRAME_MS) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (dirty) rebuild();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    for (const town of towns) {
      if (!town.fx || !town.drops.length) continue;
      const { box, fx } = town;
      ctx.save();
      ctx.clip(town.path, "evenodd");
      ctx.lineWidth = fx.width;
      ctx.beginPath();
      for (const d of town.drops) {
        d.v += (fx.speed * d.k * dt) / box.h;
        if (d.v > 1) {
          d.v -= 1;
          d.u = Math.random();
        }
        const x = box.x + d.u * box.w;
        const y = box.y + d.v * box.h;
        const len = fx.length * d.k;
        ctx.moveTo(x, y);
        ctx.lineTo(x - len * SLANT, y - len);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  function start() {
    if (enabled && !raf && !document.hidden) raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  const markDirty = () => { dirty = true; };
  map.on("move", markDirty);
  map.on("resize", resize);
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener("visibilitychange", onVisibility);
  resize();

  return {
    canvas,
    /** GeoJSON FeatureCollection of town outlines. */
    setGeometry(collection) {
      features = (collection?.features || []).map((f) => ({ key: normName(nameOf ? nameOf(f) : f.properties?.name), polygons: polygonsOf(f) }));
      dirty = true;
    },
    /** rows: [{ name, mm }] — mm is the rain rate for the hour shown. */
    setRates(rows) {
      rates = new Map((rows || []).map((row) => [normName(row.name), row.mm]));
      dirty = true;
    },
    setEnabled(on) {
      enabled = Boolean(on);
      canvas.style.display = enabled ? "" : "none";
      if (enabled) {
        resize();
        start();
      } else {
        stop();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    },
    setTheme(name) {
      color = name === "dark" ? "rgba(191, 219, 254, 0.8)" : "rgba(30, 64, 175, 0.6)";
    },
    /** For tests: how many streaks each town has right now. */
    counts() {
      return Object.fromEntries(towns.map((town) => [town.key, town.drops.length]));
    },
    destroy() {
      stop();
      map.off("move", markDirty);
      map.off("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.remove();
    },
  };
}
