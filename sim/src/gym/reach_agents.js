// Controllers for Reach (docs/CONTROL_LADDER.md): Ripple at each control
// level, plus baselines that follow the same rules (the planner baseline is
// the only one with a map, and it exists only at C1, as an upper bound).

import { v } from "../world.js";
import { rippleController, clearance } from "./core.js";

const r1 = (p) => p.map((x) => Math.round(x * 10) / 10);

function mapBrief(world) {
  const N = world.nodes;
  return world.nodeIds.map((id) => `${id} ${JSON.stringify(r1(N[id]))} -> ${world.adj[id].join(", ")}`).join("\n");
}

const WORLD_FRAME = "Coordinates are [x, y, z] in metres: +x is east, +z is north, +y is up.";

// ---------- harness features (senses / structure / memory; never a plan) ----------
// Selected with opts.features, e.g. ["rel", "struct", "ascii", "trail"].
const COMPASS8 = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];
const compassOf = (dx, dz) => COMPASS8[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8];

// rel: the goal as a relative vector with its compass direction (a sensor reading).
function relGoal(env) {
  const d = env.drone.pos, g = env.goalPos;
  const dx = g[0] - d[0], dy = g[1] - d[1], dz = g[2] - d[2];
  return { dx: Math.round(dx * 10) / 10, dy: Math.round(dy * 10) / 10, dz: Math.round(dz * 10) / 10, direction: compassOf(dx, dz), horizontal_distance_m: Math.round(Math.hypot(dx, dz) * 10) / 10 };
}

// ascii: top-down occupancy around the drone at its flight height, 1 m cells.
// World-frame maps have north up; the egocentric map (C4) has "ahead" up.
export function asciiMap(env, egocentric, R = 7) {
  const W = env.world, p = env.drone.pos, g = env.goalPos;
  const h = env.heading;
  const rows = [];
  for (let r = R; r >= -R; r--) {
    let line = "";
    for (let c = -R; c <= R; c++) {
      let wx, wz;
      if (egocentric) {
        // up = ahead, right = right-hand side
        const ax = Math.cos(h), az = Math.sin(h), rx = Math.sin(h), rz = -Math.cos(h);
        wx = p[0] + r * ax + c * rx;
        wz = p[2] + r * az + c * rz;
      } else {
        wx = p[0] + c;
        wz = p[2] + r;
      }
      if (r === 0 && c === 0) line += "D";
      else if (Math.hypot(wx - g[0], wz - g[2]) < 0.75) line += "G";
      else line += W.sphereHits([wx, p[1], wz], 0.35) ? "#" : ".";
    }
    rows.push(line);
  }
  return rows.join("\n");
}

