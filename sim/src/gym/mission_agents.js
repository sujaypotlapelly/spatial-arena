// Non-LLM controllers for the search and delivery benchmarks (RescueMission,
// C3 velocity commands). Two kinds, mirroring the reach benchmark:
//  - oracle*: privileged upper bounds. They read the map's waypoint graph and,
//    for search, the hidden hiker's position. No fair controller has either.
//  - explorer / padSeeker: sensor-only baselines that see exactly what a
//    model-written program sees (the observation), with hand-written rules.
import { v } from "../world.js";
import { rng } from "../engine.js";
import { settleAndDrop } from "./mission_v2.js";

const flat = (a) => Math.hypot(a[0], a[2]);

// ---------- privileged oracle ----------
// Pure pursuit along the A* route on the waypoint graph to `goal`, then
// straight at it once the line is clear. Speed is limited so the drone can
// stop at the goal within one decision interval.
function pursue(world, goal, { speed = 4, dt = 1 } = {}) {
  const r = world.physics.droneRadius;
  const nodes = world.nodeIds.map((id) => [id, world.nodes[id]]).sort((a, b) => v.dist(a[1], goal) - v.dist(b[1], goal));
  const end = (nodes.find(([, p]) => world.segmentClear(p, goal, r)) || nodes[0])[0];
  let route = null;
  return (pos) => {
    let aim = goal;
    if (!world.segmentClear(pos, goal, r + 0.05)) {
      const here = world.nearestVisibleNode(pos, r);
      if (!route || route.from !== here) route = { from: here, ids: world.path(here, end) || [here] };
      const pts = [...route.ids.map((id) => world.nodes[id]), goal];
      aim = pts[0];
      for (let i = pts.length - 1; i >= 0; i--) if (world.segmentClear(pos, pts[i], r + 0.05)) { aim = pts[i]; break; }
    }
    const to = v.sub(aim, pos), d = v.len(to);
    const s = Math.min(speed, d / Math.max(dt, 0.25), Math.sqrt(2 * 7 * 0.5 * d));
    return v.scale(v.norm(to), s);
  };
}

// The oracle flies to the mission's privileged viewpoint: a reachable point
// with a clear view of the hiker, found when the mission set was generated.
export function oracleSearch(world, mission, { dt = 1 } = {}) {
  const go = pursue(world, mission.oracleViewpoint ?? mission.targetPosition, { dt });
  return async (obs) => ({ command: { velocity: go(obs.position) }, say: "oracle: A* to hidden hiker" });
}

export function oracleDelivery(world, mission, { dt = 1 } = {}) {
  const hover = v.add(mission.targetPosition, [0, mission.releaseHeight, 0]);
  // Via the privileged viewpoint, which has a clear line to the hover point.
  const toHover = pursue(world, hover, { dt });
  const toView = mission.oracleViewpoint ? pursue(world, mission.oracleViewpoint, { dt }) : toHover;
  const r = world.physics.droneRadius;
  const go = (pos) => (world.segmentClear(pos, hover, r + 0.05) ? toHover(pos) : toView(pos));
  return async (obs) => {
    const to = v.sub(hover, obs.position);
    if (v.len(to) < 0.8) {
      // Settle: proportional velocity, gentle enough to stay under the hold speed.
      const vel = v.clampLen(v.scale(to, 0.8), 0.25);
      return { command: { velocity: vel }, say: "oracle: hold over pad" };
    }
    return { command: { velocity: go(obs.position) }, say: "oracle: A* to pad" };
  };
}

// ---------- sensor-only baselines ----------
const COMPASS = { east: [1, 0], north_east: [Math.SQRT1_2, Math.SQRT1_2], north: [0, 1], north_west: [-Math.SQRT1_2, Math.SQRT1_2], west: [-1, 0], south_west: [-Math.SQRT1_2, -Math.SQRT1_2], south: [0, -1], south_east: [Math.SQRT1_2, -Math.SQRT1_2] };

// Height keeping from the up/down rays: stay about `agl` above whatever is
// below, never closer than 0.5 to the ceiling.
function climbFor(obs, agl = 1.0) {
  const { up, down } = obs.free_space_m;
  let vy = Math.max(-1, Math.min(1, agl - down));
  if (up < 0.6) vy = Math.min(vy, -0.4);
  return vy;
}

