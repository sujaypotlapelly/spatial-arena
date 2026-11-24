#!/usr/bin/env node
// Build a benchmark map (the same format as sim/maps/factory-full.json) from a
// SuperSplat v1.1 collider: a dense occupancy grid, an altitude geofence, and
// a waypoint graph sampled from the free space connected to the launch point.
//
//   node sim/tools/maps/build_splat_map.mjs --scene canyon
//   node sim/tools/maps/build_splat_map.mjs --scene residential --out sim/maps/residential.json
//
// Per-scene parameters live in sim/scenes/benchmark-maps.json, so a map can
// be rebuilt exactly. Pipeline, mirroring build_factory_map.mjs:
//  1. Occupancy: each 0.25-unit cell of the crop is solid if any 5 cm collider
//     voxel overlaps it (conservative, like the factory's mesh voxelization).
//  2. Geofence: outdoors there is no roof, so a drone could simply fly over
//     every obstacle. Cells higher than `agl` above the surrounding terrain
//     (the lowest sky-facing ground within `terrainRadius`), or above an
//     optional absolute `ceiling`, are sealed. Houses, trees and canyon walls
//     taller than the fence stay obstacles. This is an altitude rule, not
//     geometry from the scan, and the map records it as such.
//  3. Free space: flood from the launch point through cells with at least
//     `floodClearance` units to the nearest solid cell.
//  4. Waypoints: farthest-point samples with `waypointClearance`, joined when a
//     tube of radius `edgeRadius` is clear, sparsified, largest component kept.
// Waypoints serve route generation, the A* upper-bound baseline and progress
// metrics. Controllers under test never see them.
// Scene units are not independently calibrated metres (see the scene config).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SplatVoxels, convertSplatToMap } from "../../src/splat_voxels.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const sceneId = opt("--scene");
if (!sceneId) throw new Error("usage: build_splat_map.mjs --scene <id> [--out file] [--probe]");
const configs = JSON.parse(fs.readFileSync(path.join(root, "sim/scenes/benchmark-maps.json"), "utf8"));
const C = configs.maps[sceneId];
if (!C) throw new Error(`no benchmark map config for ${sceneId}`);
const registry = JSON.parse(fs.readFileSync(path.join(root, "sim/scenes/rescue-scenes.json"), "utf8"));
const scene = registry.scenes.find((s) => s.id === (C.scene ?? sceneId));
if (!scene) throw new Error(`scene ${sceneId} not in rescue-scenes.json`);
const OUT = path.resolve(opt("--out", path.join(root, C.out)));
const sha = (b) => createHash("sha256").update(b).digest("hex");

// ---------- 1. occupancy ----------
const dir = path.join(root, scene.assets.cacheDirectory);
const metaBytes = fs.readFileSync(path.join(dir, "scene.voxel.json"));
const binBytes = fs.readFileSync(path.join(dir, "scene.voxel.bin"));
// Optional uniform rescale (config `scale`): the scene's metre scale is not
// established, so a map may choose one. Positions in the config are in the
// rescaled frame.
const transform = { ...scene.transform.collision, scale: (scene.transform.collision.scale ?? 1) * (C.scale ?? 1) };
const voxels = new SplatVoxels(JSON.parse(metaBytes), binBytes, { transform });
const CELL = C.cell;
const crop = C.crop;
const t0 = Date.now();
const base = convertSplatToMap(voxels, { bounds: crop, cell: CELL, maxCells: C.maxCells ?? 4_000_000 });
const { origin, dims } = base.voxels;
const [NX, NY, NZ] = dims;
const occ = new Uint8Array(NX * NY * NZ);
{
  let i = 0, val = base.voxels.firstValue;
  for (const n of base.voxels.runs) { if (val) occ.fill(1, i, i + n); i += n; val = val ? 0 : 1; }
}
const at = (x, y, z) => x + NX * (y + NY * z);
const cy = (y) => origin[1] + (y + 0.5) * CELL;
const cellOf = (p, k) => Math.floor((p - origin[k]) / CELL);
console.log(`occupancy ${NX}x${NY}x${NZ} @ ${CELL}: ${base.splatCollision.solidCells} solid cells [${Math.round((Date.now() - t0) / 1000)} s]`);

