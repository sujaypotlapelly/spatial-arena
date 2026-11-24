// Missions v2: a sound search task and a complete delivery task.
//
// Search. A rescue team assigns the drone a search sector (a rectangle). The
// hiker lies somewhere on open, walkable floor inside it: floor connected to
// the building's main floor, with room for a person to stand (1.8 units of
// headroom) and lie down (the neighbouring floor is walkable too). The drone
// launches inside the sector, cannot see the hiker from there, and must be
// able to reach a place that sees the hiker: every target is checked against
// a flight lattice built from the collision map. Detection is the mission's
// rule: within detectionRange with a clear line of sight.
//
// Everything in this file that reads the collision map is privileged. It is
// used to generate the sets and by the two map-equipped reference
// controllers (mapCover: knows the map, not the hiker; mapOracle: knows both).
// No model-written program or sensor-only controller ever calls it.
import { v } from "../world.js";
import { rng } from "../engine.js";
import { lineOfSight } from "./core.js";
import { columnSurfaces, makeMissionSets } from "./mission_sets.js";

const r2 = (p) => p.map((x) => Math.round(x * 100) / 100);

// ---------- walkable floor ----------
// Columns (0.5-unit stride on a 0.25 grid) whose lowest surface has 1.8 of
// headroom, 4-connected where neighbouring tops differ by at most 0.35 (a
// step a person can take). The largest component is the main floor. A person
// spot is a main-floor column whose 8 neighbours are main floor too.
export function walkableFloor(world, { headroom = 1.8, stepUp = 0.35 } = {}) {
  const surf = columnSurfaces(world, { headroom, stride: 2 });
  const key = (ix, iz) => `${ix},${iz}`;
  const at = new Map(surf.map((s) => [key(s.ix, s.iz), s]));
  const comp = new Map();
  let best = null;
  for (const s of surf) {
    const k0 = key(s.ix, s.iz);
    if (comp.has(k0)) continue;
    const id = comp.size, members = [s], stack = [s];
    comp.set(k0, id);
    while (stack.length) {
      const c = stack.pop();
      for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
        const k = key(c.ix + dx, c.iz + dz), n = at.get(k);
        if (!n || comp.has(k) || Math.abs(n.top - c.top) > stepUp) continue;
        comp.set(k, id); members.push(n); stack.push(n);
      }
    }
    if (!best || members.length > best.members.length) best = { id, members };
  }
  const main = new Set(best.members.map((s) => key(s.ix, s.iz)));
  const spots = [];
  for (const s of best.members) {
    let ok = true;
    for (let dx = -2; dx <= 2 && ok; dx += 2) for (let dz = -2; dz <= 2 && ok; dz += 2) ok = main.has(key(s.ix + dx, s.iz + dz));
    if (!ok) continue;
    const t = r2([s.x, s.top + 0.3, s.z]);
    if (world.sphereHits(t, 0.1)) continue;
    spots.push({ x: s.x, z: s.z, top: s.top, target: t });
  }
  return { columns: best.members.length, spots };
}

