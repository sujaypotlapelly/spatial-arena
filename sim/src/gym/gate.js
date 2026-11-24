// E1 Gate Run: fly through 8 gates in order, as
// fast as possible, without touching anything. Factory scan, free flight.
//
// Gates are virtual openings (no frame collision): a gate is passed when the
// drone's centre crosses its plane in the direction of travel inside the
// opening. Gates count strictly in order: crossing any gate other than the
// next one does nothing (so skipping a gate can never shorten a lap). The lap
// ends when the last gate is passed, or at the time limit; gates not passed
// by then are "missed".
//
// Scored: lap time (only for a completed lap), clean lap (completed with zero
// contacts), gates missed, wall contacts. The control level is pluggable (control.js):
// the environment never commits to one.

import { v } from "../world.js";
import { rng } from "../engine.js";
import { FreeDrone, clearance, lineOfSight, r1, r2 } from "./core.js";
import { Control, CONTROL_LEVELS, relBearingDeg, compassOf } from "./control.js";
import { bodyDirs } from "./reach.js";

export const LEVELS = CONTROL_LEVELS;
export const N_GATES = 8;
export const TIME_LIMIT = 120;
export const GATE_HALF_WIDTH = 1.0; // 2.0 m wide
export const GATE_HALF_HEIGHT = 0.6; // 1.2 m tall
export const GATE_APPROACH = 1.2; // entry/exit points this far before/after the plane (C1 autopilot, baselines)

const horiz = (a) => {
  const l = Math.hypot(a[0], a[2]);
  return l > 1e-9 ? [a[0] / l, 0, a[2] / l] : [1, 0, 0];
};
// Lateral axis of a gate: the travel direction rotated 90° (to the left, seen from above).
export const gateLateral = (n) => [-n[2], 0, n[0]];
export const gateEntry = (g) => v.sub(g.center, v.scale(g.normal, GATE_APPROACH));
export const gateExit = (g) => v.add(g.center, v.scale(g.normal, GATE_APPROACH));

// Is the gate opening free of geometry, with room to fly straight through?
function openingClear(world, c, n) {
  const u = gateLateral(n);
  for (let a = -GATE_HALF_WIDTH + 0.3; a <= GATE_HALF_WIDTH - 0.3 + 1e-9; a += 0.35)
    for (let b = -GATE_HALF_HEIGHT + 0.3; b <= GATE_HALF_HEIGHT - 0.3 + 1e-9; b += 0.3)
      if (world.sphereHits([c[0] + a * u[0], c[1] + b, c[2] + a * u[2]], 0.25)) return false;
  return world.segmentClear(v.sub(c, v.scale(n, GATE_APPROACH + 0.3)), v.add(c, v.scale(n, GATE_APPROACH + 0.3)), 0.3);
}

// Place a gate at node `id`, facing n; try a few heights in the flight band.
function placeGate(world, id, n) {
  const p = world.nodes[id];
  for (const dy of [0, 0.3, 0.6, -0.2, 0.9]) {
    const c = [p[0], Math.round((p[1] + dy) * 100) / 100, p[2]];
    if (c[1] < -0.1 || c[1] > 1.6) continue;
    if (openingClear(world, c, n)) return { node: id, center: r2(c), normal: n.map((x) => Math.round(x * 1000) / 1000) };
  }
  return null;
}

