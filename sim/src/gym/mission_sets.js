// Mission sets for the search and delivery benchmarks, generated from a dense
// grid map (sim/maps/*.json) the same way makeReachSets generates routes:
// deterministic, filtered for feasibility, shuffled with a fixed seed, and
// split into disjoint train / dev / test sets. Every hiker spot and delivery
// pad is used in exactly one mission, so test targets are never seen in
// training. Missions are RescueMission inputs (sim/src/gym/rescue_tasks.js).
//
// Feasibility is checked with the same collision rules the simulator uses,
// but the checks are privileged (they read the map); controllers never see them.
import { v } from "../world.js";
import { rng } from "../engine.js";
import { lineOfSight } from "./core.js";

const r2 = (p) => p.map((x) => Math.round(x * 100) / 100);

// Lowest solid->free transition of every column with `headroom` free above.
// Returns surface tops (the y of the solid cell's upper face) on the grid.
// mode "lowest": the lowest solid->free transition (floors indoors; the
// original rule). mode "sky": the floor of the column's topmost free interval,
// i.e. the ground under open sky (or under the altitude fence), which skips
// closed hollows beneath the real ground in scans.
export function columnSurfaces(world, { headroom = 2, stride = 2, mode = "lowest" } = {}) {
  const { origin, cell, dims, occ } = world.grid;
  const [NX, NY, NZ] = dims;
  const at = (x, y, z) => x + NX * (y + NY * z);
  const need = Math.ceil(headroom / cell);
  const out = [];
  for (let z = 1; z < NZ - 1; z += stride) for (let x = 1; x < NX - 1; x += stride) {
    if (mode === "sky") {
      let y = NY - 1;
      while (y >= 0 && occ[at(x, y, z)]) y--;
      if (y < 1) continue;
      const top = y;
      while (y > 0 && !occ[at(x, y - 1, z)]) y--;
      if (y < 1 || top - y + 1 < need) continue;
      out.push({ ix: x, iy: y, iz: z, top: origin[1] + y * cell, x: origin[0] + (x + 0.5) * cell, z: origin[2] + (z + 0.5) * cell });
      continue;
    }
    for (let y = 1; y < NY - need; y++) {
      if (!occ[at(x, y - 1, z)] || occ[at(x, y, z)]) continue;
      let ok = true;
      for (let k = 1; k < need && ok; k++) ok = !occ[at(x, y + k, z)];
      if (ok) out.push({ ix: x, iy: y, iz: z, top: origin[1] + y * cell, x: origin[0] + (x + 0.5) * cell, z: origin[2] + (z + 0.5) * cell });
      break; // lowest surface only (the floor or the ground)
    }
  }
  return out;
}

// A pad is flat when every column within the pad radius has its top at the
// same height (so the parcel lands at the pad's height), no column within
// `margin` beyond it is higher, and all of them are free for `headroom` above.
function flatPatch(world, s, radius, margin, headroom) {
  const { origin, cell, dims, occ } = world.grid;
  const [NX, NY, NZ] = dims;
  const at = (x, y, z) => x + NX * (y + NY * z);
  const R = Math.ceil((radius + margin) / cell);
  const need = Math.ceil(headroom / cell);
  if (s.iy + need >= NY) return false;
  for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    const X = s.ix + dx, Z = s.iz + dz;
    const cx = Math.max(origin[0] + X * cell, Math.min(s.x, origin[0] + (X + 1) * cell));
    const cz = Math.max(origin[2] + Z * cell, Math.min(s.z, origin[2] + (Z + 1) * cell));
    const d = Math.hypot(cx - s.x, cz - s.z);
    if (d > radius + margin) continue;
    if (X < 0 || Z < 0 || X >= NX || Z >= NZ) return false;
    if (d <= radius && !occ[at(X, s.iy - 1, Z)]) return false;
    for (let k = 0; k < need; k++) if (occ[at(X, s.iy + k, Z)]) return false;
  }
  return true;
}

// Can a drone in the waypoint graph get a clear view of / path to `p`?
// Tries waypoints directly, then random free viewpoints near p that connect
// to a waypoint. `view(q)` decides whether viewpoint q achieves the goal.
// Returns the viewpoint (privileged: used only by the oracle baseline).
function viewpoint(world, p, view, R, near = 6, tries = 80) {
  const r = world.physics.droneRadius;
  const nodes = world.nodeIds.map((id) => world.nodes[id]).sort((a, b) => v.dist(a, p) - v.dist(b, p)).slice(0, 12);
  for (const w of nodes) if (view(w)) return w.slice();
  let best = null;
  for (let i = 0; i < tries; i++) {
    const q = r2([p[0] + (R.next() * 2 - 1) * near, p[1] + R.next() * 2, p[2] + (R.next() * 2 - 1) * near]);
    if (world.sphereHits(q, r + 0.1) || !view(q)) continue;
    if (!nodes.some((w) => world.segmentClear(q, w, r + 0.05))) continue;
    if (!best || v.dist(q, p) > v.dist(best, p)) best = q; // farthest: easiest to reach in time
  }
  return best;
}

// Farthest-point sample `n` spots so targets spread over the whole map.
function spread(spots, n) {
  if (spots.length <= n) return spots.slice();
  const chosen = [spots[0]];
  const d = spots.map((s) => Math.hypot(s.x - spots[0].x, s.z - spots[0].z));
  while (chosen.length < n) {
    let bi = 0;
    for (let k = 1; k < spots.length; k++) if (d[k] > d[bi]) bi = k;
    chosen.push(spots[bi]);
    for (let k = 0; k < spots.length; k++) d[k] = Math.min(d[k], Math.hypot(spots[k].x - spots[bi].x, spots[k].z - spots[bi].z));
  }
  return chosen;
}