// Search explorer: favour the compass direction whose cell a few units ahead
// has been visited least, weighted by free space, with a little persistence.
export const EXPLORER_DEFAULTS = { minFree: 1.0, look: 3, cell: 2, freeWeight: 0.5, stick: 0.3, maxSpeed: 3, margin: 0.5, agl: 1.0 };
export function explorer(world, mission, params = {}) {
  const P = { ...EXPLORER_DEFAULTS, ...params };
  const visits = new Map();
  const key = (x, z) => `${Math.floor(x / P.cell)},${Math.floor(z / P.cell)}`;
  let prev = null;
  return async (obs) => {
    const [x, , z] = obs.position;
    visits.set(key(x, z), (visits.get(key(x, z)) || 0) + 1);
    let best = null;
    for (const [name, d] of Object.entries(COMPASS)) {
      const free = obs.free_space_m[name];
      if (free < P.minFree) continue;
      const ahead = Math.min(free, P.look);
      const novelty = 1 / (1 + (visits.get(key(x + d[0] * ahead, z + d[1] * ahead)) || 0));
      const score = novelty + P.freeWeight * Math.min(free, 6) / 6 + (name === prev ? P.stick : 0);
      if (!best || score > best.score) best = { name, d, free, score };
    }
    if (!best) return { command: { velocity: [0, 0.5, 0] }, say: "boxed in" };
    prev = best.name;
    const speed = Math.max(0.5, Math.min(P.maxSpeed, best.free - P.margin));
    return { command: { velocity: [best.d[0] * speed, climbFor(obs, P.agl), best.d[1] * speed] }, say: `explore ${best.name}` };
  };
}

// Delivery pad seeker: the reach avoider toward the hover point (whose
// position the delivery observation gives), then a gentle hold over it.
export const PADSEEKER_DEFAULTS = { minFree: 1.0, freeWeight: 0.6, freeCap: 4, stick: 0.15, maxSpeed: 3, margin: 0.5, holdRadius: 1.0, holdGain: 0.8, holdSpeed: 0.25 };
export function padSeeker(world, mission, params = {}) {
  const P = { ...PADSEEKER_DEFAULTS, ...params };
  let prev = null;
  return async (obs) => {
    const to = v.sub(obs.goal.position, obs.position);
    if (v.len(to) < P.holdRadius) return { command: { velocity: v.clampLen(v.scale(to, P.holdGain), P.holdSpeed) }, say: "hold over pad" };
    const f = flat(to) || 1, g = [to[0] / f, to[2] / f];
    let best = null;
    for (const [name, d] of Object.entries(COMPASS)) {
      const free = obs.free_space_m[name];
      if (free < P.minFree) continue;
      const score = d[0] * g[0] + d[1] * g[1] + P.freeWeight * Math.min(free, P.freeCap) / P.freeCap + (name === prev ? P.stick : 0);
      if (!best || score > best.score) best = { name, d, score, free };
    }
    if (!best) return { command: { velocity: [0, 0.5, 0] }, say: "boxed in" };
    prev = best.name;
    const speed = Math.min(P.maxSpeed, best.free - P.margin, f);
    return { command: { velocity: [best.d[0] * speed, Math.max(-1, Math.min(1, to[1])), best.d[1] * speed] }, say: `go ${best.name}` };
  };
}

