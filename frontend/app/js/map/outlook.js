/*
 * Flood outlook helpers for the map (pure functions, tested in node).
 *
 * The MGB flood-prone layer is a raster from the MGB server, so it cannot be
 * clipped to towns. Instead AGOS fades it with a translucent fill: one fill
 * per town that is not raised (feature-state "dim" on the town shapes) and one
 * fill for everything outside Bataan. This file builds that "outside" shape and
 * turns the /api/flood-factors answer into the rows the map needs.
 */

const KEY_DIGITS = 6;
const WORLD = [[100, -5], [150, -5], [150, 30], [100, 30], [100, -5]];

const key = (p) => `${p[0].toFixed(KEY_DIGITS)},${p[1].toFixed(KEY_DIGITS)}`;

/** Outer rings of every Polygon / MultiPolygon part. */
export function outerRings(features) {
  const rings = [];
  for (const f of features || []) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") rings.push(g.coordinates[0]);
    else if (g.type === "MultiPolygon") for (const poly of g.coordinates) rings.push(poly[0]);
  }
  return rings.filter((r) => Array.isArray(r) && r.length >= 4);
}

/**
 * The outline of all towns together: edges that two towns share (same two
 * points in opposite directions) cancel, and what is left is stitched into
 * rings. Needs neighbouring towns to share identical points, which is true for
 * the PSGC file in the repo. Returns [] when the shapes do not stitch up.
 */
export function unionOutline(features) {
  const edges = new Map();
  for (const ring of outerRings(features)) {
    for (let i = 0; i < ring.length - 1; i += 1) {
      const a = ring[i];
      const b = ring[i + 1];
      const ka = key(a);
      const kb = key(b);
      if (ka === kb) continue;
      const reverse = `${kb}|${ka}`;
      if (edges.has(reverse)) edges.delete(reverse);
      else edges.set(`${ka}|${kb}`, [a, b]);
    }
  }
  const byStart = new Map();
  for (const [id, edge] of edges) {
    const start = id.split("|")[0];
    if (!byStart.has(start)) byStart.set(start, []);
    byStart.get(start).push({ id, edge });
  }
  const used = new Set();
  const rings = [];
  for (const [firstId, first] of edges) {
    if (used.has(firstId)) continue;
    const ring = [first[0]];
    let current = { id: firstId, edge: first };
    const startKey = key(first[0]);
    let guard = edges.size + 2;
    while (current && guard-- > 0) {
      used.add(current.id);
      ring.push(current.edge[1]);
      const endKey = key(current.edge[1]);
      if (endKey === startKey) break;
      current = (byStart.get(endKey) || []).find((c) => !used.has(c.id));
    }
    if (ring.length >= 4 && key(ring[ring.length - 1]) === startKey) rings.push(ring);
  }
  return rings;
}

/**
 * One polygon covering everything except Bataan (the town outline is cut out as
 * holes). null when the outline could not be built or looks wrong (a handful of
 * rings is normal: the peninsula and a few islands).
 */
export function outsideMask(features, { maxRings = 12 } = {}) {
  const holes = unionOutline(features);
  if (!holes.length || holes.length > maxRings) return null;
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [WORLD, ...holes] } }] };
}

/** Towns the map should keep at full strength: [{ name, raised }] from the /api/flood-factors answer. */
export function outlookRows(factors) {
  if (factors?.status !== "ok") return [];
  return (factors.data?.towns || []).map((town) => ({ name: town.name, raised: town.state === "raised" }));
}

/** Names of raised towns, in the order the answer lists them (strongest rain first). */
export function raisedTowns(factors) {
  return factors?.status === "ok" ? factors.data?.raised || [] : [];
}
