// E3 Fog Search: find 3 beacons in an unknown
// building. You only see 8 m, in line of sight. Factory scan, free flight.
//
// Vision: every 0.25 s the drone sweeps 120 horizontal rays at its own height
// out to 8 m through the voxel grid. Every 0.5 m floor cell a ray crosses is
// "seen"; the cell where a ray stops, or where something lies within 0.25 m
// above or below the ray, is seen as blocked. A beacon is found
// when it is within 8 m and in line of sight (core.lineOfSight). The episode
// ends when all 3 are found, or at the time limit.
//
// Scored: time to find all 3 (null if not), beacons found, % of the reachable
// floor area explored (seen), wall contacts. The control level is pluggable
// (control.js).

import { v } from "../world.js";
import { rng } from "../engine.js";
import { FreeDrone, clearance, lineOfSight, r1, r2 } from "./core.js";
import { Control, CONTROL_LEVELS, relBearingDeg } from "./control.js";
import { bodyDirs } from "./reach.js";

export const LEVELS = CONTROL_LEVELS;
export const N_BEACONS = 3;
export const TIME_LIMIT = 180;
export const SIGHT_M = 8;
export const CELL = 0.5; // floor grid for exploration
export const BAND = [-0.25, 1.75]; // flight band (y) used to decide which floor cells are explorable
const VISION_EVERY = 15; // physics ticks (0.25 s)
const N_RAYS = 120;

// ---------- floor grid (per world, cached) ----------
// A cell is explorable if the drone fits at its centre somewhere in the band;
// "reachable" cells are those connected to the bulk of the building.
const grids = new WeakMap();
export function floorGrid(world) {
  if (grids.has(world)) return grids.get(world);
  const { min, max } = world.bounds;
  const nx = Math.ceil((max[0] - min[0]) / CELL), nz = Math.ceil((max[2] - min[2]) / CELL);
  const refY = new Float32Array(nx * nz).fill(NaN);
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const x = min[0] + (ix + 0.5) * CELL, z = min[2] + (iz + 0.5) * CELL;
      let best = null;
      for (let y = BAND[0]; y <= BAND[1] + 1e-9; y += 0.25) if (!world.sphereHits([x, y, z], world.physics.droneRadius) && (best === null || Math.abs(y - 0.75) < Math.abs(best - 0.75))) best = y;
      if (best !== null) refY[ix + nx * iz] = best;
    }
  // Connected components over explorable cells (4-neighbour, flyable step).
  const comp = new Int32Array(nx * nz).fill(-1);
  const sizes = [];
  for (let i = 0; i < nx * nz; i++) {
    if (comp[i] >= 0 || Number.isNaN(refY[i])) continue;
    const id = sizes.length;
    let n = 0;
    const stack = [i];
    comp[i] = id;
    while (stack.length) {
      const c = stack.pop();
      n++;
      const cx = c % nx, cz = (c / nx) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ex = cx + dx, ez = cz + dz;
        if (ex < 0 || ez < 0 || ex >= nx || ez >= nz) continue;
        const j = ex + nx * ez;
        if (comp[j] >= 0 || Number.isNaN(refY[j])) continue;
        const a = [min[0] + (cx + 0.5) * CELL, refY[c], min[2] + (cz + 0.5) * CELL];
        const b = [min[0] + (ex + 0.5) * CELL, refY[j], min[2] + (ez + 0.5) * CELL];
        if (!world.segmentClear(a, b, world.physics.droneRadius)) continue;
        comp[j] = id;
        stack.push(j);
      }
    }
    sizes.push(n);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  const reachable = new Uint8Array(nx * nz);
  let nReach = 0;
  for (let i = 0; i < nx * nz; i++) if (comp[i] === main) (reachable[i] = 1), nReach++;
  const g = { min, nx, nz, refY, reachable, nReach };
  grids.set(world, g);
  return g;
}
export const cellIndex = (G, p) => {
  const ix = Math.floor((p[0] - G.min[0]) / CELL), iz = Math.floor((p[2] - G.min[2]) / CELL);
  return ix < 0 || iz < 0 || ix >= G.nx || iz >= G.nz ? -1 : ix + G.nx * iz;
};
export const cellCenter = (G, i, y = null) => [G.min[0] + ((i % G.nx) + 0.5) * CELL, y ?? G.refY[i], G.min[2] + (((i / G.nx) | 0) + 0.5) * CELL];