// Frontier explorer (sensors "map-v5pilot", the v5 pilot's map): fly toward
// the nearest seen-but-unsearched place that map reports, preferring ones with
// a clear straight line, with the same compass avoidance as the pad seeker.
// Kept to re-fly the v5 pilot. That map's straight_line_clear read the true
// geometry, so this is not a senses-only baseline; coverageSweep is.
export const FRONTIER_DEFAULTS = { minFree: 1.0, freeWeight: 0.5, freeCap: 4, stick: 0.15, maxSpeed: 3.5, margin: 0.5, preferClear: 6 };
export function frontierExplorer(world, mission, params = {}) {
  const P = { ...FRONTIER_DEFAULTS, ...params };
  const fallback = explorer(world, mission);
  let prev = null;
  return async (obs) => {
    const fr = obs.map?.nearest_unsearched ?? [];
    if (!fr.length) return fallback(obs);
    const pick = fr.reduce((b, f) => { const c = f.distance_m - (f.straight_line_clear ? P.preferClear : 0); return !b || c < b.c ? { f, c } : b; }, null).f;
    const to = v.sub(pick.position, obs.position);
    const f = flat(to) || 1, g = [to[0] / f, to[2] / f];
    let best = null;
    for (const [name, d] of Object.entries(COMPASS)) {
      const free = obs.free_space_m[name];
      if (free < P.minFree) continue;
      const score = d[0] * g[0] + d[1] * g[1] + P.freeWeight * Math.min(free, P.freeCap) / P.freeCap + (name === prev ? P.stick : 0);
      if (!best || score > best.score) best = { name, d, score, free };
    }
    if (!best) return { command: { velocity: [0, 0.5, 0] }, say: "boxed in" };
    prev = best.name;
    const speed = Math.min(P.maxSpeed, best.free - P.margin);
    return { command: { velocity: [best.d[0] * speed, Math.max(-1, Math.min(1, to[1])), best.d[1] * speed] }, say: `to unsearched ${pick.direction}` };
  };
}

// ---------- missions v2 sensor-only references ----------
// All of these see exactly what a model-written program sees with the same
// --sensors setting. None reads the collision map or the hidden hiker.

// Compass step toward a horizontal direction g (unit [x, z]) using only
// free_space_m: the reach avoider's scoring, shared by the v2 baselines.
function avoidToward(obs, g, P, prev) {
  let best = null;
  for (const [name, d] of Object.entries(COMPASS)) {
    const free = obs.free_space_m[name];
    if (free < P.minFree) continue;
    const score = d[0] * g[0] + d[1] * g[1] + P.freeWeight * Math.min(free, P.freeCap) / P.freeCap + (name === prev ? P.stick : 0);
    if (!best || score > best.score) best = { name, d, score, free };
  }
  return best;
}