// opts.spotFilter(target) can forbid target spots (for example, ground the scan
// barely captured); it is applied after the geometric checks, so environments
// without one generate exactly as before.
export function makeMissionSets(world, task, cfg, { spotFilter } = {}) {
  const R = rng(cfg.seed);
  const r = world.physics.droneRadius;
  const total = cfg.train + cfg.dev + cfg.test;
  const isSearch = cfg.kind === "find-beacon";
  const [NX, , NZ] = world.grid.dims;
  const surfaces = columnSurfaces(world, { headroom: isSearch ? 1.0 : cfg.releaseHeight + r + 0.5, stride: NX * NZ < 20000 ? 1 : 2, mode: cfg.surface ?? "lowest" });
  // ---- target spots ----
  const spots = [];
  for (const s of surfaces) {
    if (isSearch) {
      // A hiker lying on the ground: the beacon sits 0.3 above the surface.
      const t = [s.x, s.top + 0.3, s.z];
      if (world.sphereHits(t, 0.1)) continue;
      if (spotFilter && !spotFilter(t)) continue;
      spots.push({ ...s, target: r2(t) });
    } else {
      if (!flatPatch(world, s, cfg.padRadius, 0.1, cfg.releaseHeight + r + 0.3)) continue;
      const pad = [s.x, s.top, s.z];
      const hover = v.add(pad, [0, cfg.releaseHeight, 0]);
      if (world.sphereHits(hover, r + 0.05)) continue;
      const release = v.add(hover, [0, -r - cfg.parcelRadius - 0.02, 0]);
      if (!world.segmentClear(release, v.add(pad, [0, cfg.parcelRadius + 0.02, 0]), cfg.parcelRadius)) continue;
      if (spotFilter && !spotFilter(pad)) continue;
      spots.push({ ...s, target: r2(pad), hover: r2(hover) });
    }
  }
  // Shuffle, then keep only reachable spots, then spread them out.
  for (let i = spots.length - 1; i > 0; i--) { const j = Math.floor(R.next() * (i + 1)); [spots[i], spots[j]] = [spots[j], spots[i]]; }
  const reachable = [];
  for (const s of spots) {
    if (reachable.length >= total * 6) break;
    // Keep away from the crop edge, where the map is sealed.
    const b = world.bounds, edge = 1.0;
    if (s.x < b.min[0] + edge || s.x > b.max[0] - edge || s.z < b.min[2] + edge || s.z > b.max[2] - edge) continue;
    const vp = isSearch
      ? viewpoint(world, s.target, (q) => lineOfSight(world, q, s.target, cfg.detectionRange - 0.5), R)
      : viewpoint(world, s.hover, (q) => world.segmentClear(q, s.hover, r + 0.05), R, 4);
    if (vp) reachable.push({ ...s, viewpoint: vp });
  }
  const targets = spread(reachable, Math.min(reachable.length, total * 2));
  for (let i = targets.length - 1; i > 0; i--) { const j = Math.floor(R.next() * (i + 1)); [targets[i], targets[j]] = [targets[j], targets[i]]; }
  // ---- pair each target with a launch waypoint ----
  const starts = world.nodeIds.map((id) => ({ id, p: world.nodes[id] }));
  const missions = [];
  for (const s of targets) {
    if (missions.length >= total) break;
    const goal = isSearch ? s.target : s.hover;
    const ok = starts.filter(({ p }) => {
      const d = Math.hypot(p[0] - goal[0], p[2] - goal[2]);
      if (d < cfg.minDist || d > cfg.maxDist) return false;
      // Search: hidden at launch (RescueMission requires it). Delivery: no
      // straight clear line, so the drone must navigate around something.
      return isSearch ? !lineOfSight(world, p, goal, Infinity) : !world.segmentClear(p, goal, r);
    });
    if (!ok.length) continue;
    const st = ok[Math.floor(R.next() * ok.length)];
    const m = { kind: cfg.kind, start: st.p.slice(), startWaypoint: st.id, targetPosition: s.target, oracleViewpoint: s.viewpoint, timeLimitSeconds: cfg.timeLimitSeconds, straight_m: Math.round(Math.hypot(st.p[0] - goal[0], st.p[2] - goal[2]) * 10) / 10 };
    if (isSearch) m.detectionRange = cfg.detectionRange;
    else for (const k of ["padRadius", "releaseHeight", "parcelRadius", "maxHoldSpeed", "requiredHoldSeconds", "requireNoContactDuringHold", "gravity", "landingHeightTolerance"]) m[k] = cfg[k];
    missions.push(m);
  }
  if (missions.length < total) throw new Error(`${task}: only ${missions.length}/${total} feasible missions (${spots.length} spots, ${reachable.length} reachable)`);
  const take = (from, n, prefix, base) => missions.slice(from, from + n).map((m, i) => ({ id: `${cfg.idPrefix ?? ""}${prefix}${i + 1}`, ...m, seeds: [base + i * 10 + 1, base + i * 10 + 2] }));
  return {
    train: take(0, cfg.train, "T", cfg.windBase),
    dev: take(cfg.train, cfg.dev, "D", cfg.windBase + 10000),
    test: take(cfg.train + cfg.dev, cfg.test, "X", cfg.windBase + 20000),
    stats: { surfaces: surfaces.length, spots: spots.length, reachableChecked: reachable.length, spread: targets.length },
  };
}