// ---------- scenario sets ----------
// A course is a walk over the waypoint graph: a start node then 8 gate nodes,
// each 6-16 m (straight line) from the previous, no node reused, no gate
// within 4 m of another. A gate faces the direction of travel along the graph
// path through its node (mean of the incoming and outgoing edge directions).
// Disjoint train / dev / held-out sets, deterministic.
export function makeGateSets(world, { train = 8, dev = 12, heldout = 12, seed = 20261115 } = {}) {
  const R = rng(seed);
  const ids = world.nodeIds;
  const N = world.nodes;
  const pathCache = new Map();
  const path = (a, b) => {
    const k = `${a}|${b}`;
    if (!pathCache.has(k)) pathCache.set(k, world.path(a, b));
    return pathCache.get(k);
  };
  const shuffled = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(R.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const tryCourse = (start) => {
    const nodes = [start];
    const gates = [];
    let inDir = null; // horizontal direction of travel arriving at the newest node
    for (let k = 0; k < N_GATES + 1; k++) {
      const cur = nodes[nodes.length - 1];
      const last = k === N_GATES; // cur is the final gate
      const nexts = last ? [null] : shuffled(ids).filter((b) => {
        if (nodes.includes(b)) return false;
        const d = v.dist(N[cur], N[b]);
        if (d < 6 || d > 16) return false;
        if (gates.some((g) => v.dist(g.center, N[b]) < 4) || v.dist(N[nodes[0]], N[b]) < 4) return false;
        return !!path(cur, b);
      });
      let placed = false;
      for (const nb of nexts.slice(0, 12)) {
        let outDir = null;
        if (nb) {
          const p = path(cur, nb);
          outDir = horiz(v.sub(N[p[1]], N[cur]));
        }
        if (k === 0) {
          // cur is the start node: no gate here.
          nodes.push(nb);
          const p = path(cur, nb);
          inDir = horiz(v.sub(N[nb], N[p[p.length - 2]]));
          placed = true;
          break;
        }
        const n = outDir ? horiz(v.add(inDir, outDir)) : inDir;
        if (outDir && v.dot(inDir, outDir) < -0.5) continue; // hairpin: skip
        const g = placeGate(world, cur, n);
        if (!g) continue;
        gates.push(g);
        if (nb) {
          nodes.push(nb);
          const p = path(cur, nb);
          inDir = horiz(v.sub(N[nb], N[p[p.length - 2]]));
        }
        placed = true;
        break;
      }
      if (!placed) return null;
    }
    // The approach to G1 must be flyable from the start.
    let graph = 0;
    for (let i = 0; i < nodes.length - 1; i++) graph += world.routeLength(path(nodes[i], nodes[i + 1]));
    return { start: start, gates, graph_m: Math.round(graph * 10) / 10 };
  };
  const courses = [];
  const usedLegs = new Set();
  const total = train + dev + heldout;
  for (let tries = 0; tries < 20000 && courses.length < total; tries++) {
    const s = ids[Math.floor(R.next() * ids.length)];
    const c = tryCourse(s);
    if (!c) continue;
    // Disjoint courses: no two share a directed gate-to-gate leg.
    const legs = c.gates.slice(1).map((g, i) => `${c.gates[i].node}>${g.node}`);
    if (legs.some((l) => usedLegs.has(l))) continue;
    for (const l of legs) usedLegs.add(l);
    courses.push(c);
  }
  if (courses.length < total) throw new Error(`only ${courses.length}/${total} gate courses could be placed`);
  const take = (from, n, prefix, seedBase) => courses.slice(from, from + n).map((c, i) => ({ id: `${prefix}${i + 1}`, ...c, seeds: [seedBase + i * 10 + 1, seedBase + i * 10 + 2] }));
  return { train: take(0, train, "GT", 910000), dev: take(train, dev, "GD", 920000), heldout: take(train + dev, heldout, "GH", 930000) };
}

// ---------- environment ----------
export class GateRun {
  constructor(world, scenario, seed, level) {
    this.world = world;
    this.P = world.physics;
    this.sc = scenario;
    this.level = level;
    this.gates = scenario.gates;
    this.drone = new FreeDrone(world, world.nodes[scenario.start], seed);
    const g0 = this.gates[0].center;
    const heading = Math.atan2(g0[2] - this.drone.pos[2], g0[0] - this.drone.pos[0]) || 0;
    this.ctl = new Control(world, this.drone, level, { heading, defaultVia: "gate", resolveVia: (via) => this.resolveVia(via) });
    this.t = 0;
    this.step = 0;
    this.next = 0; // index of the next gate
    this.splits = []; // { gate, t } per gate passed
    this.done = false;
    this.outcome = null;
    this.frames = [];
    this.record();
  }

  get heading() {
    return this.ctl.heading;
  }

  record() {
    const d = this.drone;
    this.frames.push([Math.round(this.t * 100) / 100, ...r2(d.pos), Math.round(this.ctl.heading * 1000) / 1000, this.next]);
  }

  // C1 extra target "gate": route over the graph to the node nearest the next
  // gate's approach side, then fly entry -> exit straight through it.
  resolveVia(via) {
    if (via !== "gate" || this.next >= this.gates.length) return null;
    const g = this.gates[this.next];
    const entry = gateEntry(g);
    let best = null;
    for (const id of this.world.nodeIds) {
      const p = this.world.nodes[id];
      if (v.dot(v.sub(p, g.center), g.normal) > -0.5) continue;
      const d = v.dist(p, entry);
      if (d > 12 || (best && d >= best.d)) continue;
      if (this.world.segmentClear(p, entry, this.P.droneRadius)) best = { id, d };
    }
    return { node: best ? best.id : null, tail: [r2(entry), r2(gateExit(g))] };
  }

  // ---------- perception ----------
  gateView(i, egocentric) {
    const g = this.gates[i];
    if (!g) return null;
    const d = this.drone;
    const dist = Math.round(v.dist(d.pos, g.center) * 10) / 10;
    const los = lineOfSight(this.world, d.pos, g.center, 40);
    if (egocentric) {
      const facing = Math.round(((((Math.atan2(g.normal[2], g.normal[0]) - this.ctl.heading) * 180) / Math.PI + 540) % 360) - 180);
      return { gate: i + 1, bearing_deg: relBearingDeg(this.ctl.heading, d.pos, g.center), distance_m: dist, height_difference_m: Math.round((g.center[1] - d.pos[1]) * 10) / 10, pass_direction_deg: facing, in_line_of_sight: los };
    }
    return { gate: i + 1, center: r1(g.center), pass_direction: compassOf(g.normal[0], g.normal[2]), pass_vector: g.normal, distance_m: dist, in_line_of_sight: los };
  }

  observe() {
    const d = this.drone;
    const base = {
      time_s: Math.round(this.t * 10) / 10,
      time_left_s: Math.round((TIME_LIMIT - this.t) * 10) / 10,
      wall_contacts_so_far: d.contacts.length,
      gates_passed: this.next,
      gates_total: this.gates.length,
      gate_size_m: { width: 2 * GATE_HALF_WIDTH, height: 2 * GATE_HALF_HEIGHT },
    };
    if (this.level === "C1") {
      // P0: the map (waypoint graph in the prompt), with coordinates.
      return { ...base, position: r1(d.pos), nearest_waypoint: this.world.nearestVisibleNode(d.pos, this.P.droneRadius), next_gate: this.gateView(this.next, false), gate_after: this.gateView(this.next + 1, false) };
    }
    if (this.level === "C4") {
      const fwd = d.vel[0] * Math.cos(this.ctl.heading) + d.vel[2] * Math.sin(this.ctl.heading);
      return {
        ...base,
        speed_forward_mps: Math.round(fwd * 10) / 10,
        climb_rate_mps: Math.round(d.vel[1] * 10) / 10,
        next_gate: this.gateView(this.next, true),
        gate_after: this.gateView(this.next + 1, true),
        free_space_m: clearance(this.world, d.pos, this.P.droneRadius, 12, 0.25, bodyDirs(this.ctl.heading)),
      };
    }
    // P1, world frame (C2, C3).
    return { ...base, position: r1(d.pos), velocity: r1(d.vel), next_gate: this.gateView(this.next, false), gate_after: this.gateView(this.next + 1, false), free_space_m: clearance(this.world, d.pos, this.P.droneRadius) };
  }

  // ---------- action ----------
  apply(raw = {}) {
    return this.ctl.apply(raw);
  }

  // Did the segment p0 -> p1 cross gate i forwards inside its opening?
  crossing(i, p0, p1) {
    const g = this.gates[i];
    if (!g) return null;
    const s0 = v.dot(v.sub(p0, g.center), g.normal);
    const s1 = v.dot(v.sub(p1, g.center), g.normal);
    if (!(s0 < 0 && s1 >= 0)) return null;
    const f = s0 / (s0 - s1);
    const x = v.lerp(p0, p1, f);
    const off = v.sub(x, g.center);
    if (Math.abs(v.dot(off, gateLateral(g.normal))) > GATE_HALF_WIDTH || Math.abs(off[1]) > GATE_HALF_HEIGHT) return null;
    return f;
  }

  tick(dt) {
    if (this.done) return;
    const d = this.drone;
    this.ctl.tick();
    const p0 = d.pos.slice();
    d.step(dt, this.t);
    const t0 = this.t;
    this.t += dt;
    this.step++;
    const f = this.crossing(this.next, p0, d.pos);
    if (f !== null) {
      this.splits.push({ gate: this.next + 1, t: Math.round((t0 + f * dt) * 100) / 100 });
      this.next++;
      if (this.next >= this.gates.length) this.finish("finished");
    }
    if (!this.done && this.t >= TIME_LIMIT) this.finish("timeout");
    if (this.step % 6 === 0 || this.done) this.record();
  }

  finish(outcome) {
    this.done = true;
    this.outcome = outcome;
  }

  result() {
    const d = this.drone;
    const passed = this.next;
    const missed = this.gates.length - passed;
    const finished = this.outcome === "finished";
    return {
      outcome: this.outcome,
      lapTime: finished ? this.splits[this.splits.length - 1].t : null,
      time: Math.round(this.t * 100) / 100,
      gatesPassed: passed,
      gatesMissed: missed,
      clean: finished && missed === 0 && d.contacts.length === 0,
      contacts: d.contacts.length,
      pathLength: Math.round(d.pathLength * 10) / 10,
      splits: this.splits.map((s) => ({ ...s })),
      contactLog: d.contacts.map((c) => ({ ...c })),
      endPos: r2(d.pos),
    };
  }
}

// ---------- verified feedback to the model (loop step 3) ----------
// Split times per gate; where it touched geometry (position + nearest wall
// direction); gates missed; and a reference lap time from a verified
// planner run ("the course can be done in 19.4 s").
export function gateFeedback(world, episode, { referenceLapTime = null } = {}) {
  const res = episode.result;
  const splits = [];
  let prev = 0;
  for (const s of res.splits) {
    splits.push({ gate: s.gate, at_s: s.t, split_s: Math.round((s.t - prev) * 100) / 100 });
    prev = s.t;
  }
  for (let g = res.splits.length + 1; g <= res.gatesPassed + res.gatesMissed; g++) splits.push({ gate: g, missed: true });
  const contacts = (res.contactLog || []).map((c) => {
    const cl = clearance(world, c.at, world.physics.droneRadius, 3, 0.1);
    const [dir] = Object.entries(cl).filter(([k]) => k !== "up" && k !== "down").reduce((b, e) => (e[1] < b[1] ? e : b));
    return { t: c.t, at: c.at, nearest_wall: dir.replace("_", "-") };
  });
  return {
    outcome: res.outcome,
    lap_time_s: res.lapTime,
    clean_lap: res.clean,
    gates_missed: res.gatesMissed,
    splits,
    wall_contacts: contacts,
    ...(referenceLapTime ? { reference: `The course can be done in ${referenceLapTime.toFixed(1)} s.` } : {}),
  };
}
