// Build a simulator map from the factory scan's collision mesh
// (Factory_collider.glb from the PlayCanvas project used by factory.html).
//   node sim/tools/maps/build_factory_map.mjs <collider.glb (gzip ok)> [--out sim/maps/factory.json]
// Output: a voxel occupancy grid (collisions), a waypoint graph sampled
// from interior free space, and the same physics as building.json. World
// coordinates match factory.html: collider vertices + (-4.695, 0.438, 11.397).
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const src = args[0];
if (!src) throw new Error("usage: build_factory_map.mjs <collider.glb> [--out file]");
const OUT = opt("--out", path.join(here, "../../maps/factory.json"));
const CELL = Number(opt("--cell", 0.25));
const OFFSET = [-4.695, 0.438, 11.397];
// factory.html hides everything south of the shared corridor wall
// (z > 11.8 - 0.035x); keep the simulator inside the rendered part.
const SOUTH_WALL = (x) => 11.8 - 0.035 * x;

// ---------- read the GLB ----------
let buf = fs.readFileSync(src);
if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
// Reads an accessor into a packed typed array, honouring interleaved
// buffer views (byteStride).
const view = (accIdx) => {
  const acc = gltf.accessors[accIdx];
  const bv = gltf.bufferViews[acc.bufferView];
  const base = binStart + (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3 }[acc.type];
  const size = { 5126: 4, 5125: 4, 5123: 2 }[acc.componentType];
  if (!size) throw new Error(`componentType ${acc.componentType}`);
  const stride = bv.byteStride || comps * size;
  const out = acc.componentType === 5126 ? new Float32Array(acc.count * comps) : new Uint32Array(acc.count * comps);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comps; c++) {
      const o = base + i * stride + c * size;
      out[i * comps + c] = acc.componentType === 5126 ? buf.readFloatLE(o) : acc.componentType === 5125 ? buf.readUInt32LE(o) : buf.readUInt16LE(o);
    }
  }
  return out;
};
const prim = gltf.meshes[0].primitives[0];
const pos = view(prim.attributes.POSITION);
const idx = view(prim.indices);
for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) pos[i + k] += OFFSET[k];
console.log(`mesh: ${pos.length / 3} vertices, ${idx.length / 3} triangles`);

// ---------- voxel grid ----------
let min = [Infinity, Infinity, Infinity];
let max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
  min[k] = Math.min(min[k], pos[i + k]);
  max[k] = Math.max(max[k], pos[i + k]);
}
max[2] = Math.min(max[2], SOUTH_WALL(min[0]) + 1); // trim the hidden south corridor
const origin = min.map((m) => Math.floor(m / CELL) * CELL - CELL);
const dims = [0, 1, 2].map((k) => Math.ceil((max[k] - origin[k]) / CELL) + 2);
const [NX, NY, NZ] = dims;
const occ = new Uint8Array(NX * NY * NZ);
const at = (x, y, z) => x + NX * (y + NY * z);
const cellOf = (p, k) => Math.floor((p - origin[k]) / CELL);
let marked = 0;
const step = CELL * 0.45;
for (let t = 0; t < idx.length; t += 3) {
  const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
  const A = [pos[a], pos[a + 1], pos[a + 2]], B = [pos[b], pos[b + 1], pos[b + 2]], C = [pos[c], pos[c + 1], pos[c + 2]];
  const lab = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
  const lac = Math.hypot(C[0] - A[0], C[1] - A[1], C[2] - A[2]);
  const n = Math.max(1, Math.ceil(Math.max(lab, lac) / step));
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
    const u = i / n, w = j / n;
    const p = [0, 1, 2].map((k) => A[k] + u * (B[k] - A[k]) + w * (C[k] - A[k]));
    if (p[2] > max[2]) continue;
    const x = cellOf(p[0], 0), y = cellOf(p[1], 1), z = cellOf(p[2], 2);
    if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) continue;
    const id = at(x, y, z);
    if (!occ[id]) { occ[id] = 1; marked++; }
  }
}
// Seal the trimmed south edge so nothing flies into the hidden corridor.
for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
  const wx = origin[0] + (x + 0.5) * CELL;
  const wz = origin[2] + (z + 0.5) * CELL;
  if (wz > SOUTH_WALL(wx) - 0.2) for (let y = 0; y < NY; y++) occ[at(x, y, z)] = 1;
}
console.log(`grid ${NX}x${NY}x${NZ} @ ${CELL} m, ${marked} surface cells`);

// ---------- clearance (distance to nearest occupied cell, in metres) ----------
// Multi-source BFS with 26-neighbour steps: a conservative chamfer distance.
const dist = new Float32Array(NX * NY * NZ).fill(Infinity);
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