// ---------- flight lattice over a region ----------
// Nodes every `cell` units in x, y, z inside [min, max] (x, z from the region,
// y from the world bounds) where a sphere of radius droneRadius + 0.1 is free.
// (At 1-unit spacing the factory's doorways disconnect; 0.5 keeps them.)
// Edges join 26-neighbours whose straight segment is clear for droneRadius + 0.05.
export function flightLattice(world, region, { cell = 0.5, pad = 0.1 } = {}) {
  const r = world.physics.droneRadius;
  const b = world.bounds;
  const xs = [], ys = [], zs = [];
  for (let x = Math.max(region.min[0], b.min[0] + 0.5); x <= Math.min(region.max[0], b.max[0] - 0.5); x += cell) xs.push(x);
  for (let y = b.min[1] + 0.75; y <= b.max[1] - 0.5; y += cell) ys.push(y);
  for (let z = Math.max(region.min[1], b.min[2] + 0.5); z <= Math.min(region.max[1], b.max[2] - 0.5); z += cell) zs.push(z);
  const idx = (i, j, k) => i + xs.length * (j + ys.length * k);
  const pos = [], id = new Int32Array(xs.length * ys.length * zs.length).fill(-1);
  for (let k = 0; k < zs.length; k++) for (let j = 0; j < ys.length; j++) for (let i = 0; i < xs.length; i++) {
    const p = [xs[i], ys[j], zs[k]];
    if (world.sphereHits(p, r + pad)) continue;
    id[idx(i, j, k)] = pos.length; pos.push(p);
  }
  const adj = pos.map(() => []);
  const ijk = [];
  for (let k = 0; k < zs.length; k++) for (let j = 0; j < ys.length; j++) for (let i = 0; i < xs.length; i++) if (id[idx(i, j, k)] >= 0) ijk[id[idx(i, j, k)]] = [i, j, k];
  for (let a = 0; a < pos.length; a++) {
    const [i, j, k] = ijk[a];
    for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!(dk > 0 || (dk === 0 && (dj > 0 || (dj === 0 && di > 0))))) continue;
      const I = i + di, J = j + dj, K = k + dk;
      if (I < 0 || J < 0 || K < 0 || I >= xs.length || J >= ys.length || K >= zs.length) continue;
      const bId = id[idx(I, J, K)];
      if (bId < 0 || !world.segmentClear(pos[a], pos[bId], r + 0.05)) continue;
      const w = Math.hypot(di, dj, dk) * cell;
      adj[a].push([bId, w]); adj[bId].push([a, w]);
    }
  }
  const nearest = (p, { clear = true } = {}) => {
    let best = -1, bd = Infinity;
    for (let n = 0; n < pos.length; n++) { const d = v.dist(p, pos[n]); if (d < bd && (!clear || world.segmentClear(p, pos[n], r))) { bd = d; best = n; } }
    return best;
  };
  return { pos, adj, nearest };
}

// Dijkstra from `src` over the lattice: { dist, prev }.
export function dijkstra(L, src) {
  const n = L.pos.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
  dist[src] = 0;
  // Binary heap of [d, node].
  const heap = [[0, src]];
  const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  while (heap.length) {
    const [d, a] = pop();
    if (done[a]) continue;
    done[a] = 1;
    for (const [b, w] of L.adj[a]) if (d + w < dist[b]) { dist[b] = d + w; prev[b] = a; push([dist[b], b]); }
  }
  return { dist, prev };
}

const pathTo = (prev, to) => { const out = []; for (let a = to; a >= 0; a = prev[a]) out.push(a); return out.reverse(); };
const inArea = (p, area, m = 0) => p[0] >= area.min[0] - m && p[0] <= area.max[0] + m && p[2] >= area.min[1] - m && p[2] <= area.max[1] + m;