function featureBlock(env, level, features) {
  if (!env || !features?.length) return "";
  const parts = [];
  if (features.includes("rel") && level !== "C4") parts.push(`Goal relative to you (dx east, dy up, dz north): ${JSON.stringify(relGoal(env))}`);
  if (features.includes("ascii")) {
    const ego = level === "C4";
    parts.push(`Top-down map of what your sensors see around you at your height (1 character = 1 m; D = you, G = goal if within view, # = obstacle, . = free; ${ego ? "up = straight ahead, left = your left" : "up = north, right = east"}):\n${asciiMap(env, ego)}`);
  }
  if (features.includes("trail")) {
    const F = env.frames;
    const trail = [];
    for (let t = Math.max(0, Math.floor(env.t) - 10); t <= Math.floor(env.t); t += 2) {
      const f = F.find((fr) => fr[0] >= t - 1e-6);
      if (f) trail.push(level === "C4" ? Math.round(Math.hypot(f[1] - env.goalPos[0], f[3] - env.goalPos[2]) * 10) / 10 : [f[1], f[2], f[3]].map((x) => Math.round(x * 10) / 10));
    }
    const recentContacts = env.drone.contacts.filter((c) => c.t > env.t - 10).length;
    parts.push(level === "C4" ? `Your horizontal distance to the goal over the last 10 s (every 2 s): ${JSON.stringify(trail)}; wall contacts in the last 10 s: ${recentContacts}` : `Your positions over the last 10 s (every 2 s): ${JSON.stringify(trail)}; wall contacts in the last 10 s: ${recentContacts}`);
  }
  if (features.includes("warn")) {
    // Proximity / time-to-contact sensor, like a real drone's obstacle warning.
    const d = env.drone;
    const r = env.P.droneRadius;
    const all = clearance(env.world, d.pos, r);
    const [nearDir, nearM] = Object.entries(all).reduce((b, e) => (e[1] < b[1] ? e : b));
    const speed = Math.hypot(...d.vel);
    let line = `Proximity sensor: closest obstacle ${nearM} m to the ${nearDir.replace("_", "-")}.`;
    if (speed > 0.3) {
      const u = d.vel.map((x) => x / speed);
      const ahead = clearance(env.world, d.pos, r, 12, 0.25, { along: u }).along;
      const heading = level === "C4" ? "ahead" : compassOf(d.vel[0], d.vel[2]);
      line += ` You are moving ${speed.toFixed(1)} m/s toward the ${heading}; ${ahead >= 12 ? "no obstacle within 12 m on that line." : `at this velocity you touch an obstacle in ${(ahead / speed).toFixed(1)} s (${ahead} m).`}`;
    }
    parts.push(line);
  }
  return parts.length ? `\n${parts.join("\n\n")}\n` : "";
}

// named: the command names a compass direction and a speed; the harness turns
// that into the velocity vector (an encoding of the same C3 action, not a plan).
export const NAMED_DIRS = { east: 0, north_east: 45, north: 90, north_west: 135, west: 180, south_west: 225, south: 270, south_east: 315 };
export function namedToVelocity(p) {
  const dir = String(p.direction ?? "").toLowerCase().replace(/[- ]/g, "_");
  const speed = Math.max(0, Math.min(5.5, Number(p.speed) || 0));
  const vy = Math.max(-2, Math.min(2, Number(p.vertical_mps) || 0));
  if (!(dir in NAMED_DIRS)) return [0, vy, 0]; // "hold" or unknown: hover (with any vertical motion)
  const a = (NAMED_DIRS[dir] * Math.PI) / 180;
  return [speed * Math.cos(a), vy, speed * Math.sin(a)];
}

const STRUCT = {
  C1: [],
  C2: ['"goal_direction": compass direction of the goal from you', '"blocked": list of directions with less than 1.5 m free space', '"chosen_direction": the compass direction you will move in, and it must be one that is not blocked'],
  C3: ['"goal_direction": compass direction of the goal from you', '"blocked": list of directions with less than 1.5 m free space', '"chosen_direction": the compass direction you will move in, and it must be one that is not blocked'],
  C4: ['"goal_side": "ahead", "left", "right" or "behind"', '"blocked": list of body directions with less than 1.5 m free space', '"chosen_direction": "ahead", "ahead_left", "left", ... the direction you will fly, which must not be blocked'],
};
const FACTORY_SCENE = "The building is a 3D scan of a real factory: halls, rooms, pillars, machinery and clutter.";
function rules(world, level, dt = 1, scene = FACTORY_SCENE) {
  const P = world.physics;
  const sense =
    level === "C1"
      ? "You know the building's waypoint graph (below). An autopilot plans the shortest path along the graph to the waypoint you choose and flies it."
      : level === "C4"
        ? "You have no map. You sense, relative to your own heading: the goal's bearing and distance, and free space (metres, up to 12) in 8 directions around you plus up and down. You do not know your coordinates."
        : "You have no map. You sense your position and velocity, the goal's position, whether the goal is in direct line of sight, and free space (metres, up to 12) in 8 compass directions plus up and down.";
  const act =
    level === "C1"
      ? "Your command picks the next waypoint to route through and a cruise speed."
      : level === "C2"
        ? "Your command is a target point: the drone flies in a straight line toward it at your speed and stops there. Nothing plans a path for you; if a wall is in the way, the drone will press against it."
        : level === "C3"
          ? `Your command is a velocity the drone holds for the next ${dt === 1 ? "second" : dt + " seconds"}. Nothing plans a path for you.`
          : "Your command turns the drone (degrees, positive = left), then sets its forward speed and climb rate for the next second. Nothing plans a path for you.";
  return `${scene} ${level === "C4" ? "" : WORLD_FRAME}
${sense}
${act}
The drone is a sphere of radius ${P.droneRadius} m with top speed ${P.droneMaxSpeed} m/s; random wind gusts push it. Touching anything counts as a wall contact (it slows you and counts against you). You reach the goal within 1 m of it. You have ${90} s. You give a new command every ${dt === 1 ? "second" : dt + " seconds"}.`;
}