// ---------- optional: flight volume ----------
// A ground mask proposed by sim/tools/env/suggest_volume.mjs and approved by a
// person (config `volume`): every column outside it is sealed, so the flight
// space stays over ground the scan actually captured. The height band comes
// from `agl` below. Maps without a volume are unaffected.
let outsideVolume = 0, volumeInfo = null;
if (C.volume) {
  const vBytes = fs.readFileSync(path.join(root, C.volume));
  const V = JSON.parse(vBytes);
  const [VX, VZ] = V.dims;
  const mask = new Uint8Array(VX * VZ);
  { let i = 0, val = V.firstValue; for (const n of V.runs) { if (val) mask.fill(1, i, i + n); i += n; val = val ? 0 : 1; } }
  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
    const ix = Math.floor((origin[0] + (x + 0.5) * CELL - V.origin[0]) / V.cell);
    const iz = Math.floor((origin[2] + (z + 0.5) * CELL - V.origin[1]) / V.cell);
    if (ix >= 0 && iz >= 0 && ix < VX && iz < VZ && mask[ix + VX * iz]) continue;
    for (let y = 0; y < NY; y++) if (!occ[at(x, y, z)]) { occ[at(x, y, z)] = 1; outsideVolume++; }
  }
  volumeInfo = { file: C.volume, sha256: sha(vBytes), sealedCells: outsideVolume, kind: "flight volume; not scanned geometry" };
  console.log(`flight volume ${C.volume}: sealed ${outsideVolume} cells outside it`);
}

// ---------- 2. geofence ----------
// Sky-facing ground of a column: the floor of its topmost free interval that
// reaches the top of the crop. Columns sealed to the top (outside the capture)
// have no ground.
const ground = new Float32Array(NX * NZ).fill(NaN);
for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
  if (occ[at(x, NY - 1, z)]) continue;
  let y = NY - 1;
  while (y > 0 && !occ[at(x, y - 1, z)]) y--;
  ground[x + NX * z] = origin[1] + y * CELL;
}
const R = Math.round(C.terrainRadius / CELL);
const disc = [];
for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dz * dz <= R * R) disc.push([dx, dz]);
const terrain = new Float32Array(NX * NZ).fill(NaN);
// Terrain = a low percentile of nearby ground (config terrainPercentile; 0 =
// the minimum, used by the cottages). A percentile ignores small deep holes
// in a scan that would otherwise drag the altitude limit underground.
const pct = C.terrainPercentile ?? 0;
const near = [];
for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
  near.length = 0;
  for (const [dx, dz] of disc) {
    const X = x + dx, Z = z + dz;
    if (X < 0 || Z < 0 || X >= NX || Z >= NZ) continue;
    const g = ground[X + NX * Z];
    if (Number.isFinite(g)) near.push(g);
  }
  if (!near.length) continue;
  if (pct === 0) { let m = Infinity; for (const g of near) if (g < m) m = g; terrain[x + NX * z] = m; }
  else { near.sort((a, b) => a - b); terrain[x + NX * z] = near[Math.floor(pct * (near.length - 1))]; }
}
let fenced = 0;
for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
  const tg = terrain[x + NX * z];
  const top = Math.min(Number.isFinite(tg) && C.agl != null ? tg + C.agl : Infinity, C.ceiling ?? Infinity);
  if (!Number.isFinite(top)) continue;
  for (let y = 0; y < NY; y++) if (origin[1] + y * CELL >= top && !occ[at(x, y, z)]) { occ[at(x, y, z)] = 1; fenced++; }
}
console.log(`geofence: ${C.agl != null ? `${C.agl} above terrain (min ground within ${C.terrainRadius})` : "no terrain-relative limit"}${C.ceiling != null ? `, absolute ceiling ${C.ceiling}` : ""}; sealed ${fenced} cells`);