// ---------- search sets ----------
// cfg: { seed, windBase, train, dev, sector, margin, detectionRange,
//        timeLimitSeconds, minTargetDist, idPrefix }
// No test set is built here.
export function makeSearchSetsV2(world, cfg, { log = () => {} } = {}) {
  const R = rng(cfg.seed);
  const r = world.physics.droneRadius;
  const total = cfg.train + cfg.dev;
  const floor = walkableFloor(world);
  const spots = floor.spots.slice();
  for (let i = spots.length - 1; i > 0; i--) { const j = Math.floor(R.next() * (i + 1)); [spots[i], spots[j]] = [spots[j], spots[i]]; }
  const b = world.bounds, S = cfg.sector;
  const missions = [], used = [];
  let tried = 0;
  for (const s of spots) {
    if (missions.length >= total) break;
    // Targets at least 4 units apart, so no two missions share a hiding place.
    if (used.some((u) => Math.hypot(u[0] - s.x, u[1] - s.z) < 4)) continue;
    tried++;
    // Sector: the target uniformly placed inside it, sector kept inside the map.
    const lo = [Math.max(b.min[0] + 0.5, Math.min(s.x - 2 - R.next() * (S - 4), b.max[0] - 0.5 - S)), Math.max(b.min[2] + 0.5, Math.min(s.z - 2 - R.next() * (S - 4), b.max[2] - 0.5 - S))];
    const area = { min: r2(lo), max: r2([lo[0] + S, lo[1] + S]) };
    const L = flightLattice(world, { min: [area.min[0] - cfg.margin, area.min[1] - cfg.margin], max: [area.max[0] + cfg.margin, area.max[1] + cfg.margin] });
    // Launch candidates: lattice nodes inside the sector, 1 to 2.6 above the
    // floor under them, not seeing the target, at least minTargetDist away.
    const below = (p) => { let d = 0; while (d < 6 && !world.sphereHits(v.add(p, [0, -(d + 0.25), 0]), r)) d += 0.25; return d; };
    const starts = [];
    for (let n = 0; n < L.pos.length; n++) {
      const p = L.pos[n];
      if (!inArea(p, area, -1) || L.adj[n].length < 6) continue;
      const h = below(p);
      if (h < 1 || h > 2.6) continue;
      if (Math.hypot(p[0] - s.x, p[2] - s.z) < cfg.minTargetDist) continue;
      if (lineOfSight(world, p, s.target, Infinity)) continue;
      starts.push(n);
    }
    if (!starts.length) continue;
    const st = starts[Math.floor(R.next() * starts.length)];
    const { dist } = dijkstra(L, st);
    // Reachable: some reachable lattice node sees the target with 0.5 to spare.
    let view = -1;
    for (let n = 0; n < L.pos.length; n++) if (dist[n] < Infinity && lineOfSight(world, L.pos[n], s.target, cfg.detectionRange - 0.5) && (view < 0 || dist[n] < dist[view])) view = n;
    if (view < 0) continue;
    used.push([s.x, s.z]);
    missions.push({ kind: "find-beacon", start: r2(L.pos[st]), targetPosition: s.target, searchArea: area, detectionRange: cfg.detectionRange, timeLimitSeconds: cfg.timeLimitSeconds,
      oracleViewpoint: r2(L.pos[view]), oracleRoute_m: Math.round(dist[view] * 10) / 10, straight_m: Math.round(Math.hypot(L.pos[st][0] - s.x, L.pos[st][2] - s.z) * 10) / 10 });
    log(`${missions.length}/${total} (tried ${tried})`);
  }
  if (missions.length < total) throw new Error(`search v2: only ${missions.length}/${total} feasible missions`);
  const take = (from, n, prefix, base) => missions.slice(from, from + n).map((m, i) => ({ id: `${cfg.idPrefix}${prefix}${i + 1}`, ...m, seeds: [base + i * 10 + 1, base + i * 10 + 2] }));
  return {
    train: take(0, cfg.train, "T", cfg.windBase),
    dev: take(cfg.train, cfg.dev, "D", cfg.windBase + 10000),
    stats: { walkableColumns: floor.columns, personSpots: floor.spots.length, targetsTried: tried },
  };
}

// ---------- delivery sets ----------
// Pads come from makeMissionSets (flat, open above, reachable by the waypoint
// graph); each mission is rewritten as a package-drop: explicit release,
// stated landing tolerance (padRadius) and release-height limit. No test set.
export function makeDeliverySetsV2(world, cfg) {
  // Pads are checked for a clear hover point 1 unit above them (where the
  // reference controllers release) and a clear fall from there.
  const base = makeMissionSets(world, "delivery", { ...cfg, kind: "package-delivery", releaseHeight: 1, test: 0, requiredHoldSeconds: 2, maxHoldSpeed: 0.35, requireNoContactDuringHold: true });
  const conv = (m) => ({ id: m.id, kind: "package-drop", start: m.start, startWaypoint: m.startWaypoint, targetPosition: m.targetPosition, oracleViewpoint: m.oracleViewpoint,
    timeLimitSeconds: cfg.timeLimitSeconds, straight_m: m.straight_m, padRadius: cfg.padRadius, maxReleaseHeight: cfg.maxReleaseHeight, parcelRadius: cfg.parcelRadius,
    gravity: cfg.gravity, landingHeightTolerance: cfg.landingHeightTolerance, seeds: m.seeds });
  return { train: base.train.map(conv), dev: base.dev.map(conv), stats: base.stats };
}

