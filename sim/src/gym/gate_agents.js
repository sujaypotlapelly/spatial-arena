// Controllers for E1 Gate Run. Baselines:
//   astarGate     C2, map + planner: A* over the 0.25 m voxel grid through every
//                 gate, string-pulled, flown by carrot-following. The
//                 near-optimal bound (it knows the whole map; P0).
//   waypointGate  C1, map + planner: A* over the waypoint graph to the next
//                 gate's approach node, then straight through (P0).
//   straightGate  C2, senses only: aim at the next gate, no avoidance (floor).
//   reactiveGate  C3, senses only: the Reach reactive avoider, steering at the gate.
// Plus the Ripple controller, pluggable by control level C1-C4.

import { v } from "../world.js";
import { rippleController, r1 } from "./core.js";
import { gateEntry, gateExit, gateLateral, GATE_HALF_WIDTH, GATE_HALF_HEIGHT, TIME_LIMIT } from "./gate.js";

// ---------- voxel A* ----------
// Plans on the scan's collision grid cells (0.25 m) inside the flight band,
// with the drone inflated to `radius` for margin against gusts.
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, vv = this.v;
    let i = k.length;
    k.push(key); vv.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; vv[i] = vv[p]; i = p;
    }
    k[i] = key; vv[i] = val;
  }
  pop() {
    const k = this.k, vv = this.v;
    const top = vv[0];
    const lk = k.pop(), lv = vv.pop();
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; vv[i] = vv[c]; i = c;
      }
      k[i] = lk; vv[i] = lv;
    }
    return top;
  }
}

const planners = new WeakMap();
export function voxelPlanner(world, opts) {
  if (!planners.has(world)) planners.set(world, new VoxelPlanner(world, opts));
  return planners.get(world);
}

export class VoxelPlanner {
  constructor(world, { radius = 0.5, yLo = -0.4, yHi = 2.0 } = {}) {
    if (!world.grid) throw new Error("voxel planner needs a voxel map");
    this.W = world;
    const { origin, cell, dims } = world.grid;
    this.o = origin; this.c = cell; this.d = dims;
    this.r = radius;
    this.y0 = Math.max(0, Math.floor((yLo - origin[1]) / cell));
    this.y1 = Math.min(dims[1] - 1, Math.floor((yHi - origin[1]) / cell));
    this.free = new Int8Array(dims[0] * dims[1] * dims[2]); // 0 unknown, 1 free, 2 blocked
    this.g = new Float64Array(this.free.length);
    this.prev = new Int32Array(this.free.length);
    this.stamp = new Int32Array(this.free.length);
    this.run = 0;
    this.nbrs = [];
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) this.nbrs.push([dx, dy, dz, Math.hypot(dx, dy, dz) * cell]);
  }
  idx(x, y, z) { return x + this.d[0] * (y + this.d[1] * z); }
  center(i) {
    const nx = this.d[0], ny = this.d[1];
    const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
    return [this.o[0] + (x + 0.5) * this.c, this.o[1] + (y + 0.5) * this.c, this.o[2] + (z + 0.5) * this.c];
  }
  isFree(x, y, z) {
    if (x < 0 || z < 0 || x >= this.d[0] || z >= this.d[2] || y < this.y0 || y > this.y1) return false;
    const i = this.idx(x, y, z);
    if (!this.free[i]) this.free[i] = this.W.sphereHits(this.center(i), this.r) ? 2 : 1;
    if (this.free[i] !== 1) return false;
    return !(this.avoid && this.avoid(this.center(i)));
  }
  cellOf(p) { return [0, 1, 2].map((k) => Math.floor((p[k] - this.o[k]) / this.c)); }
  // Nearest free cell to p (search a growing cube).
  snap(p) {
    const [cx, cy, cz] = this.cellOf(p);
    for (let R = 0; R <= 6; R++) {
      let best = null;
      for (let dz = -R; dz <= R; dz++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== R) continue;
        if (!this.isFree(cx + dx, cy + dy, cz + dz)) continue;
        const i = this.idx(cx + dx, cy + dy, cz + dz);
        const d = v.dist(this.center(i), p);
        if (!best || d < best.d) best = { i, d };
      }
      if (best) return best.i;
    }
    return null;
  }
  // A* from point a to point b; returns the cell-centre polyline (a and b at the ends) or null.
  // avoid(p) -> true marks extra no-go space for this plan only.
  plan(a, b, { avoid = null, maxExpand = 400000 } = {}) {
    this.avoid = avoid;
    try {
      return this.planInner(a, b, maxExpand);
    } finally {
      this.avoid = null;
    }
  }
  planInner(a, b, maxExpand) {
    const s = this.snap(a), t = this.snap(b);
    if (s === null || t === null) return null;
    const run = ++this.run;
    const goal = this.center(t);
    const h = (i) => v.dist(this.center(i), goal);
    const heap = new Heap();
    this.stamp[s] = run; this.g[s] = 0; this.prev[s] = -1;
    heap.push(h(s), s);
    const nx = this.d[0], ny = this.d[1];
    let n = 0;
    while (heap.size) {
      const i = heap.pop();
      if (i === t) break;
      if (++n > maxExpand) return null;
      const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      const gi = this.g[i];
      for (const [dx, dy, dz, w] of this.nbrs) {
        if (!this.isFree(x + dx, y + dy, z + dz)) continue;
        // No corner cutting on diagonal moves.
        if ((dx && dz && (!this.isFree(x + dx, y, z) || !this.isFree(x, y, z + dz))) || (dy && (dx || dz) && !this.isFree(x, y + dy, z))) continue;
        const j = this.idx(x + dx, y + dy, z + dz);
        const gj = gi + w;
        if (this.stamp[j] === run && gj >= this.g[j]) continue;
        this.stamp[j] = run; this.g[j] = gj; this.prev[j] = i;
        heap.push(gj + h(j), j);
      }
    }
    if (this.stamp[t] !== run) return null;
    const out = [];
    for (let i = t; i !== -1; i = this.prev[i]) out.unshift(this.center(i));
    return [a.slice(), ...out, b.slice()];
  }
  // Greedy string pulling with a swept-sphere check.
  smooth(pts, r = 0.45, avoid = null) {
    const ok = (a, b) => {
      if (!this.W.segmentClear(a, b, r)) return false;
      if (!avoid) return true;
      const n = Math.max(1, Math.ceil(v.dist(a, b) / 0.15));
      for (let k = 0; k <= n; k++) if (avoid(v.lerp(a, b, k / n))) return false;
      return true;
    };
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = i + 1;
      while (j + 1 < pts.length && ok(pts[i], pts[j + 1])) j++;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }
}