// Coverage sweep (sensors "map"): plans on the drone's OWN onboard map only.
// Shortest path through cells known to be open to the nearest cell of the
// search area that is open but not yet searched, or open and next to an
// unknown cell (a frontier); steer at the farthest point of that path that a
// straight line through known-open cells reaches; local avoidance from
// free_space_m. When nothing is left to search, it falls back to the explorer.
export const SWEEP_DEFAULTS = { agl: 1.3, maxSpeed: 3, look: 6, minFree: 0.8, freeWeight: 0.35, freeCap: 4, stick: 0.1, obstacleCost: 3 };
export function coverageSweep(world, mission, params = {}) {
  const P = { ...SWEEP_DEFAULTS, ...params };
  const fallback = explorer(world, mission);
  let prev = null;
  return async (obs) => {
    const m = obs.map;
    if (!m?.rows) throw new Error("coverageSweep needs --sensors map");
    const area = obs.search?.area;
    const NX = m.rows[0].length, NZ = m.rows.length;
    const ch = (i, j) => (i < 0 || j < 0 || i >= NX || j >= NZ ? "#" : m.rows[j][i]);
    const open = (i, j) => { const c = ch(i, j); return c === "." || c === "s"; };
    const inA = (i, j) => !area || (m.x0 + i + 0.5 >= area.min[0] && m.x0 + i + 0.5 <= area.max[0] && m.z0 + j + 0.5 >= area.min[1] && m.z0 + j + 0.5 <= area.max[1]);
    const nearObstacle = (i, j) => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (ch(i + a, j + b) === "#") return true; return false; };
    const ci = Math.floor((obs.position[0] - m.x0) / m.cell_m), cj = Math.floor((obs.position[2] - m.z0) / m.cell_m);
    // Dijkstra over known-open cells (8-connected, no corner cutting).
    const N = NX * NZ, dist = new Float64Array(N).fill(Infinity), prevCell = new Int32Array(N).fill(-1);
    const id = (i, j) => i + NX * j;
    const start = id(Math.max(0, Math.min(NX - 1, ci)), Math.max(0, Math.min(NZ - 1, cj)));
    dist[start] = 0;
    const queue = [start];
    const done = new Uint8Array(N);
    while (queue.length) {
      let bi = 0;
      for (let k = 1; k < queue.length; k++) if (dist[queue[k]] < dist[queue[bi]]) bi = k;
      const a = queue[bi]; queue[bi] = queue[queue.length - 1]; queue.pop();
      if (done[a]) continue;
      done[a] = 1;
      const ai = a % NX, aj = (a - ai) / NX;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const bi2 = ai + di, bj = aj + dj;
        if (!open(bi2, bj) || (di && dj && (!open(ai + di, aj) || !open(ai, aj + dj)))) continue;
        const w = (di && dj ? Math.SQRT2 : 1) + (nearObstacle(bi2, bj) ? P.obstacleCost : 0);
        const b = id(bi2, bj);
        if (dist[a] + w < dist[b]) { dist[b] = dist[a] + w; prevCell[b] = a; queue.push(b); }
      }
    }
    // Goal: nearest reachable cell in the area that still needs looking at.
    let goal = -1;
    for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
      const k = id(i, j);
      if (dist[k] === Infinity || !inA(i, j)) continue;
      const need = ch(i, j) === "." || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => ch(i + a, j + b) === "?" && inA(i + a, j + b));
      if (need && (goal < 0 || dist[k] < dist[goal])) goal = k;
    }
    if (goal < 0) return fallback(obs);
    const path = [];
    for (let k = goal; k >= 0; k = prevCell[k]) path.push(k);
    path.reverse();
    const centre = (k) => [m.x0 + (k % NX) + 0.5, m.z0 + Math.floor(k / NX) + 0.5];
    const lineOpen = (a, b) => { const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25); for (let s = 0; s <= n; s++) { const x = a[0] + ((b[0] - a[0]) * s) / Math.max(n, 1), z = a[1] + ((b[1] - a[1]) * s) / Math.max(n, 1); if (!open(Math.floor(x - m.x0), Math.floor(z - m.z0))) return false; } return true; };
    const here = [obs.position[0], obs.position[2]];
    let aim = centre(path[Math.min(1, path.length - 1)]);
    for (let k = Math.min(path.length - 1, P.look); k >= 1; k--) if (lineOpen(here, centre(path[k]))) { aim = centre(path[k]); break; }
    const to = [aim[0] - here[0], aim[1] - here[1]], f = Math.hypot(to[0], to[1]) || 1;
    const best = avoidToward(obs, [to[0] / f, to[1] / f], P, prev);
    if (!best) return { command: { velocity: [0, 0.5, 0] }, say: "boxed in" };
    prev = best.name;
    const speed = Math.max(0.5, Math.min(P.maxSpeed, best.free - 0.5, f + 0.5));
    return { command: { velocity: [best.d[0] * speed, climbFor(obs, P.agl), best.d[1] * speed] }, say: `sweep to ${aim.map((x) => x.toFixed(1))}` };
  };
}