// ---------- interior free space: flood from Simon's flight loop ----------
if (args.includes("--probe")) {
  const yHist = new Array(NY).fill(0);
  for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) if (occ[at(x, y, z)]) yHist[y]++;
  console.log("occupied cells per height:", yHist.map((c, y) => `${(origin[1] + (y + 0.5) * CELL).toFixed(2)}:${c}`).join(" "));
  for (const [px, pz] of [[-24, -24], [-10, -7.5], [0, 0], [-24, -20], [10, -10]]) {
    const col = [];
    for (let y = 0; y < NY; y++) col.push(occ[at(cellOf(px, 0), y, cellOf(pz, 2))] ? "#" : ".");
    console.log(`column x=${px} z=${pz} (bottom→top from y=${origin[1]}):`, col.join(""), "clearance at y=0.5:", dist[at(cellOf(px, 0), cellOf(0.5, 1), cellOf(pz, 2))].toFixed(2));
  }
  process.exit(0);
}
const Y_MIN = Number(opt("--ymin", -1.0));
const Y_MAX = Number(opt("--ymax", 1.75));
// A point on factory.html's drone loop (the loop circles a pillar at -24, -24).
const seedP = [-24, 0.5, -20];
const seed = at(cellOf(seedP[0], 0), cellOf(seedP[1], 1), cellOf(seedP[2], 2));
if (!(dist[seed] > 0.5)) throw new Error(`seed cell is not free (clearance ${dist[seed]})`);
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
      if (X < 1 || Y < 1 || Z < 1 || X >= NX - 1 || Y >= NY - 1 || Z >= NZ - 1) continue;
      // Stay in the hall: below the ceiling (~2 m) and above the floor, so the
      // flood can't escape into the roof space through openings.
      const wy = origin[1] + (Y + 0.5) * CELL;
      if (wy > Y_MAX || wy < Y_MIN) continue;
      const j = at(X, Y, Z);
      if (!inside[j] && dist[j] >= 0.45) { inside[j] = 1; next.push(j); }
    }
  }
  queue = next;
}
let nInside = 0;
for (const v of inside) nInside += v;
console.log(`interior free cells (clearance >= 0.45 m): ${nInside} (${(nInside * CELL ** 3).toFixed(0)} m^3)`);

// ---------- waypoints: farthest-point sampling over well-clear interior ----------
const center = (i) => [origin[0] + ((i % NX) + 0.5) * CELL, origin[1] + ((Math.floor(i / NX) % NY) + 0.5) * CELL, origin[2] + (Math.floor(i / (NX * NY)) + 0.5) * CELL];
const cand = [];
const CLEAR = Number(opt("--clear", 0.9));
for (let i = 0; i < inside.length; i++) if (inside[i] && dist[i] >= CLEAR) cand.push(i);
console.log(`waypoint candidates (clearance >= 1.0 m): ${cand.length}`);
const N_WP = Number(opt("--waypoints", 34));
const dw = (p, q) => Math.hypot(p[0] - q[0], 1.6 * (p[1] - q[1]), p[2] - q[2]);
const cp = cand.map(center);
const chosen = [cand.reduce((b, i) => (dist[i] > dist[b] ? i : b), cand[0])];
const minD = cp.map((p) => dw(p, center(chosen[0])));
while (chosen.length < N_WP) {
  let best = -1, bi = -1;
  for (let k = 0; k < cand.length; k++) {
    const score = minD[k] * Math.min(1, dist[cand[k]] / 1.6); // prefer open space
    if (score > best) { best = score; bi = k; }
  }
  chosen.push(cand[bi]);
  const c = cp[bi];
  for (let k = 0; k < cand.length; k++) minD[k] = Math.min(minD[k], dw(cp[k], c));
}
const pts = chosen.map((i) => center(i).map((v) => Math.round(v * 10) / 10));

// ---------- edges: clear lines of sight, then sparsify ----------
const free = (p, r) => {
  const x0 = cellOf(p[0] - r, 0), x1 = cellOf(p[0] + r, 0);
  const y0 = cellOf(p[1] - r, 1), y1 = cellOf(p[1] + r, 1);
  const z0 = cellOf(p[2] - r, 2), z1 = cellOf(p[2] + r, 2);
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) return false;
    if (!occ[at(x, y, z)]) continue;
    let d2 = 0;
    for (const [k, c] of [[0, x], [1, y], [2, z]]) {
      const lo = origin[k] + c * CELL, hi = lo + CELL;
      const e = p[k] < lo ? lo - p[k] : p[k] > hi ? p[k] - hi : 0;
      d2 += e * e;
    }
    if (d2 < r * r) return false;
  }
  return true;
};
const clear = (a, b, r) => {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.max(1, Math.ceil(L / 0.15));
  for (let i = 0; i <= n; i++) if (!free([0, 1, 2].map((k) => a[k] + ((b[k] - a[k]) * i) / n), r)) return false;
  return true;
};
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const MAX_EDGE = Number(opt("--max-edge", 12));
let edges = [];
for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
  const L = d3(pts[i], pts[j]);
  if (L <= MAX_EDGE && clear(pts[i], pts[j], 0.5)) edges.push([i, j, L]);
}
// Drop an edge when a two-hop detour through a shared neighbour is nearly as short.
const has = new Set(edges.map(([a, b]) => `${a},${b}`));
const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
edges = edges.filter(([a, b, L]) => {
  for (let c = 0; c < pts.length; c++) {
    if (c === a || c === b || !has.has(key(a, c)) || !has.has(key(c, b))) continue;
    if (d3(pts[a], pts[c]) + d3(pts[c], pts[b]) <= 1.12 * L) return false;
  }
  return true;
});
// Keep the largest connected component.
const adj = pts.map(() => []);
for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
const comp = new Array(pts.length).fill(-1);
let best = { id: -1, size: 0 };
for (let s = 0; s < pts.length; s++) {
  if (comp[s] >= 0) continue;
  const stack = [s];
  comp[s] = s;
  let size = 0;
  while (stack.length) { const u = stack.pop(); size++; for (const v of adj[u]) if (comp[v] < 0) { comp[v] = s; stack.push(v); } }
  if (size > best.size) best = { id: s, size };
}
const keep = pts.map((_, i) => comp[i] === best.id);
console.log(`graph: ${best.size}/${pts.length} waypoints connected, ${edges.filter(([a, b]) => keep[a] && keep[b]).length} edges`);