// The planner's racing line through the course: start -> entry1 -> centre1 -> exit1 -> entry2 ...
const courseCache = new Map();
export function plannedCourse(world, sc) {
  const key = `${sc.id}|${JSON.stringify(sc.gates.map((g) => g.center))}`;
  if (courseCache.has(key)) return courseCache.get(key);
  const P = voxelPlanner(world);
  let line = [world.nodes[sc.start].slice()];
  const anchors = []; // index in `line` of each gate centre
  let from = line[0];
  for (const g of sc.gates) {
    const entry = gateEntry(g);
    // The approach must not go through the gate's own opening backwards:
    // its plane slab (plus a margin) is no-go space for this leg.
    const u = gateLateral(g.normal);
    const avoid = (p) => {
      const o = v.sub(p, g.center);
      return Math.abs(v.dot(o, g.normal)) < 0.6 && Math.abs(v.dot(o, u)) < GATE_HALF_WIDTH + 0.8 && Math.abs(o[1]) < GATE_HALF_HEIGHT + 0.8;
    };
    const leg = P.plan(from, entry, { avoid }) || P.plan(from, entry) || [from, entry];
    line.push(...P.smooth(leg, 0.45, avoid).slice(1));
    anchors.push(line.length);
    line.push(g.center.slice(), gateExit(g));
    from = gateExit(g);
  }
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + v.dist(line[i - 1], line[i]));
  const out = { line, cum, anchors, length: cum[cum.length - 1] };
  courseCache.set(key, out);
  return out;
}

function pointAt(course, s) {
  const { line, cum } = course;
  if (s <= 0) return line[0];
  for (let i = 1; i < line.length; i++) if (cum[i] >= s) return v.lerp(line[i - 1], line[i], (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1));
  return line[line.length - 1];
}

// Does the straight segment p -> q stay a clean pass through gate g if it crosses its plane?
// mustCross: q lies beyond the gate along the line, so p -> q has to go through it.
function passesClean(p, q, g, mustCross, margin = 0.3) {
  const s0 = v.dot(v.sub(p, g.center), g.normal), s1 = v.dot(v.sub(q, g.center), g.normal);
  if (!(s0 < 0 && s1 >= 0)) return !mustCross && s1 < 0; // not crossing: fine only if q is still before the plane
  const x = v.lerp(p, q, s0 / (s0 - s1));
  const off = v.sub(x, g.center);
  return Math.abs(v.dot(off, gateLateral(g.normal))) <= GATE_HALF_WIDTH - margin && Math.abs(off[1]) <= GATE_HALF_HEIGHT - margin;
}