// Lane sweep: the textbook search pattern. Parallel north-south lanes across
// the assigned area, spaced 1.6 detection ranges apart, flown in order from
// the lane nearest the launch, with free_space_m avoidance. A waypoint is
// dropped when reached (within 1.5) or after 20 s. Sensors: basic is enough.
export const LANES_DEFAULTS = { agl: 1.3, maxSpeed: 3, spacing: 1.6, minFree: 0.8, freeWeight: 0.5, freeCap: 4, stick: 0.15, reach: 1.5, patience: 20 };
export function laneSweep(world, mission, params = {}) {
  const P = { ...LANES_DEFAULTS, ...params };
  let wps = null, k = 0, since = 0, prev = null;
  return async (obs) => {
    const area = obs.search?.area;
    if (!area) throw new Error("laneSweep needs a search area");
    if (!wps) {
      const gap = P.spacing * obs.search.detection_range, inset = gap / 2;
      const xs = [];
      for (let x = area.min[0] + inset; x <= area.max[0] - inset + 1e-9; x += gap) xs.push(x);
      if (Math.abs(obs.position[0] - xs[0]) > Math.abs(obs.position[0] - xs.at(-1))) xs.reverse();
      const zs = [area.min[1] + inset, area.max[1] - inset];
      if (Math.abs(obs.position[2] - zs[0]) > Math.abs(obs.position[2] - zs[1])) zs.reverse();
      wps = [];
      xs.forEach((x, i) => { const [a, b] = i % 2 ? [zs[1], zs[0]] : zs; for (let s = 0; s <= 4; s++) wps.push([x, a + ((b - a) * s) / 4]); });
      since = obs.time_s;
    }
    while (k < wps.length && (Math.hypot(wps[k][0] - obs.position[0], wps[k][1] - obs.position[2]) < P.reach || obs.time_s - since > P.patience)) { k++; since = obs.time_s; }
    if (k >= wps.length) { k = 0; since = obs.time_s; }
    const to = [wps[k][0] - obs.position[0], wps[k][1] - obs.position[2]], f = Math.hypot(to[0], to[1]) || 1;
    const best = avoidToward(obs, [to[0] / f, to[1] / f], P, prev);
    if (!best) return { command: { velocity: [0, 0.5, 0] }, say: "boxed in" };
    prev = best.name;
    const speed = Math.max(0.5, Math.min(P.maxSpeed, best.free - 0.5, f + 0.5));
    return { command: { velocity: [best.d[0] * speed, climbFor(obs, P.agl), best.d[1] * speed] }, say: `lane waypoint ${k + 1}/${wps.length}` };
  };
}

// Random walk: hold a random compass heading for 3 to 8 s or until less than
// 1.5 is free ahead, then pick another open one at random. Turns back toward
// the area centre when outside the assigned area. Its own random generator,
// seeded from the wind seed but not equal to it.
export function randomWalk(world, mission, seed = 1, params = {}) {
  const P = { agl: 1.3, maxSpeed: 3, ...params };
  const R = rng((seed ^ 0x5eed5eed) >>> 0);
  let dir = null, until = 0;
  return async (obs) => {
    const area = obs.search?.area;
    const names = Object.keys(COMPASS);
    const outside = area && (obs.position[0] < area.min[0] || obs.position[0] > area.max[0] || obs.position[2] < area.min[1] || obs.position[2] > area.max[1]);
    if (!dir || obs.time_s >= until || obs.free_space_m[dir] < 1.5 || outside) {
      let options = names.filter((n) => obs.free_space_m[n] >= 1.5);
      if (outside) {
        const c = [(area.min[0] + area.max[0]) / 2 - obs.position[0], (area.min[1] + area.max[1]) / 2 - obs.position[2]];
        const inward = options.filter((n) => COMPASS[n][0] * c[0] + COMPASS[n][1] * c[1] > 0);
        if (inward.length) options = inward;
      }
      if (!options.length) options = names.filter((n) => obs.free_space_m[n] >= 0.5);
      if (!options.length) return { command: { velocity: [0, 0.5, 0] }, say: "boxed in" };
      dir = options[Math.floor(R.next() * options.length)];
      until = obs.time_s + 3 + R.next() * 5;
    }
    const d = COMPASS[dir], speed = Math.max(0.5, Math.min(P.maxSpeed, obs.free_space_m[dir] - 0.5));
    return { command: { velocity: [d[0] * speed, climbFor(obs, P.agl), d[1] * speed] }, say: `random ${dir}` };
  };
}

// Delivery (package-drop), sensors only: the pad seeker toward a point 1
// above the pad (its position is in the observation), then settle and
// release as the map-equipped oracle does.
export function dropSeeker(world, mission, params = {}) {
  const seek = padSeeker(world, mission, { holdRadius: 0, ...params });
  return async (obs) => {
    const hover = v.add(obs.delivery.pad_position, [0, 1, 0]);
    let far = null;
    if (obs.delivery.parcel_status === "carried" && !(v.dist(obs.position, hover) < 2.5 && obs.goal.in_line_of_sight)) {
      far = (await seek({ ...obs, goal: { ...obs.goal, position: hover } })).command.velocity;
    }
    return settleAndDrop(obs, hover, () => far);
  };
}