// ---------- names: zone of the hall + height ----------
const kept = pts.map((p, i) => ({ p, i })).filter(({ i }) => keep[i]);
const xs = kept.map(({ p }) => p[0]), zs = kept.map(({ p }) => p[2]), ys = kept.map(({ p }) => p[1]);
const q = (arr, f) => [...arr].sort((a, b) => a - b)[Math.floor(f * (arr.length - 1))];
const [x1, x2] = [q(xs, 0.33), q(xs, 0.67)];
const [z1, z2] = [q(zs, 0.33), q(zs, 0.67)];
const yMid = (Math.min(...ys) + Math.max(...ys)) / 2;
const zone = (p) => `${p[2] < z1 ? "north" : p[2] > z2 ? "south" : "mid"}-${p[0] < x1 ? "west" : p[0] > x2 ? "east" : "centre"}`;
const names = {};
const count = {};
for (const { p, i } of kept) {
  const base = `${zone(p)}-${p[1] > yMid ? "high" : "low"}`;
  count[base] = (count[base] || 0) + 1;
  names[i] = `${base}-${count[base]}`;
}
// Task anchors: start and goal at the two far ends; the bird perch near the middle.
let far = [kept[0].i, kept[1].i, -1];
for (const a of kept) for (const b of kept) {
  const L = Math.hypot(a.p[0] - b.p[0], a.p[2] - b.p[2]);
  if (L > far[2]) far = [a.i, b.i, L];
}
const mid = [(pts[far[0]][0] + pts[far[1]][0]) / 2, (pts[far[0]][1] + pts[far[1]][1]) / 2, (pts[far[0]][2] + pts[far[1]][2]) / 2];
const perch = kept.filter(({ i }) => i !== far[0] && i !== far[1]).sort((a, b) => d3(a.p, mid) - d3(b.p, mid))[0].i;
names[far[0]] = "start";
names[far[1]] = "goal";
names[perch] = "perch";

const waypoints = Object.fromEntries(kept.map(({ p, i }) => [names[i], p]));
const edgeList = edges.filter(([a, b]) => keep[a] && keep[b]).map(([a, b]) => [names[a], names[b]]);
const routeTags = Object.fromEntries(kept.filter(({ i }) => !["start", "goal"].includes(names[i])).map(({ p, i }) => [names[i], `${zone(p)} ${p[1] > yMid ? "high" : "low"}`]));

// ---------- pack the grid (run-length encoded occupancy) ----------
const runs = [];
let cur = occ[0], len = 0;
for (let i = 0; i < occ.length; i++) {
  if (occ[i] === cur) len++;
  else { runs.push(len); cur = occ[i]; len = 1; }
}
runs.push(len);

const building = JSON.parse(fs.readFileSync(path.join(here, "../../maps/building.json")));
const map = {
  name: "Factory scan (Christoph Schindelar), collider from PlayCanvas project 1480299",
  notes: "Generated by tools/maps/build_factory_map.mjs from Factory_collider.glb. Coordinates match factory.html (collider + (-4.695, 0.438, 11.397); the scan entity is rotated -90 deg about X). Collisions use the voxel grid; the hidden south corridor is sealed.",
  render: { page: "factory.html" },
  bounds: { min: origin.map((v) => Math.round(v * 1000) / 1000), max: [0, 1, 2].map((k) => Math.round((origin[k] + dims[k] * CELL) * 1000) / 1000) },
  start: "start",
  goal: "goal",
  goalRadius: 1.0,
  birdStart: "perch",
  routeTags,
  physics: { ...building.physics },
  boxes: [],
  voxels: { origin: origin.map((v) => Math.round(v * 1000) / 1000), cell: CELL, dims, firstValue: occ[0], runs },
  waypoints,
  edges: edgeList,
};
fs.writeFileSync(OUT, JSON.stringify(map));
console.log(`wrote ${OUT}: ${Object.keys(waypoints).length} waypoints, ${edgeList.length} edges, ${runs.length} runs, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
console.log(`start ${JSON.stringify(waypoints.start)} goal ${JSON.stringify(waypoints.goal)} perch ${JSON.stringify(waypoints.perch)} (start-goal ${far[2].toFixed(1)} m)`);
console.log(`height range of waypoints: ${Math.min(...ys)}..${Math.max(...ys)} m`);