// ---------- optional: floor clamp ----------
// Cells whose centre lies below `floor` become solid. Used where the scan has
// no surface below some height at all (the collider then shows open void).
if (C.floor != null) {
  let n = 0;
  for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) {
    if (origin[1] + (y + 0.5) * CELL >= C.floor) break;
    for (let x = 0; x < NX; x++) if (!occ[at(x, y, z)]) { occ[at(x, y, z)] = 1; n++; }
  }
  console.log(`floor clamp at y=${C.floor}: sealed ${n} cells`);
}

// ---------- optional: seal hollows below the ground ----------
// Scans can hold closed pockets under the real ground (missed surfaces). With
// sealBelowGroundBy, free cells more than that far below the floor of their
// column's topmost free interval (after the fence) become solid.
let hollow = 0;
if (C.sealBelowGroundBy != null) {
  const need = C.sealBelowGroundBy;
  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
    let y = NY - 1;
    while (y >= 0 && occ[at(x, y, z)]) y--; // skip sealed cells at the top
    if (y < 0) continue;
    while (y > 0 && !occ[at(x, y - 1, z)]) y--; // floor of the topmost free interval
    const floorY = origin[1] + y * CELL;
    for (let k = 0; k < y; k++) if (!occ[at(x, k, z)] && origin[1] + (k + 1) * CELL < floorY - need) { occ[at(x, k, z)] = 1; hollow++; }
  }
  console.log(`sealed ${hollow} free cells more than ${need} below the ground (scan hollows)`);
}

// ---------- optional: fill capture holes (pits) ----------
// Where the camera never saw the ground, the collider has no floor and a
// column drops far below its neighbours (verified against the splat: such
// columns hold no Gaussians at all). With fillPitsDeeperThan, a column whose
// floor is more than that far below the median floor within pitRadius is
// filled solid up to that median.
if (C.fillPitsDeeperThan != null) {
  const floorOf = new Float32Array(NX * NZ).fill(NaN);
  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
    let y = NY - 1;
    while (y >= 0 && occ[at(x, y, z)]) y--;
    if (y < 0) continue;
    while (y > 0 && !occ[at(x, y - 1, z)]) y--;
    floorOf[x + NX * z] = y;
  }
  const Rp = Math.round(C.pitRadius / CELL), deep = C.fillPitsDeeperThan / CELL;
  let filled = 0, columns = 0;
  const vals = [];
  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
    const f = floorOf[x + NX * z];
    if (!Number.isFinite(f)) continue;
    vals.length = 0;
    for (let dz = -Rp; dz <= Rp; dz += 2) for (let dx = -Rp; dx <= Rp; dx += 2) {
      if (dx * dx + dz * dz > Rp * Rp) continue;
      const X = x + dx, Z = z + dz;
      if (X < 0 || Z < 0 || X >= NX || Z >= NZ) continue;
      const g = floorOf[X + NX * Z];
      if (Number.isFinite(g)) vals.push(g);
    }
    if (vals.length < 8) continue;
    vals.sort((a, b) => a - b);
    const med = vals[vals.length >> 1];
    if (f < med - deep) { columns++; for (let y = 0; y < med; y++) if (!occ[at(x, y, z)]) { occ[at(x, y, z)] = 1; filled++; } }
  }
  console.log(`filled ${columns} pit columns (${filled} cells) deeper than ${C.fillPitsDeeperThan} below the median floor within ${C.pitRadius}`);
}

