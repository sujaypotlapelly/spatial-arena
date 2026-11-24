// Builds a "full building" variant of a voxel (scan) map: the rooms south
// of the factory's north hall join the flight graph.
//
// Why the original factory map stops at the north hall: build_factory_map.mjs
// needs 0.9 m of clearance for a waypoint and a 0.5 m tube for each edge,
// and the scan's collider leaves the doorways between the north hall and the
// south rooms only ~0.75-1 m wide. The south rooms became a separate graph
// component and were dropped. Even at drone size, flights through those
// gaps crash almost every time (0.25 m drone radius plus wind gusts).
//
// What this does, in two passes:
//  1. Find doorways. Build a graph that may pass gaps at drone size (edge
//     tube 0.35 m), bridging disconnected parts along the flooded free space.
//     Wherever an edge squeezes through a gap with wall on both sides, that
//     gap is a doorway the routes need.
//  2. Open those doorways: clear the collision voxels in a door-sized box
//     (1.6 m wide, through the wall, floor to 1.9 m) centred on the gap.
//     Walls, pillars and everything else are untouched. Then rebuild the
//     graph on the opened grid with a safer 0.5 m tube.
//
//   node sim/tools/maps/build_scan_graph.mjs [--in sim/maps/factory.json] [--out sim/maps/factory-full.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../../src/world.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const IN = opt("--in", path.join(here, "../../maps/factory.json"));
const OUT = opt("--out", path.join(here, "../../maps/factory-full.json"));
const N_WP = Number(opt("--waypoints", 90));
const MAX_EDGE = Number(opt("--max-edge", 12));
const DOOR_HALF_WIDTH = Number(opt("--door-half-width", 0.8));
const DOOR_TOP = 1.9;
const Y_MIN = -1.0;
const Y_MAX = 1.75;

const src = JSON.parse(fs.readFileSync(IN));
const grid = new World(src).grid;
const { origin, cell: CELL, dims } = grid;
const occ = Uint8Array.from(grid.occ);
const [NX, NY, NZ] = dims;
const at = (x, y, z) => x + NX * (y + NY * z);
const cellOf = (p, k) => Math.floor((p - origin[k]) / CELL);
const ctr = (c, k) => origin[k] + (c + 0.5) * CELL;
const center = (i) => [ctr(i % NX, 0), ctr(Math.floor(i / NX) % NY, 1), ctr(Math.floor(i / (NX * NY)), 2)];
const cellIdx = (p) => at(cellOf(p[0], 0), cellOf(p[1], 1), cellOf(p[2], 2));
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const face = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// Indoor columns: the scan has floor under them. Keeps floods inside the
// building instead of leaking around its outside.
const indoor = new Uint8Array(NX * NZ);
for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++)
  for (let y = cellOf(-1.2, 1); y <= cellOf(-0.3, 1); y++) if (occ[at(x, y, z)]) { indoor[x + NX * z] = 1; break; }

// Clearance: 26-neighbour chamfer distance (cell centre to cell centre).
function clearance() {
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
  return dist;
}

// True if a sphere of radius r at p touches no solid voxel.
function free(p, r) {
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
}
function clear(a, b, r) {
  const n = Math.max(1, Math.ceil(d3(a, b) / 0.15));
  for (let i = 0; i <= n; i++) if (!free([0, 1, 2].map((k) => a[k] + ((b[k] - a[k]) * i) / n), r)) return false;
  return true;
}