// Point occupancy straight from the voxel grid (a ray, no radius).
function occupied(world, p) {
  const { origin, cell, dims, occ } = world.grid;
  const x = Math.floor((p[0] - origin[0]) / cell), y = Math.floor((p[1] - origin[1]) / cell), z = Math.floor((p[2] - origin[2]) / cell);
  if (x < 0 || y < 0 || z < 0 || x >= dims[0] || y >= dims[1] || z >= dims[2]) return true;
  return occ[x + dims[0] * (y + dims[1] * z)] === 1;
}

// ---------- scenario sets ----------
// Start at a waypoint; 3 beacons near other waypoints (offset up to 1.5 m
// into free space), each >= 12 m from the start (so none is visible at t=0)
// and >= 12 m from each other, all on reachable floor. Disjoint train / dev /
// held-out sets (no shared start or beacon node), deterministic.
export function makeFogSets(world, { train = 8, dev = 12, heldout = 12, seed = 20261116 } = {}) {
  const G = floorGrid(world);
  const R = rng(seed);
  const ids = world.nodeIds.filter((id) => G.reachable[cellIndex(G, world.nodes[id])]);
  const beaconAt = (id) => {
    const n = world.nodes[id];
    for (let k = 0; k < 12; k++) {
      const a = R.next() * 2 * Math.PI, d = 0.5 + R.next() * 1.0;
      const p = r2([n[0] + d * Math.cos(a), n[1], n[2] + d * Math.sin(a)]);
      const c = cellIndex(G, p);
      if (c < 0 || !G.reachable[c]) continue;
      if (world.sphereHits(p, 0.3) || !world.segmentClear(n, p, world.physics.droneRadius)) continue;
      return p;
    }
    return null;
  };
  const out = [];
  const usedStart = new Set(), usedBeacon = new Set();
  const total = train + dev + heldout;
  for (let tries = 0; tries < 5000 && out.length < total; tries++) {
    const start = ids[Math.floor(R.next() * ids.length)];
    if (usedStart.has(start)) continue;
    const s = world.nodes[start];
    const cands = ids.filter((id) => id !== start && !usedBeacon.has(id) && v.dist(world.nodes[id], s) >= 13.5);
    const picked = [];
    for (let k = 0; k < 40 && picked.length < N_BEACONS; k++) {
      const id = cands[Math.floor(R.next() * cands.length)];
      if (!id || picked.some((b) => b.node === id || v.dist(world.nodes[id], b.pos) < 12)) continue;
      const pos = beaconAt(id);
      if (!pos || v.dist(pos, s) < 12) continue;
      picked.push({ node: id, pos });
    }
    if (picked.length < N_BEACONS) continue;
    usedStart.add(start);
    for (const b of picked) usedBeacon.add(b.node);
    out.push({ start, beacons: picked.map((b) => b.pos), beaconNodes: picked.map((b) => b.node) });
  }
  if (out.length < total) throw new Error(`only ${out.length}/${total} fog scenarios could be placed`);
  const take = (from, n, prefix, seedBase) => out.slice(from, from + n).map((c, i) => ({ id: `${prefix}${i + 1}`, ...c, seeds: [seedBase + i * 10 + 1, seedBase + i * 10 + 2] }));
  return { train: take(0, train, "FT", 1010000), dev: take(train, dev, "FD", 1020000), heldout: take(train + dev, heldout, "FH", 1030000) };
}

// ---------- environment ----------
export class FogSearch {
  // opts.stopWhenFound (default true): end the episode at the third beacon.
  // Set false to fly the full time limit (coverage measurements).
  constructor(world, scenario, seed, level, { stopWhenFound = true } = {}) {
    this.stopWhenFound = stopWhenFound;
    this.coverage = []; // [t, explored %] every 30 s
    if (!world.grid) throw new Error("Fog Search needs a voxel map");
    this.world = world;
    this.P = world.physics;
    this.sc = scenario;
    this.level = level;
    this.G = floorGrid(world);
    this.beacons = scenario.beacons.map((p) => p.slice());
    this.found = this.beacons.map(() => null); // time found, or null
    this.visible = this.beacons.map(() => false);
    this.closest = this.beacons.map(() => ({ d: Infinity, t: null, at: null, occluded: false })); // for feedback
    this.drone = new FreeDrone(world, world.nodes[scenario.start], seed);
    this.ctl = new Control(world, this.drone, level, { heading: 0, defaultVia: scenario.start });
    const n = this.G.nx * this.G.nz;
    this.seen = new Uint8Array(n); // 1 = seen free (a ray crossed it)
    this.seenY = new Float32Array(n).fill(NaN); // height of the drone when first seen
    this.blocked = new Uint8Array(n); // 1 = a ray stopped here
    this.nSeen = 0;
    this.visits = new Map(); // cell(1 m) -> last time inside, for revisit counting
    this.revisits = 0;
    this.lastCell = -1;
    this.t = 0;
    this.step = 0;
    this.done = false;
    this.outcome = null;
    this.frames = [];
    this.look();
    this.record();
  }