// ---------- clearance (chamfer distance to nearest solid cell) ----------
const dist = new Float32Array(occ.length).fill(Infinity);
let queue = [];
for (let i = 0; i < occ.length; i++) if (occ[i]) { dist[i] = 0; queue.push(i); }
const nbr = [];
for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) nbr.push([dx, dy, dz, Math.hypot(dx, dy, dz) * CELL]);
while (queue.length) {
  const next = [];
  for (const i of queue) {
    const x = i % NX, y = Math.floor(i / NX) % NY, z = Math.floor(i / (NX * NY));
    for (const [dx, dy, dz, d] of nbr) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= NX || Y >= NY || Z >= NZ) continue;
      const j = at(X, Y, Z);
      if (dist[i] + d < dist[j] - 1e-6) { dist[j] = dist[i] + d; next.push(j); }
    }
  }
  queue = next;
}
// Cells on the crop boundary count as walls too (World treats outside as solid).
const edgeDist = (i) => {
  const x = i % NX, y = Math.floor(i / NX) % NY, z = Math.floor(i / (NX * NY));
  return CELL * Math.min(x + 0.5, y + 0.5, z + 0.5, NX - x - 0.5, NY - y - 0.5, NZ - z - 0.5);
};
for (let i = 0; i < dist.length; i++) dist[i] = Math.min(dist[i], edgeDist(i));

// ---------- 3. free space connected to the launch point ----------
const seedP = C.launch;
const seed = at(cellOf(seedP[0], 0), cellOf(seedP[1], 1), cellOf(seedP[2], 2));
if (!(dist[seed] >= C.floodClearance)) throw new Error(`launch cell not clear (clearance ${dist[seed]})`);
const inside = new Uint8Array(occ.length);
inside[seed] = 1;
queue = [seed];
const face = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
while (queue.length) {
  const next = [];
  for (const i of queue) {
    const x = i % NX, y = Math.floor(i / NX) % NY, z = Math.floor(i / (NX * NY));
    for (const [dx, dy, dz] of face) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= NX || Y >= NY || Z >= NZ) continue;
      const j = at(X, Y, Z);
      if (!inside[j] && dist[j] >= C.floodClearance) { inside[j] = 1; next.push(j); }
    }
  }
  queue = next;
}
let nInside = 0;
for (const b of inside) nInside += b;
console.log(`free space connected to launch (clearance >= ${C.floodClearance}): ${nInside} cells (${(nInside * CELL ** 3).toFixed(0)} cubic units)`);

if (args.includes("--probe")) {
  // Top-down view: '#' no reachable free space in the column, '.' reachable,
  // 'L' launch. Use it to tune the crop and fence before building.
  const lines = [];
  for (let z = NZ - 1; z >= 0; z -= 2) {
    let line = "";
    for (let x = 0; x < NX; x += 2) {
      if (x === cellOf(seedP[0], 0) - (cellOf(seedP[0], 0) % 2) && z === cellOf(seedP[2], 2) - (cellOf(seedP[2], 2) % 2)) { line += "L"; continue; }
      let any = false;
      for (let y = 0; y < NY && !any; y++) any = inside[at(x, y, z)] === 1;
      line += any ? "." : "#";
    }
    lines.push(line);
  }
  console.log(`top-down, north up, 2 cells per char, x ${origin[0]}..${origin[0] + NX * CELL}, z ${origin[2]}..${origin[2] + NZ * CELL}`);
  console.log(lines.join("\n"));
  process.exit(0);
}