// One full graph build at a given clearance. Flood clearance is centre to
// centre; the edge tube is the true gap to a voxel surface (half a cell less).
function buildGraph(floodClear, nWp, label) {
  const edgeR = floodClear - CELL / 2 - 0.02;
  const dist = clearance();
  const seed = at(cellOf(-24, 0), cellOf(0.5, 1), cellOf(-20, 2));
  if (!(dist[seed] > floodClear)) throw new Error(`seed cell is not free (clearance ${dist[seed]})`);
  const inside = new Uint8Array(occ.length);
  inside[seed] = 1;
  let queue = [seed];
  while (queue.length) {
    const next = [];
    for (const i of queue) {
      const x = i % NX, y = Math.floor(i / NX) % NY, z = Math.floor(i / (NX * NY));
      for (const [dx, dy, dz] of face) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 1 || Y < 1 || Z < 1 || X >= NX - 1 || Y >= NY - 1 || Z >= NZ - 1) continue;
        const wy = ctr(Y, 1);
        if (wy > Y_MAX || wy < Y_MIN || !indoor[X + NX * Z]) continue;
        const j = at(X, Y, Z);
        if (!inside[j] && dist[j] >= floodClear) { inside[j] = 1; next.push(j); }
      }
    }
    queue = next;
  }

  // Waypoints: farthest-point sampling over well-cleared interior cells.
  const wpClear = floodClear + 0.1;
  const cand = [];
  for (let i = 0; i < inside.length; i++) if (inside[i] && dist[i] >= wpClear) cand.push(i);
  const cp = cand.map(center);
  const dw = (p, q) => Math.hypot(p[0] - q[0], 1.6 * (p[1] - q[1]), p[2] - q[2]);
  const first = cand.reduce((b, i) => (dist[i] > dist[b] ? i : b), cand[0]);
  const pts = [center(first)];
  const minD = cp.map((p) => dw(p, pts[0]));
  while (pts.length < nWp) {
    let best = -1, bi = -1;
    for (let k = 0; k < cand.length; k++) {
      const score = minD[k] * Math.min(1, dist[cand[k]] / 1.2);
      if (score > best) { best = score; bi = k; }
    }
    pts.push(cp[bi]);
    for (let k = 0; k < cand.length; k++) minD[k] = Math.min(minD[k], dw(cp[k], cp[bi]));
  }

  const components = () => {
    const edges = [];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const L = d3(pts[i], pts[j]);
      if (L <= MAX_EDGE && clear(pts[i], pts[j], edgeR)) edges.push([i, j, L]);
    }
    const adj = pts.map(() => []);
    for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
    const comp = new Array(pts.length).fill(-1);
    for (let s = 0; s < pts.length; s++) {
      if (comp[s] >= 0) continue;
      const stack = [s];
      comp[s] = s;
      while (stack.length) { const u = stack.pop(); for (const v of adj[u]) if (comp[v] < 0) { comp[v] = s; stack.push(v); } }
    }
    return { edges, comp };
  };

  // Bridge stranded components along the flooded free space: BFS from the
  // component to the largest one, then string-pull the cell path into
  // waypoints. Path cells clear floodClear, which exceeds edgeR.
  let { edges, comp } = components();
  for (let pass = 0; pass < 30; pass++) {
    const size = {};
    for (const c of comp) size[c] = (size[c] || 0) + 1;
    const ids = Object.keys(size).map(Number).sort((a, b) => size[b] - size[a]);
    if (ids.length === 1) break;
    const target = new Set(pts.map((p, i) => (comp[i] === ids[0] ? cellIdx(p) : -1)));
    let added = 0;
    for (const other of ids.slice(1)) {
      const prev = new Int32Array(occ.length).fill(-2);
      let frontier = [];
      pts.forEach((p, i) => {
        const c = cellIdx(p);
        if (comp[i] === other && inside[c]) { prev[c] = -1; frontier.push(c); }
      });
      let hit = -1;
      while (frontier.length && hit < 0) {
        const next = [];
        for (const c of frontier) {
          if (target.has(c)) { hit = c; break; }
          const x = c % NX, y = Math.floor(c / NX) % NY, z = Math.floor(c / (NX * NY));
          for (const [dx, dy, dz] of face) {
            const j = at(x + dx, y + dy, z + dz);
            if (inside[j] && prev[j] === -2) { prev[j] = c; next.push(j); }
          }
        }
        frontier = next;
      }
      if (hit < 0) continue;
      const path = [];
      for (let c = hit; c !== -1; c = prev[c]) path.push(center(c));
      let li = 0;
      for (let k = 1; k < path.length; k++) {
        if (!clear(path[li], path[k], edgeR) && k - 1 > li) {
          li = k - 1;
          pts.push(path[li]);
          added++;
        }
      }
      if (added) break; // recompute components after each bridge
    }
    if (!added) break;
    ({ edges, comp } = components());
  }

  // Sparsify: drop an edge when a two-hop detour is nearly as short.
  const has = new Set(edges.map(([a, b]) => `${a},${b}`));
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  edges = edges.filter(([a, b, L]) => {
    for (let c = 0; c < pts.length; c++) {
      if (c === a || c === b || !has.has(key(a, c)) || !has.has(key(c, b))) continue;
      if (d3(pts[a], pts[c]) + d3(pts[c], pts[b]) <= 1.12 * L) return false;
    }
    return true;
  });
  const size = {};
  for (const c of comp) size[c] = (size[c] || 0) + 1;
  const main = Number(Object.entries(size).sort((p, q) => q[1] - p[1])[0][0]);
  const keep = pts.map((_, i) => comp[i] === main);
  const nKeep = keep.filter(Boolean).length;
  const south = pts.filter((p, i) => keep[i] && p[2] > -8.5).length;
  console.log(`${label}: tube ${edgeR.toFixed(2)} m, ${nKeep}/${pts.length} waypoints connected (${south} south of the dividing wall), ${edges.filter(([a, b]) => keep[a] && keep[b]).length} edges`);
  return { pts, edges: edges.filter(([a, b]) => keep[a] && keep[b]), keep, dist, edgeR };
}