// ---------- map-equipped reference controllers (privileged) ----------
// Follow a lattice path with pure pursuit: aim at the farthest of the next 8
// path points with a clear straight line, at up to `speed`.
function follower(world, pts, { speed = 3.5, dt = 1 } = {}) {
  const r = world.physics.droneRadius;
  let i = 0;
  return (pos) => {
    while (i < pts.length - 1 && v.dist(pos, pts[i]) < 0.7) i++;
    let aim = pts[i];
    for (let k = Math.min(pts.length - 1, i + 8); k > i; k--) if (world.segmentClear(pos, pts[k], r + 0.05)) { aim = pts[k]; i = Math.max(i, k - 1); break; }
    const to = v.sub(aim, pos), d = v.len(to);
    if (d < 1e-6) return [0, 0, 0];
    const s = Math.min(speed, d / Math.max(dt, 0.25) + 0.5, Math.sqrt(2 * 7 * 0.5 * d) + 0.5);
    return v.scale(v.norm(to), s);
  };
}

// Visibility of candidate hiding places (person spots in the sector, one per
// 1-unit cell) from viewing nodes: lattice nodes on a 1-unit sub-grid within
// the sector plus 3, from 0.6 to 2.8 above the sector's lowest floor.
function coverageModel(world, L, area, range, spots) {
  const seenCell = new Set();
  const cand = spots.filter((s) => inArea(s.target, area)).filter((s) => { const k = `${Math.floor(s.x)},${Math.floor(s.z)}`; if (seenCell.has(k)) return false; seenCell.add(k); return true; });
  const floorY = Math.min(...cand.map((c) => c.top));
  const onSub = (x) => Math.abs(x - Math.round(x)) < 0.01 || Math.abs(x - Math.round(x)) > 0.99;
  const sees = L.pos.map((p) => {
    if (!inArea(p, area, 3) || p[1] < floorY + 0.6 || p[1] > floorY + 2.8 || !onSub(p[0] - L.pos[0][0]) || !onSub(p[2] - L.pos[0][2])) return [];
    const out = [];
    cand.forEach((c, ci) => { if (Math.abs(c.target[0] - p[0]) <= range && Math.abs(c.target[2] - p[2]) <= range && lineOfSight(world, p, c.target, range)) out.push(ci); });
    return out;
  });
  return { cand, sees };
}

// mapCover: knows the collision map and the walkable floor, NOT the hiker.
// Plans a greedy coverage tour: repeatedly go to the reachable node with the
// best ratio of newly seen hiding places to travel distance (counting what is
// seen along the way), until every reachable hiding place has been seen.
export function planMapCover(world, mission, { floor = null, speed = 3.5 } = {}) {
  const area = mission.searchArea, M = 4;
  const L = flightLattice(world, { min: [area.min[0] - M, area.min[1] - M], max: [area.max[0] + M, area.max[1] + M] });
  const spots = (floor ?? walkableFloor(world)).spots;
  const range = mission.detectionRange - 0.3;
  const { cand, sees } = coverageModel(world, L, area, range, spots);
  const seen = new Uint8Array(cand.length);
  let cur = L.nearest(mission.start), route = [cur], time = 0, nSeen = 0;
  const mark = (n) => { for (const c of sees[n]) if (!seen[c]) { seen[c] = 1; nSeen++; } };
  mark(cur);
  for (let iter = 0; iter < 400; iter++) {
    const { dist, prev } = dijkstra(L, cur);
    let best = -1, bestScore = 0;
    for (let n = 0; n < L.pos.length; n++) {
      if (dist[n] === Infinity || !sees[n].length) continue;
      let gain = 0;
      for (const c of sees[n]) if (!seen[c]) gain++;
      if (!gain) continue;
      const score = gain / (dist[n] + 2);
      if (score > bestScore) { bestScore = score; best = n; }
    }
    if (best < 0) break;
    const p = pathTo(prev, best);
    for (const n of p.slice(1)) mark(n);
    route.push(...p.slice(1));
    time += dist[best] / speed;
    cur = best;
  }
  return { pts: route.map((n) => L.pos[n]), candidates: cand.length, coverable: nSeen, plannedSeconds: Math.round(time) };
}