  get heading() {
    return this.ctl.heading;
  }

  record() {
    const d = this.drone;
    this.frames.push([Math.round(this.t * 100) / 100, ...r2(d.pos), Math.round(this.ctl.heading * 1000) / 1000, this.found.filter((x) => x !== null).length]);
  }

  // Ray sweep + beacon check.
  look() {
    const W = this.world, G = this.G, p = this.drone.pos;
    for (let k = 0; k < N_RAYS; k++) {
      const a = (2 * Math.PI * k) / N_RAYS;
      const dx = Math.cos(a), dz = Math.sin(a);
      for (let s = 0; s <= SIGHT_M; s += 0.125) {
        const q = [p[0] + dx * s, p[1], p[2] + dz * s];
        const c = cellIndex(G, q);
        if (c < 0) break;
        if (occupied(W, q)) {
          this.blocked[c] = 1;
          break;
        }
        // The scanner is 0.5 m tall: obstacles just above or below the ray
        // mark the cell blocked (for planning) without stopping the view.
        if (occupied(W, [q[0], q[1] - 0.25, q[2]]) || occupied(W, [q[0], q[1] + 0.25, q[2]])) this.blocked[c] = 1;
        if (!this.seen[c]) {
          this.seen[c] = 1;
          this.seenY[c] = p[1];
          if (G.reachable[c]) this.nSeen++;
        }
      }
    }
    for (let i = 0; i < this.beacons.length; i++) {
      const b = this.beacons[i];
      const d = v.dist(p, b);
      const vis = d <= SIGHT_M && lineOfSight(W, p, b, SIGHT_M);
      this.visible[i] = vis;
      if (vis && this.found[i] === null) this.found[i] = Math.round(this.t * 100) / 100;
      if (this.found[i] === null && d < this.closest[i].d) this.closest[i] = { d: Math.round(d * 10) / 10, t: Math.round(this.t * 100) / 100, at: r1(p), occluded: d <= SIGHT_M && !vis };
    }
  }

  // ---------- perception ----------
  beaconList(egocentric) {
    const d = this.drone;
    const out = [];
    for (let i = 0; i < this.beacons.length; i++) {
      if (this.found[i] === null) continue;
      const b = this.beacons[i];
      const base = { beacon: i + 1, found_at_s: this.found[i], in_view_now: this.visible[i] };
      out.push(egocentric ? { ...base, bearing_deg: relBearingDeg(this.ctl.heading, d.pos, b), distance_m: Math.round(v.dist(d.pos, b) * 10) / 10 } : { ...base, position: r1(b) });
    }
    return out;
  }

  observe() {
    const d = this.drone;
    const base = { time_s: Math.round(this.t * 10) / 10, time_left_s: Math.round((TIME_LIMIT - this.t) * 10) / 10, wall_contacts_so_far: d.contacts.length, beacons_found: this.found.filter((x) => x !== null).length, beacons_total: this.beacons.length, sight_range_m: SIGHT_M };
    if (this.level === "C1") return { ...base, position: r1(d.pos), nearest_waypoint: this.world.nearestVisibleNode(d.pos, this.P.droneRadius), beacons: this.beaconList(false) };
    if (this.level === "C4") {
      const fwd = d.vel[0] * Math.cos(this.ctl.heading) + d.vel[2] * Math.sin(this.ctl.heading);
      return { ...base, speed_forward_mps: Math.round(fwd * 10) / 10, climb_rate_mps: Math.round(d.vel[1] * 10) / 10, beacons: this.beaconList(true), free_space_m: clearance(this.world, d.pos, this.P.droneRadius, SIGHT_M, 0.25, bodyDirs(this.ctl.heading)) };
    }
    // P1, world frame (C2, C3). P2 memory is the controller's job (see fog_agents.js).
    return { ...base, position: r1(d.pos), velocity: r1(d.vel), beacons: this.beaconList(false), free_space_m: clearance(this.world, d.pos, this.P.droneRadius, SIGHT_M) };
  }

  apply(raw = {}) {
    return this.ctl.apply(raw);
  }