export const astarGate = (world, sc, { lookahead = 10, margin = 0.45 } = {}) => {
  const course = plannedCourse(world, sc);
  let s = 0; // progress along the line
  let entryReached = -1; // index of the last gate whose entry point the drone has reached
  return async (obs, env) => {
    const p = env.drone.pos;
    const g = env.gates[env.next];
    const gs = g ? course.cum[course.anchors[env.next]] : course.length; // arc length of the next gate's centre
    const gEntry = g ? course.cum[course.anchors[env.next] - 1] : course.length;
    const gExit = g ? course.cum[course.anchors[env.next] + 1] : course.length;
    if (g && v.dist(p, gateEntry(g)) < 1.0) entryReached = env.next;
    // Reached the exit without the gate counting (pushed outside the opening,
    // or came round the back): go back to the entry and try again.
    if (g && s >= gExit - 0.3) {
      s = Math.max(0, gEntry - 2);
      entryReached = -1;
    }
    // Project onto the line within a window ahead of the current progress,
    // never past the next gate's entry until the drone has been there, nor
    // past its exit (other legs may pass close by).
    const cap = entryReached === env.next ? gExit : gEntry;
    let best = { d: Infinity, s };
    for (let q = s; q <= Math.min(cap, s + 12); q += 0.25) {
      const d = v.dist(pointAt(course, q), p);
      if (d < best.d) best = { d, s: q };
    }
    s = best.s;
    let target = pointAt(course, s + 1);
    for (let L = lookahead; L >= 1; L -= 0.5) {
      const sq = Math.min(course.length, s + L);
      const q = pointAt(course, sq);
      if (!world.segmentClear(p, q, margin)) continue;
      if (g && sq > gs - 0.5 && !passesClean(p, q, g, sq > gExit)) continue;
      target = q;
      break;
    }
    // Slow for the turn after the target.
    const dirA = v.norm(v.sub(target, p));
    const after = v.norm(v.sub(pointAt(course, s + lookahead + 4), target));
    const turn = Math.acos(Math.max(-1, Math.min(1, v.dot(dirA, after)))) * (180 / Math.PI);
    const speed = turn < 25 ? 5.5 : Math.max(2.5, 5.5 - ((turn - 25) / 65) * 3);
    return { command: { target: r1(target), speed: Math.round(speed * 10) / 10 }, say: `racing line to gate ${env.next + 1}` };
  };
};

export const waypointGate = () => async () => ({ command: { waypoint: "gate", speed: 4.5 }, say: "graph A* to the next gate" });

// Aim point for senses-only agents: the gate's entry point until lined up, then its exit.
function aimFromObs(obs) {
  const g = obs.next_gate;
  if (!g) return obs.position;
  const n = g.pass_vector, c = g.center;
  const entry = v.sub(c, v.scale(n, 1.2)), exit = v.add(c, v.scale(n, 1.2));
  const off = v.sub(obs.position, c);
  const along = v.dot(off, n);
  const lined = Math.abs(v.dot(off, [-n[2], 0, n[0]])) <= 0.6 && Math.abs(off[1]) <= 0.45;
  // Exit only when lined up on the approach side; otherwise (including after
  // overshooting around the gate) go back to the entry point.
  return along < 0 && along > -2.5 && lined ? exit : entry;
}

export const straightGate = () => async (obs) => ({ command: { target: r1(aimFromObs(obs)), speed: 4 }, say: "straight at the gate" });

export const reactiveGate = () => {
  const C = { east: [1, 0], north_east: [Math.SQRT1_2, Math.SQRT1_2], north: [0, 1], north_west: [-Math.SQRT1_2, Math.SQRT1_2], west: [-1, 0], south_west: [-Math.SQRT1_2, -Math.SQRT1_2], south: [0, -1], south_east: [Math.SQRT1_2, -Math.SQRT1_2] };
  let prev = null;
  return async (obs) => {
    const aim = aimFromObs(obs);
    const to = v.sub(aim, obs.position);
    const flat = Math.hypot(to[0], to[2]) || 1;
    const gdir = [to[0] / flat, to[2] / flat];
    let best = null;
    for (const [name, d] of Object.entries(C)) {
      const free = obs.free_space_m[name];
      if (free < 1.0) continue;
      const score = d[0] * gdir[0] + d[1] * gdir[1] + (0.6 * Math.min(free, 4)) / 4 + (name === prev ? 0.15 : 0);
      if (!best || score > best.score) best = { name, d, score, free };
    }
    if (!best) return { command: { velocity: [0, 1, 0] }, say: "boxed in: climb" };
    prev = best.name;
    const speed = Math.max(0.5, Math.min(3, best.free - 0.5, flat));
    const vy = Math.max(-1, Math.min(1, to[1]));
    return { command: { velocity: [best.d[0] * speed, vy, best.d[1] * speed] }, say: `go ${best.name}` };
  };
};