const PREDICT_POS = '"predict_position_in_1s": [x, y, z] where you expect to be one second from now';
const PREDICT_GOAL = '"predict_goal_distance_in_1s": the distance to the goal in metres you expect one second from now';
const SAY = '"say": at most 12 words: what you are doing and why';
// memory feature: the model keeps its own notes from one second to the next,
// and sees where it has been. Without it, live steering only sees its last
// three commands, so it cannot tell that it is going in circles.
const MEMORY = '"memory": at most 40 words to hand to yourself next second: where you have been, what was blocked, your plan';
export const MEMORY_STEPS = 8;
export const MEMORY_CHARS = 320;
const r1m = (x) => Math.round(x * 10) / 10;
function memoryBlock(level, history) {
  const steps = history.slice(-MEMORY_STEPS).map((h) => ({
    t: h.t,
    ...(level === "C4" ? {} : { position: h.obs?.position }),
    goal_distance_m: h.obs?.goal?.distance_m !== undefined ? r1m(h.obs.goal.distance_m) : undefined,
    command: h.command,
    said: h.say,
  }));
  const note = history.length ? history[history.length - 1].memory || "" : "";
  return `Your last ${MEMORY_STEPS} seconds, oldest first (where you were, how far the goal was, what you commanded): ${JSON.stringify(steps)}

Your memory, written by you last second: ${note ? JSON.stringify(note) : "(nothing yet)"}`;
}
const COMMAND = {
  C1: ['"waypoint": the waypoint id to route through (the goal id goes straight to the goal)', '"speed": cruise speed in m/s, 0.3 to 5.5'],
  C2: ['"target": [x, y, z] the point to fly to in a straight line', '"speed": m/s, 0.3 to 5.5'],
  C3: ['"velocity": [vx, vy, vz] in m/s (vector length at most 5.5)'],
  C4: ['"turn_deg": -180 to 180 (positive = left)', '"forward_mps": -2 to 5.5', '"climb_mps": -2 to 2'],
};

// lean (C3): the same information in far fewer tokens. Short rules, compact
// observation, only the previous command, and only the goal-distance forecast.
function leanMessages(world, obs, history, opts) {
  const dt = opts.dt || 1;
  const h = (x) => Math.round(x * 2) / 2;
  const fs = obs.free_space_m;
  const o = {
    t: Math.round(obs.time_s),
    pos: obs.position,
    vel: obs.velocity,
    goal: obs.goal.position,
    goal_dist: Math.round(obs.goal.distance_m),
    goal_visible: obs.goal.in_line_of_sight,
    free: { E: h(fs.east), NE: h(fs.north_east), N: h(fs.north), NW: h(fs.north_west), W: h(fs.west), SW: h(fs.south_west), S: h(fs.south), SE: h(fs.south_east), up: h(fs.up), down: h(fs.down) },
  };
  const last = history.length ? history[history.length - 1].command : null;
  return [
    { role: "system", content: "You pilot a drone. Reply with one JSON object only." },
    {
      role: "user",
      content: `Drone in a factory building, no map. Axes: +x east, +z north, +y up (metres). You set a velocity [vx, vy, vz] (m/s, length at most 5.5) held for ${dt} s. "free" is metres of open space by direction. Touching anything slows you. Reach within 1 m of the goal within 90 s.${opts.notes ? `\nNotes: ${opts.notes}` : ""}
Last command: ${JSON.stringify(last)}
Now: ${JSON.stringify(o)}
Reply: {"velocity": [vx, vy, vz], "goal_dist_next": metres to goal after this command, "say": "at most 8 words"}`,
    },
  ];
}