// ---------- known openings in the north/south dividing wall ----------
// Found by scanning the wall at flight height (columns free from y 0.2 to
// 1.4 m): two openings are 2.25 m wide in the collider and two are narrow
// slits, but none clears a drone-sized sphere in 3D (a beam or rubble above
// or below blocks them), so the graph never used them and every north-south
// route went through one door. Open them like the doorways found below.
// [x, z, width in the collider]; the wall runs along x, so they cross in z.
const WALL_OPENINGS = IN.endsWith("factory.json") ? [[-27.6, -8.9, 2.25], [-9.4, -9.6, 2.25], [-3.25, -9.6, 0.5], [10.6, -9.6, 0.75]] : [];
const doors = WALL_OPENINGS.map(([x, z, w]) => ({ p: [x, 0.8, z], along: [0, 1], perp: [1, 0], halfWidth: Math.max(DOOR_HALF_WIDTH, w / 2), depth: 1.0, known: true }));

// ---------- pass 1: find the doorways the routes need ----------
// Open the known wall openings first, so pass 1 can route through them.
const carve = (list) => {
  let n = 0;
  for (const d of list) {
    for (let z = cellOf(d.p[2] - 1.6, 2); z <= cellOf(d.p[2] + 1.6, 2); z++)
      for (let x = cellOf(d.p[0] - 1.6, 0); x <= cellOf(d.p[0] + 1.6, 0); x++) {
        const dx = ctr(x, 0) - d.p[0], dz = ctr(z, 2) - d.p[2];
        const u = dx * d.along[0] + dz * d.along[1];
        const v = dx * d.perp[0] + dz * d.perp[1];
        if (Math.abs(u) > d.depth || Math.abs(v) > d.halfWidth) continue;
        for (let y = cellOf(-0.3, 1); y <= cellOf(DOOR_TOP, 1); y++) {
          const i = at(x, y, z);
          if (occ[i]) { occ[i] = 0; n++; }
        }
      }
  }
  return n;
};
const clearedKnown = carve(doors);
const g1 = buildGraph(0.5, N_WP, "pass 1 (drone-size gaps)");
// Horizontal distance to the nearest solid cell at hall height along a direction.
const wallWithin = (p, dir, maxD) => {
  for (let s = 0.15; s <= maxD; s += 0.1) {
    const q = [p[0] + dir[0] * s, p[1], p[2] + dir[1] * s];
    for (const y of [0.3, 0.8, 1.3]) {
      const i = at(cellOf(q[0], 0), cellOf(y, 1), cellOf(q[2], 2));
      if (occ[i]) return true;
    }
  }
  return false;
};
for (const [a, b] of g1.edges) {
  const A = g1.pts[a], B = g1.pts[b];
  const L = Math.hypot(B[0] - A[0], B[2] - A[2]);
  if (L < 0.3) continue;
  const along = [(B[0] - A[0]) / L, (B[2] - A[2]) / L];
  const perp = [-along[1], along[0]];
  const n = Math.ceil(d3(A, B) / 0.1);
  for (let i = 0; i <= n; i++) {
    const p = [0, 1, 2].map((k) => A[k] + ((B[k] - A[k]) * i) / n);
    if (g1.dist[cellIdx(p)] >= 0.75) continue;
    // A doorway has wall on both sides, close by.
    if (wallWithin(p, perp, 0.9) && wallWithin(p, [-perp[0], -perp[1]], 0.9)) {
      if (!doors.some((d) => Math.hypot(d.p[0] - p[0], d.p[2] - p[2]) < 1.2)) doors.push({ p, along, perp, halfWidth: DOOR_HALF_WIDTH, depth: 0.6 });
    }
  }
}

