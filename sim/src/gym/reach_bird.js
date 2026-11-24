// Reach with a moving bird, at control level C3 only: the model (or its
// program) sets a velocity every second from text senses, and nothing else
// steers. The bird is a scripted hunter ported from engine.js (stepBird,
// birdNavTarget): it navigates on the waypoint graph and catches the drone
// within physics.catchDistance. The drone is a plain FreeDrone: no dodge, no
// replan, no controller of ours between the command and the motors.
//
// The bird reaches the pilot as a sense only (docs/CONTROL_LADDER.md): obs.bird
// gives its position, velocity and distance while it is in line of sight and
// within BIRD_SENSE_RANGE, otherwise only how long ago it was last seen. No
// prediction and no suggested direction.
//
// With no bird (scenario.bird missing, or opts.bird === false) this class is
// plain Reach: same observations, frames and results, byte for byte.

import { v } from "../world.js";
import { rng } from "../engine.js";
import { Reach, TIME_LIMIT, GOAL_RADIUS } from "./reach.js";
import { lineOfSight, r1, r2 } from "./core.js";

export const BIRD_SENSE_RANGE = 20; // metres; beyond this the bird is not reported even in the open
export const BIRD_STRATEGIES = ["pursue", "intercept", "ambush", "patrol"];
export const BIRD_STATES = ["hunt", "reposition", "return", "rest", "wait", "patrol"];
const SENSE_EVERY = 6; // ticks (0.1 s): how often the drone's bird sensor samples line of sight

// The bird's start jitter has its own generator, so the drone's wind (the
// FreeDrone generator seeded with `seed`) is the same with and without a bird.
const birdSeed = (seed) => ((seed >>> 0) ^ 0x9e3779b9) >>> 0;

export class ReachBird extends Reach {
  // scenario.bird: { start, home, strategy, speed, lead_time, trigger_distance }
  //   start, home  waypoint ids. pursue/intercept return to home to rest;
  //                ambush waits at home; patrol flies between start and home.
  constructor(world, scenario, seed, opts = {}) {
    super(world, scenario, seed, "C3", opts);
    const bp = opts.bird === false ? null : scenario.bird ?? null;
    this.bp = bp;
    this.bird = null;
    // "absent": practice flights with no bird in the building. The sensor still
    // reports { visible: false }, so a program cannot tell it from a hidden bird.
    this.birdAbsent = bp?.strategy === "absent";
    if (!bp || this.birdAbsent) return;
    if (!BIRD_STRATEGIES.includes(bp.strategy)) throw new Error(`unknown bird strategy ${bp.strategy}`);
    const N = world.nodes;
    if (!N[bp.start] || !N[bp.home]) throw new Error(`bird start/home must be waypoints (${bp.start}, ${bp.home})`);
    const R = rng(birdSeed(seed));
    const jitter = [R.normal() * 0.4, R.normal() * 0.2, R.normal() * 0.4];
    const br = this.P.birdRadius;
    let pos = world.resolve(v.add(N[bp.start], jitter), br);
    // Voxel maps do not push a point out of geometry: fall back to the waypoint.
    if (world.sphereHits(pos, br) || !world.segmentClear(N[bp.start], pos, br)) pos = N[bp.start].slice();
    this.bird = {
      pos,
      vel: [0, 0, 0],
      home: bp.home,
      state: bp.strategy === "ambush" ? "reposition" : bp.strategy === "patrol" ? "patrol" : "hunt",
      patrol: [N[bp.start].slice(), N[bp.home]],
      patrolIdx: 1,
      chase: 0,
      rest: 0,
      target: null,
      retarget: 0,
    };
    this.minBirdDist = v.dist(this.drone.pos, pos);
    this.closest = { t: 0, drone: r2(this.drone.pos), bird: r2(pos) };
    this.caughtAt = null;
    this.birdVisible = false;
    this.birdLastSeen = null; // time the sensor last had the bird in view
    this.sense();
    this.frames.length = 0;
    this.record();
  }

  // Frames: [t, x, y, z, heading] as in Reach, then the bird's
  // [bx, by, bz, state index into BIRD_STATES] so flights can be rendered.
  record() {
    super.record();
    if (!this.bird) return;
    this.frames[this.frames.length - 1].push(...r2(this.bird.pos), BIRD_STATES.indexOf(this.bird.state));
  }

  // ---------- perception ----------
  sense() {
    this.birdVisible = lineOfSight(this.world, this.drone.pos, this.bird.pos, BIRD_SENSE_RANGE);
    if (this.birdVisible) this.birdLastSeen = this.t;
  }