export function reachMessages(world, scenario, level, obs, history, opts = {}, env = null) {
  const f = opts.features || [];
  if (f.includes("lean") && level === "C3") return leanMessages(world, obs, history, opts);
  const named = f.includes("named") && level === "C3";
  const command = named
    ? ['"direction": one of "east", "north_east", "north", "north_west", "west", "south_west", "south", "south_east", or "hold" (stay in place)', '"speed": horizontal speed in m/s, 0 to 5.5', '"vertical_mps": climb (+) or descend (-) in m/s, -2 to 2']
    : COMMAND[level];
  const mem = f.includes("memory");
  const keys = [...(f.includes("struct") ? STRUCT[level] : []), ...command, ...(level === "C4" ? [] : [PREDICT_POS]), PREDICT_GOAL, SAY, ...(mem ? [MEMORY] : [])];
  const recent = history.slice(-3).map((h) => ({ t: h.t, command: h.command, said: h.say }));
  return [
    { role: "system", content: "You are piloting a small drone through an indoor building. Every second you receive what the drone senses and you give the next command. Reply with one JSON object and nothing else." },
    {
      role: "user",
      content: `${rules(world, level, opts.dt || 1, opts.scene || FACTORY_SCENE)}
${level === "C1" ? `\nWaypoint graph (id [x,y,z] -> neighbours):\n${mapBrief(world)}\n` : ""}${opts.notes ? `\nYour notes from earlier flights:\n${opts.notes}\n` : ""}
${mem ? memoryBlock(level, history) : `Your last commands: ${JSON.stringify(recent)}`}

What the drone senses now:
${JSON.stringify(obs)}
${featureBlock(env, level, f)}
Return JSON with these keys${f.includes("struct") ? ", in this order (each value must follow from the ones before it)" : ""}:
${keys.map((k) => "  " + k).join("\n")}`,
    },
  ];
}

export function rippleReach(world, scenario, level, chat, opts = {}) {
  const named = (opts.features || []).includes("named") && level === "C3";
  const read = (p) => {
    const command = named
      ? { velocity: namedToVelocity(p) }
      : level === "C1" ? { waypoint: p.waypoint, speed: p.speed } : level === "C2" ? { target: p.target, speed: p.speed } : level === "C3" ? { velocity: p.velocity } : { turn_deg: p.turn_deg, forward_mps: p.forward_mps, climb_mps: p.climb_mps };
    const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
    return {
      command,
      prediction: {
        position: Array.isArray(p.predict_position_in_1s) && p.predict_position_in_1s.length === 3 ? p.predict_position_in_1s.map(Number) : null,
        goalDistance: num(p.predict_goal_distance_in_1s ?? p.goal_dist_next),
      },
      say: String(p.say ?? "").slice(0, 160),
      ...((opts.features || []).includes("memory") ? { memory: String(p.memory ?? "").slice(0, MEMORY_CHARS) } : {}),
      ...(named ? { named: { direction: p.direction ?? null, speed: p.speed ?? null, vertical_mps: p.vertical_mps ?? null } } : {}),
      ...(p.chosen_direction !== undefined ? { structured: { goal: p.goal_direction ?? p.goal_side ?? null, blocked: p.blocked ?? null, chosen: p.chosen_direction } } : {}),
    };
  };
  // What a usable reply must contain at each level. Without this, a reply
  // with the wrong shape used to become a silent hover that was not counted
  // as invalid.
  const nums = (xs, n) => Array.isArray(xs) && xs.length === n && xs.every((x) => x !== null && x !== "" && typeof x !== "boolean" && Number.isFinite(Number(x)));
  const num1 = (x) => nums([x], 1);
  const check = named ? null : (p) =>
    level === "C3" ? (nums(p.velocity, 3) ? null : "velocity must be three numbers")
    : level === "C4" ? (num1(p.turn_deg) && num1(p.forward_mps) && num1(p.climb_mps) ? null : "turn_deg, forward_mps and climb_mps must be numbers")
    : level === "C2" ? (nums(p.target, 3) ? null : "target must be three numbers")
    : (typeof p.waypoint === "string" && world.nodes[p.waypoint] ? null : "waypoint must be a known waypoint name");
  // A turn is relative: holding the previous command must not turn again.
  const stand = level === "C4" ? (prev) => ({ ...prev, turn_deg: 0 }) : (prev) => prev;
  const fallback = level === "C3" ? { velocity: [0, 0, 0] } : level === "C4" ? { turn_deg: 0, forward_mps: 0, climb_mps: 0 } : level === "C2" ? { target: null } : { waypoint: scenario.goal, speed: 3 };
  return rippleController(chat, (obs, history, o, env) => reachMessages(world, scenario, level, obs, history, opts, env), read, { fallback, check, stand, meta: { env: "reach", level, scenario: scenario.id } });
}

