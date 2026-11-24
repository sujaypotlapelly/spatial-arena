// Arena runner: flies and replays Reach episodes with the published simulator.
// Runs unchanged in Node (tests) and in the browser (the page). Every physics
// and sensing call goes to sim/src, which is imported read-only: the loop is
// core.js runEpisode itself, and replay re-applies recorded commands the way
// core.js replayEpisode does, reading the observation before each command so
// the page can show what the controller saw.

import { World } from "../sim/src/world.js";
import { Reach } from "../sim/src/gym/reach.js";
import { runEpisode, DT_DECISION } from "../sim/src/gym/core.js";
import { straightReach, reactiveReach } from "../sim/src/gym/reach_agents.js";

export const MAP_PATH = "sim/maps/factory-full.json"; // the benchmark map (sim/scenes/benchmark-sets.json)
export const SCENARIO_PATH = "sim/scenarios/reach-factory.json";

export function makeWorld(mapJson) {
  return new World(mapJson);
}

// FNV-1a over a JSON string: a small, synchronous fingerprint that is the same
// in Node and every browser.
export function fingerprint(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Hand-written controllers, exactly as the benchmark builds them
// (sim/tools/reach_eval.mjs: straight@C2, reactive@C3).
export const BUILTIN = {
  straight: { level: "C2", make: (world, sc) => straightReach(world, sc) },
  reactive: { level: "C3", make: (world, sc) => reactiveReach(world, sc) },
};

// Fly one episode. `controller(obs, env)` returns { command, say?, error? }
// (the benchmark's controller shape). Returns everything the page needs:
// the result, the per-second log (observation in, reply out, applied
// command), the 0.1 s frames and the wall contacts.
export async function fly(world, scenario, seed, level, controller) {
  const env = new Reach(world, scenario, seed, level);
  const seen = [];
  const replies = [];
  const wrapped = async (obs, e) => {
    seen.push(obs);
    const rec = await controller(obs, e);
    replies.push(rec);
    return rec;
  };
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const ep = await runEpisode(env, wrapped, { dt: DT_DECISION });
  const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  const steps = ep.decisions.map((d, i) => ({
    t: d.t,
    obs: seen[i],
    reply: replies[i]?.command ?? null,
    say: replies[i]?.say ?? "",
    error: replies[i]?.error ?? null,
    command: d.command, // what the simulator applied (sanitized)
  }));
  return { result: ep.result, steps, frames: ep.frames, contacts: env.drone.contacts.slice(), ms };
}

// Re-fly recorded commands with no controller at all. Same physics, same wind
// seed, so the flight comes out identical; the observation before each
// command is recomputed (observe() has no side effects).
export function replay(world, scenario, seed, level, commands) {
  const env = new Reach(world, scenario, seed, level);
  const stepsPer = Math.round(DT_DECISION / env.P.dt);
  const steps = [];
  for (const c of commands) {
    if (env.done) break;
    const t = Math.round(env.t * 100) / 100;
    const obs = env.observe();
    const command = env.apply(c);
    steps.push({ t, obs, reply: c, say: "", error: null, command });
    for (let k = 0; k < stepsPer && !env.done; k++) env.tick(env.P.dt);
  }
  return { result: env.result(), steps, frames: env.frames, contacts: env.drone.contacts.slice() };
}

// Leaderboard order: reached first, then time, then wall contacts; closest
// approach to the goal breaks any remaining tie (it separates timeouts).
export function compareRuns(a, b) {
  const ra = a.result.outcome === "reached" ? 1 : 0;
  const rb = b.result.outcome === "reached" ? 1 : 0;
  if (ra !== rb) return rb - ra;
  if (a.result.time !== b.result.time) return a.result.time - b.result.time;
  if (a.result.contacts !== b.result.contacts) return a.result.contacts - b.result.contacts;
  return a.result.minGoalDist - b.result.minGoalDist;
}
