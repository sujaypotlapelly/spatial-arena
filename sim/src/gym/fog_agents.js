// Controllers for E3 Fog Search. Baselines:
//   frontierFog    C2, classic frontier exploration (Yamauchi 1997) on the map
//                  the drone's own sensor sweep has built (seen-free and
//                  seen-blocked cells only; never the true floor plan): go to
//                  the nearest reachable boundary between known-free and
//                  unknown space, by Dijkstra over known-free cells.
//   randomWalkFog  C3, senses only: pick a random open compass direction,
//                  hold it for 2-5 s or until blocked.
// Plus the Ripple controller, pluggable by control level C1-C4, with an
// optional P2 memory the model writes itself.

import { v } from "../world.js";
import { rng } from "../engine.js";
import { rippleController, r1 } from "./core.js";
import { CELL, SIGHT_M, TIME_LIMIT, cellIndex, cellCenter } from "./fog.js";

// ---------- frontier exploration ----------
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, x) {
    const a = this.a;
    a.push([k, x]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export const frontierFog = (world, sc, { speed = 4, lookahead = 6, minDist = 1.5, cruiseY = 0.9 } = {}) => {
  let goal = -1; // committed frontier cell
  let goalSince = 0;
  const learned = new Set(); // cells the drone bumped into (its own memory)
  let lastPos = null, stuck = 0;
  const dead = new Set(); // frontiers given up on (reached but still unknown next to them, or timed out)
  const N8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  return async (obs, env) => {
    const G = env.G, nx = G.nx, nz = G.nz, seen = env.seen, blocked = env.blocked;
    const p = env.drone.pos;
    const isFrontier = (i) => {
      if (!seen[i] || dead.has(i)) return false;
      const x = i % nx, z = (i / nx) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ex = x + dx, ez = z + dz;
        if (ex < 0 || ez < 0 || ex >= nx || ez >= nz) continue;
        const j = ex + nx * ez;
        if (!seen[j] && !blocked[j]) return true;
      }
      return false;
    };
    const nearBlocked = (i) => {
      const x = i % nx, z = (i / nx) | 0;
      for (const [dx, dz] of N8) {
        const ex = x + dx, ez = z + dz;
        if (ex >= 0 && ez >= 0 && ex < nx && ez < nz && blocked[ex + nx * ez]) return true;
      }
      return false;
    };
    const passable = (i) => seen[i] && !blocked[i] && !learned.has(i);
    // Dijkstra over known-free cells from the drone's cell.
    let start = cellIndex(G, p);
    const dist = new Float64Array(nx * nz).fill(Infinity);
    const prev = new Int32Array(nx * nz).fill(-1);
    const heap = new MinHeap();
    dist[start] = 0;
    heap.push(0, start);
    while (heap.size) {
      const [d, i] = heap.pop();
      if (d > dist[i]) continue;
      const x = i % nx, z = (i / nx) | 0;
      for (const [dx, dz, w] of N8) {
        const ex = x + dx, ez = z + dz;
        if (ex < 0 || ez < 0 || ex >= nx || ez >= nz) continue;
        const j = ex + nx * ez;
        if (!passable(j)) continue;
        if (dx && dz && (!passable(x + dx + nx * z) || !passable(x + nx * (z + dz)))) continue;
        const nd = d + w * CELL * (nearBlocked(j) ? 3 : 1);
        if (nd < dist[j]) {
          dist[j] = nd;
          prev[j] = i;
          heap.push(nd, j);
        }
      }
    }
    // Keep the committed frontier while it is still one, reachable, and not stale.
    const here = (i) => v.dist([p[0], 0, p[2]], [cellCenter(G, i, 0)[0], 0, cellCenter(G, i, 0)[2]]);
    if (goal >= 0 && (here(goal) < 1.0 || env.t - goalSince > 20)) {
      if (isFrontier(goal)) dead.add(goal);
      goal = -1;
    }
    if (goal >= 0 && (!isFrontier(goal) || dist[goal] === Infinity)) goal = -1;
    if (goal < 0) {
      let best = -1;
      for (let i = 0; i < nx * nz; i++) {
        if (dist[i] === Infinity || dist[i] < minDist || !isFrontier(i)) continue;
        if (best < 0 || dist[i] < dist[best]) best = i;
      }
      goal = best;
      goalSince = env.t;
    }
    if (goal < 0) {
      // Out of frontiers: forget the give-ups and bumps once, and look again next time.
      if (dead.size || learned.size) {
        dead.clear();
        learned.clear();
      }
      return { command: { target: r1(p), speed: 1 }, say: "no frontier left: hold" };
    }
    // Carrot: the furthest cell along the path within the look-ahead that is
    // in direct, clear view (a local sensor check).
    const path = [];
    for (let i = goal; i !== -1; i = prev[i]) path.unshift(i);
    const yOf = (i) => Math.max(0, Math.min(1.5, Number.isNaN(env.seenY[i]) ? p[1] : env.seenY[i]));
    // Not moving: remember the cell ahead on the path as an obstacle.
    if (lastPos && v.dist(lastPos, p) < 0.3) stuck++;
    else stuck = 0;
    lastPos = p.slice();
    if (stuck >= 2 && path.length > 1) {
      learned.add(path[1]);
      stuck = 0;
    }
    let target = null;
    // Cruise at cruiseY (sees over low clutter); fall back to the height the cell was seen from.
    for (let k = path.length - 1; k >= 1 && !target; k--) {
      for (const y of [cruiseY, yOf(path[k])]) {
        const q = cellCenter(G, path[k], y);
        if (v.dist(q, p) > lookahead) break;
        if (world.segmentClear(p, q, 0.27)) {
          target = q;
          break;
        }
      }
    }
    if (!target) {
      // Nothing on the path is in clear view: back off toward the most open
      // direction (its own lidar) and remember the blocked cell.
      if (path.length > 1) learned.add(path[1]);
      const fs = obs.free_space_m;
      const dirs = { east: [1, 0], north_east: [0.7071, 0.7071], north: [0, 1], north_west: [-0.7071, 0.7071], west: [-1, 0], south_west: [-0.7071, -0.7071], south: [0, -1], south_east: [0.7071, -0.7071] };
      const best = Object.keys(dirs).reduce((a, b) => (fs[b] > fs[a] ? b : a));
      const step = Math.min(1.0, Math.max(0.3, fs[best] - 0.3));
      return { command: { target: r1([p[0] + dirs[best][0] * step, p[1], p[2] + dirs[best][1] * step]), speed: 2 }, say: `blocked: back off ${best}` };
    }
    return { command: { target: r1(target), speed }, say: `frontier ${dist[goal].toFixed(1)} m away` };
  };
};

// ---------- random walk (senses only) ----------
const COMPASS = { east: [1, 0], north_east: [Math.SQRT1_2, Math.SQRT1_2], north: [0, 1], north_west: [-Math.SQRT1_2, Math.SQRT1_2], west: [-1, 0], south_west: [-Math.SQRT1_2, -Math.SQRT1_2], south: [0, -1], south_east: [Math.SQRT1_2, -Math.SQRT1_2] };
export const randomWalkFog = (world, sc, { seed = 1 } = {}) => {
  const R = rng(seed ^ 0x5eed);
  let dir = null, left = 0;
  return async (obs) => {
    const free = obs.free_space_m;
    if (!dir || left <= 0 || free[dir] < 1.2) {
      const open = Object.keys(COMPASS).filter((k) => free[k] >= 2.5);
      const pool = open.length ? open : [Object.keys(COMPASS).reduce((a, b) => (free[b] > free[a] ? b : a))];
      dir = pool[Math.floor(R.next() * pool.length)];
      left = 2 + Math.floor(R.next() * 4);
    }
    left--;
    const s = Math.max(0.5, Math.min(3, free[dir] - 0.8));
    const vy = Math.max(-1, Math.min(1, 0.75 - obs.position[1]));
    return { command: { velocity: [COMPASS[dir][0] * s, vy, COMPASS[dir][1] * s] }, say: `wander ${dir}` };
  };
};

// ---------- Ripple (pluggable control level; no API calls are made here) ----------
const WORLD_FRAME = "Coordinates are [x, y, z] in metres: +x is east, +z is north, +y is up.";
const COMMAND = {
  C1: ['"waypoint": the waypoint id to fly to next', '"speed": cruise speed in m/s, 0.3 to 5.5'],
  C2: ['"target": [x, y, z] the point to fly to in a straight line', '"speed": m/s, 0.3 to 5.5'],
  C3: ['"velocity": [vx, vy, vz] in m/s (vector length at most 5.5)'],
  C4: ['"turn_deg": -180 to 180 (positive = left)', '"forward_mps": -2 to 5.5', '"climb_mps": -2 to 2'],
};
function mapBrief(world) {
  return world.nodeIds.map((id) => `${id} ${JSON.stringify(r1(world.nodes[id]))} -> ${world.adj[id].join(", ")}`).join("\n");
}

// opts.perception: "P1" (default: senses only) or "P2" (the model also keeps
// a memory string it rewrites every decision; it is shown back next time).
export function fogMessages(world, scenario, level, obs, history, opts = {}) {
  const P = world.physics;
  const p2 = opts.perception === "P2";
  const sense =
    level === "C1" ? "You know the building's waypoint graph (below), but not where the beacons are. An autopilot plans the shortest path along the graph to the waypoint you choose."
      : level === "C4" ? `You have no map. You sense, relative to your own heading: free space (metres, up to ${SIGHT_M}) in 8 directions around you plus up and down, and the bearing and distance of beacons you have found. You do not know your coordinates.`
        : `You have no map. You sense your position and velocity, free space (metres, up to ${SIGHT_M}) in 8 compass directions plus up and down, and the positions of beacons you have found.`;
  const act =
    level === "C1" ? "Your command picks the next waypoint and a cruise speed."
      : level === "C2" ? "Your command is a target point: the drone flies straight toward it at your speed and stops there. Nothing plans a path for you."
        : level === "C3" ? "Your command is a velocity the drone holds for the next second. Nothing plans a path for you."
          : "Your command turns the drone (degrees, positive = left), then sets its forward speed and climb rate for the next second. Nothing plans a path for you.";
  const keys = [...COMMAND[level], ...(p2 ? ['"memory": your notes and sketch map of where you have been and what you have seen (at most 600 characters; this replaces your previous memory)'] : []), '"say": at most 12 words: what you are doing and why'];
  const recent = history.slice(-3).map((h) => ({ t: h.t, command: h.command, said: h.say }));
  const memory = p2 ? opts.memory || "(empty)" : null;
  return [
    { role: "system", content: "You are flying a small drone through an unknown building to find beacons. Every second you receive what the drone senses and you give the next command. Reply with one JSON object and nothing else." },
    {
      role: "user",
      content: `The building is a 3D scan of a real factory. ${level === "C4" ? "" : WORLD_FRAME}
Find ${scenario.beacons.length} beacons as fast as you can. You see a beacon once it is within ${SIGHT_M} m and in direct line of sight; nothing tells you where unseen beacons are.
${sense}
${act}
The drone is a sphere of radius ${P.droneRadius} m with top speed ${P.droneMaxSpeed} m/s; random wind gusts push it. Touching anything counts as a wall contact. You have ${TIME_LIMIT} s.
${level === "C1" ? `\nWaypoint graph (id [x,y,z] -> neighbours):\n${mapBrief(world)}\n` : ""}${opts.notes ? `\nYour notes from earlier searches:\n${opts.notes}\n` : ""}${p2 ? `\nYour memory (written by you last decision):\n${memory}\n` : ""}
Your last commands: ${JSON.stringify(recent)}

What the drone senses now:
${JSON.stringify(obs)}

Return JSON with these keys:
${keys.map((k) => "  " + k).join("\n")}`,
    },
  ];
}

export function rippleFog(world, scenario, level, chat, opts = {}) {
  // P2 memory lives here: core.rippleController keeps only command/say in its history.
  let memory = null;
  const read = (p) => {
    const rec = {
      command: level === "C1" ? { waypoint: p.waypoint, speed: p.speed } : level === "C2" ? { target: p.target, speed: p.speed } : level === "C3" ? { velocity: p.velocity } : { turn_deg: p.turn_deg, forward_mps: p.forward_mps, climb_mps: p.climb_mps },
      say: String(p.say ?? "").slice(0, 160),
    };
    if (opts.perception === "P2" && p.memory !== undefined) memory = rec.memory = String(p.memory).slice(0, 600);
    return rec;
  };
  const fallback = level === "C3" ? { velocity: [0, 0, 0] } : level === "C4" ? { turn_deg: 0, forward_mps: 0, climb_mps: 0 } : level === "C2" ? { target: null } : { waypoint: scenario.start, speed: 3 };
  return rippleController(chat, (obs, history) => fogMessages(world, scenario, level, obs, history, { ...opts, memory }), read, { fallback, meta: { env: "fog", level, scenario: scenario.id } });
}