  tick(dt) {
    if (this.done) return;
    const d = this.drone;
    this.ctl.tick();
    d.step(dt, this.t);
    this.t += dt;
    this.step++;
    // Revisits: re-entering a 1 m cell last occupied more than 10 s ago.
    const c1 = Math.floor(d.pos[0]) * 1000 + Math.floor(d.pos[2]);
    if (c1 !== this.lastCell) {
      const last = this.visits.get(c1);
      if (last !== undefined && this.t - last > 10) this.revisits++;
      this.lastCell = c1;
    }
    this.visits.set(c1, this.t);
    if (this.step % VISION_EVERY === 0) this.look();
    if (this.step % Math.round(30 / dt) === 0) this.coverage.push([Math.round(this.t), this.explored()]);
    const all = this.found.every((x) => x !== null);
    if (all && this.stopWhenFound) this.finish("found_all");
    else if (this.t >= TIME_LIMIT - 1e-9) this.finish(all ? "found_all" : "timeout");
    if (this.step % 6 === 0 || this.done) this.record();
  }

  finish(outcome) {
    this.done = true;
    this.outcome = outcome;
  }

  explored() {
    return Math.round((1000 * this.nSeen) / this.G.nReach) / 10;
  }

  result() {
    const d = this.drone;
    const nFound = this.found.filter((x) => x !== null).length;
    return {
      outcome: this.outcome,
      timeToFindAll: this.outcome === "found_all" ? Math.max(...this.found) : null,
      time: Math.round(this.t * 100) / 100,
      beaconsFound: nFound,
      foundAt: this.found.slice(),
      exploredPct: this.explored(),
      coverage: this.coverage.map((c) => c.slice()),
      contacts: d.contacts.length,
      revisits: this.revisits,
      pathLength: Math.round(d.pathLength * 10) / 10,
      endPos: r2(d.pos),
    };
  }
}

// ---------- verified feedback to the model (loop step 3) ----------
// The true map of what it explored (top-down, 2 m per character), beacons it
// came near without seeing (closest approach, and whether a wall hid one
// within sight range), and revisits. `believed` is optional: the model's own
// claims of explored areas as [x, z] points, each checked against the truth.
export function fogFeedback(env, { believed = null, charM = 2 } = {}) {
  const G = env.G;
  const step = Math.round(charM / CELL);
  const rows = [];
  for (let iz = G.nz - 1; iz >= 0; iz -= step) {
    let line = "";
    for (let ix = 0; ix < G.nx; ix += step) {
      let reach = 0, seen = 0;
      for (let a = 0; a < step; a++) for (let b = 0; b < step; b++) {
        const x = ix + a, z = iz - b;
        if (x >= G.nx || z < 0) continue;
        const i = x + G.nx * z;
        if (G.reachable[i]) reach++, (seen += env.seen[i]);
      }
      const cc = [G.min[0] + (ix + step / 2) * CELL, G.min[2] + (iz - step / 2 + 1) * CELL];
      const beacon = env.beacons.findIndex((b) => Math.abs(b[0] - cc[0]) <= charM / 2 && Math.abs(b[2] - cc[1]) <= charM / 2);
      if (beacon >= 0) line += env.found[beacon] !== null ? "B" : "b";
      else if (Math.abs(env.drone.pos[0] - cc[0]) <= charM / 2 && Math.abs(env.drone.pos[2] - cc[1]) <= charM / 2) line += "D";
      else line += !reach ? " " : seen * 2 >= reach ? "." : "?";
    }
    rows.push(line);
  }
  const missed = env.beacons.map((b, i) => ({ i, b })).filter(({ i }) => env.found[i] === null).map(({ i, b }) => {
    const c = env.closest[i];
    return { beacon: i + 1, position: r1(b), closest_approach_m: c.d, at_s: c.t, from: c.at, ...(c.occluded ? { note: "was within sight range but a wall blocked the view" } : {}) };
  });
  const out = {
    outcome: env.outcome,
    time_to_find_all_s: env.outcome === "found_all" ? Math.max(...env.found) : null,
    beacons_found_at_s: env.found,
    explored_pct: env.explored(),
    revisits: env.revisits,
    map_legend: "top-down, north up, 2 m per character: . explored, ? not explored, B found beacon, b missed beacon, D you, blank = not flyable",
    explored_map: rows.join("\n"),
    beacons_missed: missed,
  };
  if (believed) {
    out.claims_checked = believed.map(([x, z]) => {
      const i = cellIndex(G, [x, 0, z]);
      return { at: [x, z], actually_explored: i >= 0 && !!env.seen[i] };
    });
  }
  return out;
}