  observe() {
    const o = super.observe();
    if (this.birdAbsent) o.bird = { visible: false, last_seen_s_ago: null };
    if (!this.bird) return o;
    const b = this.bird;
    // A fresh reading at the moment of the observation.
    this.sense();
    o.bird = this.birdVisible
      ? { visible: true, position: r1(b.pos), velocity: r1(b.vel), distance_m: Math.round(v.dist(this.drone.pos, b.pos) * 10) / 10 }
      : { visible: false, last_seen_s_ago: this.birdLastSeen === null ? null : Math.round((this.t - this.birdLastSeen) * 10) / 10 };
    return o;
  }

  // ---------- bird (ported from engine.js Episode.birdNavTarget / stepBird) ----------
  birdNavTarget(aim) {
    const W = this.world;
    const b = this.bird;
    const r = this.P.birdRadius;
    if (W.segmentClear(b.pos, aim, r)) return aim;
    const from = W.nearestVisibleNode(b.pos, r);
    const to = W.nearestVisibleNode(aim, r);
    const path = W.path(from, to) || [from];
    let tgt = W.nodes[path[0]];
    for (let i = 1; i < path.length; i++) {
      if (W.segmentClear(b.pos, W.nodes[path[i]], r)) tgt = W.nodes[path[i]];
      else break;
    }
    if (v.dist(b.pos, tgt) < 0.6 && path.length > 1) tgt = W.nodes[path[1]];
    return tgt;
  }

  stepBird(dt) {
    const W = this.world;
    const P = this.P;
    const b = this.bird;
    const bp = this.bp;
    const d = this.drone;
    const home = W.nodes[b.home];
    let speed = bp.speed;
    let aim = null;

    if (b.state === "hunt") {
      b.chase += dt;
      const lead = bp.strategy === "pursue" ? 0 : bp.lead_time ?? 0;
      aim = v.add(d.pos, v.scale(d.vel, lead));
      const { min, max } = W.bounds;
      aim = aim.map((x, i) => Math.min(max[i] - 0.5, Math.max(min[i] + 0.5, x)));
      if (b.chase > P.birdStamina) {
        b.state = "return";
        b.chase = 0;
      }
    } else if (b.state === "reposition" || b.state === "return") {
      aim = home;
      speed = bp.speed * 0.8;
      if (v.dist(b.pos, home) < 0.8) {
        b.state = b.state === "return" ? "rest" : "wait";
        b.rest = P.birdRest;
      }
    } else if (b.state === "rest") {
      b.rest -= dt;
      if (b.rest <= 0) b.state = bp.strategy === "ambush" ? "wait" : bp.strategy === "patrol" ? "patrol" : "hunt";
    } else if (b.state === "wait" || b.state === "patrol") {
      if (b.state === "patrol") {
        aim = b.patrol[b.patrolIdx];
        speed = bp.speed * 0.6;
        if (v.dist(b.pos, aim) < 0.8) b.patrolIdx ^= 1;
      }
      const dd = v.dist(b.pos, d.pos);
      if (dd < bp.trigger_distance && this.step % 6 === 0 && W.segmentClear(b.pos, d.pos, 0.05)) {
        b.state = "hunt";
        b.target = null;
      }
    }

    let desired = [0, 0, 0];
    if (aim) {
      b.retarget -= dt;
      if (b.retarget <= 0 || !b.target) {
        b.target = this.birdNavTarget(aim);
        b.retarget = 0.2;
      }
      const to = v.sub(b.target, b.pos);
      const dist = v.len(to);
      const s = b.state === "hunt" ? speed : Math.min(speed, dist * 1.5);
      desired = v.scale(v.norm(to), s);
    }
    const acc = v.clampLen(v.scale(v.sub(desired, b.vel), 1 / 0.3), P.birdMaxAccel);
    b.vel = v.clampLen(v.add(b.vel, v.scale(acc, dt)), Math.min(P.birdMaxSpeed, Math.max(speed, 0.1)));
    const np = W.moveSphere(b.pos, v.add(b.pos, v.scale(b.vel, dt)), P.birdRadius);
    b.vel = v.scale(v.sub(np, b.pos), 1 / dt);
    b.pos = np;
  }

  // ---------- step ----------
  // Order as in engine.js: drone, then bird, then the catch test. Reaching the
  // goal ends the flight before the bird moves, so a flight that arrives is
  // never also caught on the same tick.
  tick(dt) {
    if (!this.bird) return super.tick(dt);
    if (this.done) return;
    const d = this.drone;
    d.step(dt, this.t);
    const gd = v.dist(d.pos, this.goalPos);
    this.minGoalDist = Math.min(this.minGoalDist, gd);
    const reached = gd < GOAL_RADIUS;
    if (!reached) this.stepBird(dt);
    this.t += dt;
    this.step++;
    const sep = v.dist(d.pos, this.bird.pos);
    if (sep < this.minBirdDist) {
      this.minBirdDist = sep;
      this.closest = { t: Math.round(this.t * 100) / 100, drone: r2(d.pos), bird: r2(this.bird.pos) };
    }
    if (reached) this.finish("reached");
    else if (sep < this.P.catchDistance) {
      this.caughtAt = r2(d.pos);
      this.finish("caught");
    } else if (this.t >= TIME_LIMIT) this.finish("timeout");
    if (this.step % SENSE_EVERY === 0) this.sense();
    if (this.step % 6 === 0 || this.done) this.record();
  }