// ---------- 4. waypoint graph ----------
const center = (i) => [origin[0] + ((i % NX) + 0.5) * CELL, origin[1] + ((Math.floor(i / NX) % NY) + 0.5) * CELL, origin[2] + (Math.floor(i / (NX * NY)) + 0.5) * CELL];
const cand = [];
for (let i = 0; i < inside.length; i++) if (inside[i] && dist[i] >= C.waypointClearance) cand.push(i);
console.log(`waypoint candidates (clearance >= ${C.waypointClearance}): ${cand.length}`);
const dw = (p, q) => Math.hypot(p[0] - q[0], 1.6 * (p[1] - q[1]), p[2] - q[2]);
const cp = cand.map(center);
const chosen = [cand.reduce((b, i) => (dist[i] > dist[b] ? i : b), cand[0])];
const minD = cp.map((p) => dw(p, center(chosen[0])));
while (chosen.length < Math.min(C.waypoints, cand.length)) {
  let best = -1, bi = -1;
  for (let k = 0; k < cand.length; k++) {
    const score = minD[k] * Math.min(1, dist[cand[k]] / 1.6);
    if (score > best) { best = score; bi = k; }
  }
  if (best <= 0) break;
  chosen.push(cand[bi]);
  const c = cp[bi];
  for (let k = 0; k < cand.length; k++) minD[k] = Math.min(minD[k], dw(cp[k], c));
}
const pts = chosen.map((i) => center(i).map((x) => Math.round(x * 100) / 100));
const free = (p, r) => {
  const lo = [0, 1, 2].map((k) => cellOf(p[k] - r, k)), hi = [0, 1, 2].map((k) => cellOf(p[k] + r, k));
  for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
    if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) return false;
    if (!occ[at(x, y, z)]) continue;
    let d2 = 0;
    for (const [k, c] of [[0, x], [1, y], [2, z]]) {
      const a = origin[k] + c * CELL, b = a + CELL;
      const e = p[k] < a ? a - p[k] : p[k] > b ? p[k] - b : 0;
      d2 += e * e;
    }
    if (d2 < r * r) return false;
  }
  return true;
};
const clearSeg = (a, b, r) => {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.max(1, Math.ceil(L / 0.15));
  for (let i = 0; i <= n; i++) if (!free([0, 1, 2].map((k) => a[k] + ((b[k] - a[k]) * i) / n), r)) return false;
  return true;
};
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
let edges = [];
for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
  const L = d3(pts[i], pts[j]);
  if (L <= C.maxEdge && clearSeg(pts[i], pts[j], C.edgeRadius)) edges.push([i, j, L]);
}
const has = new Set(edges.map(([a, b]) => `${a},${b}`));
const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
edges = edges.filter(([a, b, L]) => {
  for (let c = 0; c < pts.length; c++) {
    if (c === a || c === b || !has.has(key(a, c)) || !has.has(key(c, b))) continue;
    if (d3(pts[a], pts[c]) + d3(pts[c], pts[b]) <= 1.12 * L) return false;
  }
  return true;
});
const adj = pts.map(() => []);
for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
const comp = new Array(pts.length).fill(-1);
let best = { id: -1, size: 0 };
for (let s = 0; s < pts.length; s++) {
  if (comp[s] >= 0) continue;
  const stack = [s];
  comp[s] = s;
  let size = 0;
  while (stack.length) { const u = stack.pop(); size++; for (const w of adj[u]) if (comp[w] < 0) { comp[w] = s; stack.push(w); } }
  if (size > best.size) best = { id: s, size };
}
const keep = pts.map((_, i) => comp[i] === best.id);
const kept = pts.map((p, i) => ({ p, i })).filter(({ i }) => keep[i]);
const xs = kept.map(({ p }) => p[0]), zs = kept.map(({ p }) => p[2]);
const q = (arr, f) => [...arr].sort((a, b) => a - b)[Math.floor(f * (arr.length - 1))];
const [x1, x2] = [q(xs, 0.33), q(xs, 0.67)];
const [z1, z2] = [q(zs, 0.33), q(zs, 0.67)];
const agl = (p) => p[1] - terrain[cellOf(p[0], 0) + NX * cellOf(p[2], 2)];
// +z is north in the simulator's convention.
const zone = (p) => `${p[2] > z2 ? "north" : p[2] < z1 ? "south" : "mid"}-${p[0] < x1 ? "west" : p[0] > x2 ? "east" : "centre"}`;
const band = (p) => (agl(p) > (C.agl ?? 2) / 2 ? "high" : "low");
const names = {}, count = {};
for (const { p, i } of kept) {
  const b = `${zone(p)}-${band(p)}`;
  count[b] = (count[b] || 0) + 1;
  names[i] = `${b}-${count[b]}`;
}
let far = [kept[0].i, kept[1].i, -1];
for (const a of kept) for (const b of kept) {
  const L = Math.hypot(a.p[0] - b.p[0], a.p[2] - b.p[2]);
  if (L > far[2]) far = [a.i, b.i, L];
}
const mid = [0, 1, 2].map((k) => (pts[far[0]][k] + pts[far[1]][k]) / 2);
const perch = kept.filter(({ i }) => i !== far[0] && i !== far[1]).sort((a, b) => d3(a.p, mid) - d3(b.p, mid))[0].i;
names[far[0]] = "start";
names[far[1]] = "goal";
names[perch] = "perch";
const waypoints = Object.fromEntries(kept.map(({ p, i }) => [names[i], p]));
const edgeList = edges.filter(([a, b]) => keep[a] && keep[b]).map(([a, b]) => [names[a], names[b]]);
const routeTags = Object.fromEntries(kept.filter(({ i }) => !["start", "goal"].includes(names[i])).map(({ p, i }) => [names[i], `${zone(p)} ${band(p)}`]));
console.log(`graph: ${best.size}/${pts.length} waypoints connected, ${edgeList.length} edges`);