// ---------- baselines ----------
// Map + planner upper bound (C1): A* straight to the goal.
export const plannerReach = (world, scenario) => async () => ({ command: { waypoint: scenario.goal, speed: 4.5 }, say: "A* to goal" });

// Straight-line flyer (C2): aim at the goal; no avoidance.
export const straightReach = (world, scenario) => async (obs) => ({ command: { target: obs.goal.position, speed: 4 }, say: "straight at goal" });

// Reactive avoider (C3), senses only: pick the compass direction that best
// trades heading toward the goal against free space, with a small bonus for
// keeping its previous direction; match the goal's height. The parameters are
// exposed so the avoider can be tuned on training routes with the same search
// budget the code-as-policy loop gets (sim/tools/study/reach_tune_avoider.mjs); the
// defaults are the hand-written values every earlier run used.
export const AVOIDER_DEFAULTS = { minFree: 1.0, freeWeight: 0.6, freeCap: 4, stick: 0.15, maxSpeed: 3, margin: 0.5, climb: 1 };
export const reactiveReach = (world, scenario, params = {}) => {
  const P = { ...AVOIDER_DEFAULTS, ...params };
  const C = { east: [1, 0], north_east: [Math.SQRT1_2, Math.SQRT1_2], north: [0, 1], north_west: [-Math.SQRT1_2, Math.SQRT1_2], west: [-1, 0], south_west: [-Math.SQRT1_2, -Math.SQRT1_2], south: [0, -1], south_east: [Math.SQRT1_2, -Math.SQRT1_2] };
  let prev = null;
  return async (obs) => {
    const to = v.sub(obs.goal.position, obs.position);
    const flat = Math.hypot(to[0], to[2]) || 1;
    const g = [to[0] / flat, to[2] / flat];
    let best = null;
    for (const [name, d] of Object.entries(C)) {
      const free = obs.free_space_m[name];
      if (free < P.minFree) continue;
      const score = d[0] * g[0] + d[1] * g[1] + P.freeWeight * Math.min(free, P.freeCap) / P.freeCap + (name === prev ? P.stick : 0);
      if (!best || score > best.score) best = { name, d, score, free };
    }
    if (!best) return { command: { velocity: [0, 1, 0] }, say: "boxed in: climb" };
    prev = best.name;
    const speed = Math.min(P.maxSpeed, best.free - P.margin);
    const vy = Math.max(-P.climb, Math.min(P.climb, to[1]));
    return { command: { velocity: [best.d[0] * speed, vy, best.d[1] * speed] }, say: `go ${best.name}` };
  };
};