  result() {
    const res = super.result();
    if (this.birdAbsent) return { ...res, minBirdDist: null, closest: null, caughtAt: null };
    if (!this.bird) return res;
    return { ...res, minBirdDist: Math.round(this.minBirdDist * 100) / 100, closest: this.closest, caughtAt: this.caughtAt };
  }
}

// ---------- scenario sets ----------
// One bird scenario per Reach route. For each route the generator walks a
// fixed, seeded list of candidate birds placed on or beside the route's graph
// path and keeps the first one that passes `admit(scenario)` (the caller's
// test that the bird meets the route and that the route is still solvable;
// see sim/tools/reach_bird_scenarios.mjs). Routes with no admitted candidate
// are returned in `rejected`. The route fields (id, start, goal, seeds) are
// unchanged, so train and dev stay disjoint exactly as in makeReachSets.
export function birdCandidates(world, route, { seed = 20261119, max = 40 } = {}) {
  const N = world.nodes;
  const path = world.path(route.start, route.goal);
  if (!path) return [];
  const R = rng((seed ^ hashId(route.id)) >>> 0);
  const pick = (xs) => xs[Math.floor(R.next() * xs.length)];
  const S = N[route.start], G = N[route.goal];
  // Nodes of the route's path that are not on top of the start or the goal.
  const mid = path.filter((id) => v.dist(N[id], S) >= 8 && v.dist(N[id], G) >= 6);
  // Graph neighbours of those nodes (side rooms and corridors beside the route).
  const beside = [...new Set(mid.flatMap((id) => world.adj[id]))].filter((id) => !path.includes(id) && v.dist(N[id], S) >= 8 && v.dist(N[id], G) >= 6);
  // Anywhere at least 12 m from the launch point (for hunters that come to the drone).
  const far = world.nodeIds.filter((id) => v.dist(N[id], S) >= 12 && v.dist(N[id], S) <= 30 && v.dist(N[id], G) >= 6);
  const speeds = [3.4, 3.8, 4.2];
  const out = [];
  const seen = new Set();
  const order = ["pursue", "intercept", "ambush", "patrol"];
  const first = hashId(route.id) % 4; // spread the four behaviours over the routes
  for (let k = 0; out.length < max && k < max * 3; k++) {
    const strategy = order[(first + Math.floor(k / 4)) % 4];
    let bird = null;
    if (strategy === "pursue" || strategy === "intercept") {
      if (!far.length) continue;
      const start = pick(far);
      bird = { start, home: start, strategy, speed: pick(speeds), lead_time: strategy === "intercept" ? 0.8 : 0, trigger_distance: 0 };
    } else if (strategy === "ambush") {
      if (!mid.length) continue;
      const home = pick(mid);
      const near = [home, ...world.adj[home]];
      bird = { start: pick(near), home, strategy, speed: pick(speeds), lead_time: 0.6, trigger_distance: pick([8, 10, 12]) };
    } else {
      if (!mid.length) continue;
      const a = pick(mid);
      const ends = [...world.adj[a].filter((id) => mid.includes(id) || beside.includes(id))];
      if (!ends.length) continue;
      bird = { start: a, home: pick(ends), strategy, speed: pick(speeds), lead_time: 0.6, trigger_distance: pick([8, 10, 12]) };
    }
    const key = JSON.stringify(bird);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bird);
  }
  return out;
}

function hashId(id) {
  let h = 2166136261;
  for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

// perRoute: how many admitted birds to keep per route, per set (the first
// admitted candidates, in the generator's fixed order). The first keeps the
// route id; later ones get "b", "c", ... appended.
export async function makeBirdSets(world, sets, admit, { perRoute = { train: 1, dev: 1 }, ...opts } = {}) {
  const out = { rejected: [] };
  for (const name of Object.keys(perRoute)) {
    out[name] = [];
    for (const route of sets[name]) {
      const kept = [];
      const cands = birdCandidates(world, route, opts);
      for (const [i, bird] of cands.entries()) {
        if (kept.length >= perRoute[name]) break;
        const sc = { ...route, bird };
        const verdict = await admit(sc);
        if (verdict) kept.push({ ...sc, id: route.id + (kept.length ? String.fromCharCode(97 + kept.length) : ""), admission: { candidate: i, ...verdict } });
      }
      out[name].push(...kept);
      if (!kept.length) out.rejected.push({ set: name, id: route.id, candidates: cands.length });
    }
  }
  return out;
}
