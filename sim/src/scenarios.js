// Scenario helpers: reference routes, solvability checks, episode runs.
// A scenario is { id, start, goal, bird, seeds }. The simulator, not a
// model, decides whether a scenario is solvable and how an episode ends.

import { Episode, summarize } from "./engine.js";
import { routeMenu } from "./world.js";
import { allowedBirdNodes } from "./policy.js";

export const TRAINING_TASK = { start: "start", goal: "goal" };
export const TRAINING_SEEDS = [101, 102, 103, 104];

// Reference controllers the solvability check tries on every route.
const REFERENCE_CONFIGS = [
  { cruise_speed: 3.5, corner_slowdown: 0.5, avoidance_distance: 0, evade_strength: 0, replan_when_bird_nearby: false },
  { cruise_speed: 4.0, corner_slowdown: 0.6, avoidance_distance: 6, evade_strength: 0.6, replan_when_bird_nearby: true },
  { cruise_speed: 4.6, corner_slowdown: 0.6, avoidance_distance: 0, evade_strength: 0, replan_when_bird_nearby: false },
];

export function runEpisode(world, scenario, policy, { keepFrames = true } = {}) {
  const eps = scenario.seeds.map((seed) => {
    const ep = new Episode(world, scenario, policy, seed);
    ep.run();
    return ep;
  });
  const results = eps.map((e) => e.result);
  return { results, frames: keepFrames ? eps.map((e) => e.frames) : null, summary: summarize(results) };
}

// Solvable = some reference route + controller reaches the goal in at
// least half the seeds. Returns the best witness for display.
export function checkSolvable(world, scenario) {
  const menu = routeMenu(world, scenario.start, scenario.goal);
  let best = null;
  for (const r of menu) {
    for (const cfg of REFERENCE_CONFIGS) {
      const pol = { ...cfg, route: r.route, route_id: r.id };
      const { summary } = runEpisode(world, scenario, pol, { keepFrames: false });
      if (!best || summary.reached > best.reached) best = { route_id: r.id, label: r.label, config: cfg, reached: summary.reached };
      if (summary.reached === scenario.seeds.length) break;
    }
    if (best && best.reached === scenario.seeds.length) break;
  }
  return { solvable: !!best && best.reached >= Math.ceil(scenario.seeds.length / 2), witness: best };
}

// Shortest route length for path-efficiency.
export function referenceLength(world, scenario) {
  return routeMenu(world, scenario.start, scenario.goal)[0].length;
}

// A random solvable scenario for showing the variety of tasks: random
// start/goal pair, bird start and hidden behavior, same parameter ranges as
// tools/legacy/make_heldout.mjs. Deterministic for a given seed. Not used for
// evaluation; the held-out sets stay fixed files.
const BEHAVIORS = ["pursue", "intercept", "ambush", "patrol"];
export function randomScenario(world, seed, { id = `R${seed % 10000}`, strategy = null, attempts = 25 } = {}) {
  const R = rngFor(seed);
  const pick = (a) => a[Math.floor(R() * a.length)];
  const N = world.nodes;
  const ids = world.nodeIds.filter((n) => n !== world.map.birdStart);
  const flat = (a, b) => Math.hypot(N[a][0] - N[b][0], N[a][2] - N[b][2]);
  // Scan maps are one large hall: insist on long crossings. The building
  // has floors, so a shorter flat distance can still be a long route.
  const minDist = world.grid ? 30 : 12;
  for (let k = 0; k < attempts; k++) {
    const start = pick(ids);
    const far = ids.filter((g) => g !== start && flat(start, g) >= minDist);
    if (!far.length) continue;
    const goal = pick(far);
    const seeds = [0, 1, 2, 3].map((i) => (seed * 7 + k * 31 + i) % 1e6);
    const base = { start, goal, seeds };
    const allowed = allowedBirdNodes(world, base);
    if (!allowed.length || !routeMenu(world, start, goal).length) continue;
    const s = strategy || pick(BEHAVIORS);
    const bird = {
      start: pick(allowed),
      strategy: s,
      ambush_node: pick(allowed),
      speed: Math.round((3.6 + R() * 1.0) * 10) / 10,
      lead_time: s === "pursue" ? 0 : Math.round(R() * 15) / 10,
      trigger_distance: Math.round(8 + R() * 8),
    };
    if (s === "pursue" || s === "intercept") bird.ambush_node = bird.start;
    if (s === "patrol" && bird.ambush_node === bird.start) continue;
    const sc = { id, ...base, bird, random: true };
    const solv = checkSolvable(world, sc);
    if (solv.solvable) return { ...sc, witness: solv.witness };
  }
  return null;
}
function rngFor(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