// ---------- open the doorways (known openings were opened before pass 1) ----------
const cleared = clearedKnown + carve(doors.filter((d) => !d.known));
console.log(`opened ${doors.length} doorways, ${DOOR_TOP} m high (${cleared} voxels cleared):`);
for (const d of doors) console.log(`  ${d.known ? "wall opening" : "route doorway"} at x=${d.p[0].toFixed(1)} z=${d.p[2].toFixed(1)}, ${(2 * d.halfWidth).toFixed(1)} m wide`);

// ---------- pass 2: the flight graph on the opened grid ----------
const g2 = buildGraph(0.65, N_WP, "pass 2 (opened doorways)");
const kept = g2.pts.map((p, i) => ({ p: p.map((v) => Math.round(v * 10) / 10), i })).filter(({ i }) => g2.keep[i]);
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
// Start and goal at the two far ends; the bird perch near the middle.
let far = [kept[0].i, kept[1].i, -1];
for (const a of kept) for (const b of kept) {
  const L = Math.hypot(a.p[0] - b.p[0], a.p[2] - b.p[2]);
  if (L > far[2]) far = [a.i, b.i, L];
}
const P = Object.fromEntries(kept.map(({ p, i }) => [i, p]));
const mid = [0, 1, 2].map((k) => (P[far[0]][k] + P[far[1]][k]) / 2);
const perch = kept.filter(({ i }) => i !== far[0] && i !== far[1]).sort((a, b) => d3(a.p, mid) - d3(b.p, mid))[0].i;
names[far[0]] = "start";
names[far[1]] = "goal";
names[perch] = "perch";

const waypoints = Object.fromEntries(kept.map(({ p, i }) => [names[i], p]));
const edgeList = g2.edges.map(([a, b]) => [names[a], names[b]]);
const routeTags = Object.fromEntries(kept.filter(({ i }) => !["start", "goal"].includes(names[i])).map(({ p, i }) => [names[i], `${zone(p)} ${p[1] > yMid ? "high" : "low"}`]));

// Run-length encode the opened grid.
const runs = [];
let cur = occ[0], len = 0;
for (let i = 0; i < occ.length; i++) {
  if (occ[i] === cur) len++;
  else { runs.push(len); cur = occ[i]; len = 1; }
}
runs.push(len);

const map = {
  ...src,
  name: "Factory scan, full building (north hall and south rooms)",
  notes: `Collision grid of ${path.basename(IN)} with ${doors.length} doorways opened to ${(2 * DOOR_HALF_WIDTH).toFixed(1)} x ${DOOR_TOP} m (the collider left them ~0.75-1 m wide, too narrow to fly reliably); waypoint graph rebuilt by tools/maps/build_scan_graph.mjs so the south rooms are reachable.`,
  doors: doors.map((d) => ({ at: d.p.map((v) => Math.round(v * 100) / 100), along: d.along.map((v) => Math.round(v * 1000) / 1000), width: 2 * DOOR_HALF_WIDTH, top: DOOR_TOP })),
  voxels: { ...src.voxels, firstValue: occ[0], runs },
  routeTags,
  // Enough k-shortest candidates that the route menu reaches routes through
  // every doorway, not 40 near-copies through the nearest one.
  routeMenu: { candidates: 250 },
  waypoints,
  edges: edgeList,
};
fs.writeFileSync(OUT, JSON.stringify(map));
console.log(`wrote ${OUT}: ${Object.keys(waypoints).length} waypoints, ${edgeList.length} edges, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
