// Controllers for ReachBird (sim/src/gym/reach_bird.js).
//   plannerKeepAway  PRIVILEGED: reads the map, A* and the bird's true position
//                    from the environment. It exists only to admit scenarios
//                    (is this bird on the route, and can the route still be
//                    flown?) and as an upper-bound row. Never a model condition.
//   birdAwareReach   senses only: the reactive avoider of reach_agents.js with
//                    one more term that uses obs.bird.

import { v } from "../world.js";
import { AVOIDER_DEFAULTS } from "./reach_agents.js";

// Map + A* + a simple keep-away, speaking the same C3 interface as the model
// (one velocity per second). keepAway: false gives the same planner blind to
// the bird, used to check that a scenario's bird actually meets the route.
export const plannerKeepAway = (world, scenario, { keepAway = true, speed = 3.5, avoid = 7 } = {}) => async (obs, env) => {
  const N = world.nodes;
  const d = env.drone;
  const r = env.P.droneRadius;
  const max = env.P.droneMaxSpeed;
  const b = keepAway ? env.bird : null;
  const here = world.nearestVisibleNode(d.pos, r);
  // Graph nodes near the bird cost more, as in engine.js's replan.
  const penalty = b ? (id) => 40 * Math.max(0, 1 - v.dist(N[id], b.pos) / 9) : null;
  const path = world.path(here, scenario.goal, penalty) || [here];
  let tgt = N[path[0]];
  for (let i = 1; i < path.length; i++) {
    if (world.segmentClear(d.pos, N[path[i]], r + 0.3)) tgt = N[path[i]];
    else break;
  }
  if (v.dist(d.pos, tgt) < 0.8 && path.length > 1) tgt = N[path[1]];
  const to = v.sub(tgt, d.pos);
  // The command holds for a second: do not fly past the target.
  let desired = v.scale(v.norm(to), Math.min(speed, Math.max(0.6, v.len(to))));
  let say = "A* to goal";
  if (b) {
    const bd = v.dist(d.pos, b.pos);
    if (bd < avoid && world.segmentClear(d.pos, b.pos, 0.05)) {
      const away = v.norm(v.sub(d.pos, b.pos));
      const w = 1.5 * (1 - bd / avoid);
      const evaded = v.clampLen(v.add(desired, v.scale(away, w * max)), max);
      // Only dodge if the dodge itself stays clear of geometry for the second.
      if (world.segmentClear(d.pos, v.add(d.pos, v.scale(evaded, 0.6)), r)) {
        desired = evaded;
        say = "A* to goal, keeping away from the bird";
      }
    }
  }
  return { command: { velocity: desired }, say };
};

// Senses-only avoider that also uses obs.bird. Same direction scoring as
// reactiveReach; while the bird is in view (or was seen within `memory_s`) and
// closer than `fear_m`, directions that point toward it are penalised and the
// drone flies faster. It knows nothing the observation does not say.
export const BIRD_AVOIDER_DEFAULTS = { ...AVOIDER_DEFAULTS, fear_m: 9, birdWeight: 1.6, fleeSpeed: 5, memory_s: 2 };
export const birdAwareReach = (world, scenario, params = {}) => {
  const P = { ...BIRD_AVOIDER_DEFAULTS, ...params };
  const C = { east: [1, 0], north_east: [Math.SQRT1_2, Math.SQRT1_2], north: [0, 1], north_west: [-Math.SQRT1_2, Math.SQRT1_2], west: [-1, 0], south_west: [-Math.SQRT1_2, -Math.SQRT1_2], south: [0, -1], south_east: [Math.SQRT1_2, -Math.SQRT1_2] };
  let prev = null;
  let last = null; // last bird reading: { position, velocity, t }
  return async (obs) => {
    const to = v.sub(obs.goal.position, obs.position);
    const flat = Math.hypot(to[0], to[2]) || 1;
    const g = [to[0] / flat, to[2] / flat];
    if (obs.bird?.visible) last = { position: obs.bird.position, velocity: obs.bird.velocity, t: obs.time_s };
    // Where the bird is now, as far as the drone can tell (its last reading, moved along its last velocity).
    let threat = null;
    if (last && obs.time_s - last.t <= P.memory_s) {
      const age = obs.time_s - last.t;
      const bp = v.add(last.position, v.scale(last.velocity, age));
      const off = v.sub(bp, obs.position);
      const dist = v.len(off);
      const fl = Math.hypot(off[0], off[2]) || 1;
      if (dist < P.fear_m) threat = { dir: [off[0] / fl, off[2] / fl], w: P.birdWeight * (1 - dist / P.fear_m), dist };
    }
    let best = null;
    for (const [name, d] of Object.entries(C)) {
      const free = obs.free_space_m[name];
      if (free < P.minFree) continue;
      let score = d[0] * g[0] + d[1] * g[1] + (P.freeWeight * Math.min(free, P.freeCap)) / P.freeCap + (name === prev ? P.stick : 0);
      if (threat) score -= threat.w * (d[0] * threat.dir[0] + d[1] * threat.dir[1]);
      if (!best || score > best.score) best = { name, d, score, free };
    }
    if (!best) return { command: { velocity: [0, 1, 0] }, say: "boxed in: climb" };
    prev = best.name;
    const speed = Math.max(0.3, Math.min(threat ? P.fleeSpeed : P.maxSpeed, best.free - P.margin));
    const vy = Math.max(-P.climb, Math.min(P.climb, to[1]));
    return { command: { velocity: [best.d[0] * speed, vy, best.d[1] * speed] }, say: threat ? `bird ${threat.dist.toFixed(1)} m: go ${best.name}` : `go ${best.name}` };
  };
};