// ---------- Ripple (pluggable control level; no API calls are made here) ----------
const WORLD_FRAME = "Coordinates are [x, y, z] in metres: +x is east, +z is north, +y is up.";
const COMMAND = {
  C1: ['"waypoint": a waypoint id to route through, or "gate" to fly to the next gate and through it', '"speed": cruise speed in m/s, 0.3 to 5.5'],
  C2: ['"target": [x, y, z] the point to fly to in a straight line', '"speed": m/s, 0.3 to 5.5'],
  C3: ['"velocity": [vx, vy, vz] in m/s (vector length at most 5.5)'],
  C4: ['"turn_deg": -180 to 180 (positive = left)', '"forward_mps": -2 to 5.5', '"climb_mps": -2 to 2'],
};
function mapBrief(world) {
  return world.nodeIds.map((id) => `${id} ${JSON.stringify(r1(world.nodes[id]))} -> ${world.adj[id].join(", ")}`).join("\n");
}
export function gateMessages(world, scenario, level, obs, history, opts = {}) {
  const P = world.physics;
  const sense =
    level === "C1" ? "You know the building's waypoint graph (below). An autopilot plans the shortest path along the graph to the waypoint you choose and flies it."
      : level === "C4" ? "You have no map. You sense, relative to your own heading: the next two gates' bearing, distance, height difference and the direction you must pass through them, and free space (metres, up to 12) in 8 directions around you plus up and down. You do not know your coordinates."
        : "You have no map. You sense your position and velocity, the next two gates (centre, pass direction, whether in line of sight), and free space (metres, up to 12) in 8 compass directions plus up and down.";
  const act =
    level === "C1" ? "Your command picks the next waypoint (or \"gate\") and a cruise speed."
      : level === "C2" ? "Your command is a target point: the drone flies straight toward it at your speed and stops there. Nothing plans a path for you."
        : level === "C3" ? "Your command is a velocity the drone holds for the next second. Nothing plans a path for you."
          : "Your command turns the drone (degrees, positive = left), then sets its forward speed and climb rate for the next second. Nothing plans a path for you.";
  const keys = [...COMMAND[level], ...(level === "C4" ? ['"predict_gate_distance_in_1s": metres to the next gate one second from now'] : ['"predict_position_in_1s": [x, y, z] where you expect to be one second from now']), '"say": at most 12 words: what you are doing and why'];
  const recent = history.slice(-3).map((h) => ({ t: h.t, command: h.command, said: h.say }));
  return [
    { role: "system", content: "You are racing a small drone through gates inside a building. Every second you receive what the drone senses and you give the next command. Reply with one JSON object and nothing else." },
    {
      role: "user",
      content: `The building is a 3D scan of a real factory. ${level === "C4" ? "" : WORLD_FRAME}
Fly through ${scenario.gates.length} gates in order, as fast as possible, without touching anything. A gate is a ${2 * GATE_HALF_WIDTH} m wide x ${2 * GATE_HALF_HEIGHT} m tall opening; it counts only if you pass through it in its pass direction, and only in order (crossing any other gate does nothing).
${sense}
${act}
The drone is a sphere of radius ${P.droneRadius} m with top speed ${P.droneMaxSpeed} m/s; random wind gusts push it. Touching anything counts as a wall contact. You have ${TIME_LIMIT} s.
${level === "C1" ? `\nWaypoint graph (id [x,y,z] -> neighbours):\n${mapBrief(world)}\n` : ""}${opts.notes ? `\nYour notes from earlier laps:\n${opts.notes}\n` : ""}
Your last commands: ${JSON.stringify(recent)}

What the drone senses now:
${JSON.stringify(obs)}

Return JSON with these keys:
${keys.map((k) => "  " + k).join("\n")}`,
    },
  ];
}

export function rippleGate(world, scenario, level, chat, opts = {}) {
  const read = (p) => ({
    command: level === "C1" ? { waypoint: p.waypoint, speed: p.speed } : level === "C2" ? { target: p.target, speed: p.speed } : level === "C3" ? { velocity: p.velocity } : { turn_deg: p.turn_deg, forward_mps: p.forward_mps, climb_mps: p.climb_mps },
    prediction: {
      position: Array.isArray(p.predict_position_in_1s) && p.predict_position_in_1s.length === 3 ? p.predict_position_in_1s.map(Number) : null,
      gateDistance: Number.isFinite(Number(p.predict_gate_distance_in_1s)) ? Number(p.predict_gate_distance_in_1s) : null,
    },
    say: String(p.say ?? "").slice(0, 160),
  });
  const fallback = level === "C3" ? { velocity: [0, 0, 0] } : level === "C4" ? { turn_deg: 0, forward_mps: 0, climb_mps: 0 } : level === "C2" ? { target: null } : { waypoint: "gate", speed: 3 };
  return rippleController(chat, (obs, history, o) => gateMessages(world, scenario, level, obs, history, opts), read, { fallback, meta: { env: "gate", level, scenario: scenario.id } });
}