export function mapCover(world, mission, opts = {}) {
  const plan = planMapCover(world, mission, opts);
  const go = follower(world, plan.pts, opts);
  const ctl = async (obs) => ({ command: { velocity: go(obs.position) }, say: "map cover" });
  ctl.plan = plan;
  return ctl;
}

// mapOracle: knows the map AND the hiker. Shortest lattice path to the
// nearest node that sees the hiker. The ceiling, not a fair comparison.
export function mapOracle(world, mission, opts = {}) {
  const area = mission.searchArea ?? { min: [mission.start[0] - 30, mission.start[2] - 30], max: [mission.start[0] + 30, mission.start[2] + 30] };
  const L = flightLattice(world, { min: [area.min[0] - 4, area.min[1] - 4], max: [area.max[0] + 4, area.max[1] + 4] });
  const { dist, prev } = dijkstra(L, L.nearest(mission.start));
  let view = -1;
  for (let n = 0; n < L.pos.length; n++) if (dist[n] < Infinity && lineOfSight(world, L.pos[n], mission.targetPosition, mission.detectionRange - 0.3) && (view < 0 || dist[n] < dist[view])) view = n;
  const pts = view < 0 ? [mission.start] : pathTo(prev, view).map((n) => L.pos[n]);
  const go = follower(world, pts, opts);
  return async (obs) => ({ command: { velocity: go(obs.position) }, say: "map oracle" });
}

// The lattice over the whole map, built once per world.
const fullLattices = new WeakMap();
export function fullLattice(world) {
  if (!fullLattices.has(world)) fullLattices.set(world, flightLattice(world, { min: [world.bounds.min[0], world.bounds.min[2]], max: [world.bounds.max[0], world.bounds.max[2]] }));
  return fullLattices.get(world);
}

// Delivery oracle: lattice path (whole map) to 1 unit above the pad, settle, release.
export function dropOracle(world, mission, opts = {}) {
  const pad = mission.targetPosition, hover = v.add(pad, [0, 1, 0]);
  const L = fullLattice(world);
  const { prev } = dijkstra(L, L.nearest(mission.start));
  const end = L.nearest(hover);
  const pts = [...pathTo(prev, end).map((n) => L.pos[n]), hover];
  const go = follower(world, pts, { ...opts, speed: 3 });
  const r = world.physics.droneRadius;
  return async (obs) => settleAndDrop(obs, hover, () => (world.segmentClear(obs.position, hover, r + 0.05) && v.dist(obs.position, hover) < 3 ? null : go(obs.position)));
}

// Shared final approach (sensor-only: it reads only the observation): a
// proportional hold over the hover point; release when the predicted landing
// point (the pad offset plus the current horizontal velocity times the fall
// time from here) is within 0.3 of the pad centre and the drone moves slower
// than 0.4.
export function settleAndDrop(obs, hover, far) {
  if (obs.delivery.parcel_status !== "carried") return { command: { velocity: [0, 0, 0] }, say: "released" };
  const vel = far();
  if (vel) return { command: { velocity: vel }, say: "to pad" };
  const [ox, oz] = obs.delivery.horizontal_offset, h = obs.delivery.height_above_pad;
  const to = [-ox, hover[1] - obs.position[1], -oz];
  const fall = Math.sqrt((2 * Math.max(h, 0.1)) / 9.81);
  const land = Math.hypot(ox + obs.velocity[0] * fall, oz + obs.velocity[2] * fall), speed = v.len(obs.velocity);
  if (land < 0.3 && h > 0.5 && h < 1.6 && speed < 0.4) return { command: { velocity: [0, 0, 0], release: true }, say: "release" };
  return { command: { velocity: v.clampLen(v.scale(to, 0.8), Math.min(2, 0.3 + v.len(to))) }, say: "settle" };
}