// ---------- terrain (2D, for mission placement and figures) ----------
const terrainRows = [];
for (let z = 0; z < NZ; z++) terrainRows.push(Array.from({ length: NX }, (_, x) => { const t = ground[x + NX * z]; return Number.isFinite(t) ? Math.round(t * 100) / 100 : null; }));

// ---------- pack ----------
const runs = [];
let cur = occ[0], len = 0;
for (let i = 0; i < occ.length; i++) {
  if (occ[i] === cur) len++;
  else { runs.push(len); cur = occ[i]; len = 1; }
}
runs.push(len);
const factory = JSON.parse(fs.readFileSync(path.join(root, "sim/maps/factory-full.json"), "utf8"));
const map = {
  name: C.name,
  notes: `Generated by sim/tools/maps/build_splat_map.mjs --scene ${sceneId} from the SuperSplat v1.1 collider (${scene.source?.attribution ?? sceneId}). Occupancy is conservative at ${CELL} units. Cells ${[C.agl != null ? `more than ${C.agl} units above the surrounding terrain` : null, C.ceiling != null ? `above y=${C.ceiling}` : null].filter(Boolean).join(" or ")} are sealed as an altitude geofence (a flight rule, not scanned geometry). ${C.unitsNote}`,
  bounds: { min: origin.slice(), max: [0, 1, 2].map((k) => Math.round((origin[k] + dims[k] * CELL) * 1000) / 1000) },
  start: "start",
  goal: "goal",
  goalRadius: 1.0,
  birdStart: "perch",
  routeTags,
  // Same dynamics as the factory benchmark, in scene units.
  physics: { ...factory.physics },
  boxes: [],
  voxels: { origin: origin.slice(), cell: CELL, dims, firstValue: occ[0], runs },
  waypoints,
  edges: edgeList,
  geofence: { agl: C.agl, terrainRadius: C.terrainRadius, ceiling: C.ceiling ?? null, sealedCells: fenced, kind: "altitude rule; not scanned geometry" },
  hollows: C.sealBelowGroundBy != null ? { sealBelowGroundBy: C.sealBelowGroundBy, sealedCells: hollow } : null,
  ...(volumeInfo ? { volume: volumeInfo } : {}),
  launch: C.launch,
  ground: { origin: [origin[0], origin[2]], cell: CELL, dims: [NX, NZ], rows: terrainRows, meaning: "floor of each column's sky-facing free interval (null = sealed column)" },
  splatCollision: { ...base.splatCollision, solidCellsWithFence: base.splatCollision.solidCells + fenced, source: { scene: sceneId, metadataSha256: sha(metaBytes), binarySha256: sha(binBytes) }, config: C },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(map));
const ys = kept.map(({ p }) => p[1]);
console.log(`wrote ${path.relative(root, OUT)}: ${Object.keys(waypoints).length} waypoints, ${edgeList.length} edges, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB [${Math.round((Date.now() - t0) / 1000)} s]`);
console.log(`start ${JSON.stringify(waypoints.start)} goal ${JSON.stringify(waypoints.goal)} (horizontal ${far[2].toFixed(1)}); waypoint heights ${Math.min(...ys)}..${Math.max(...ys)}`);
