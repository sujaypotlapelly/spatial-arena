// Fixed-step simulation. Executes a drone policy and a bird policy in the
// world and decides the outcome. The model never runs here; it only chose
// the policies beforehand.

import { v } from "./world.js";

export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(1e-9, next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return { next, normal };
}

export const OUTCOME = { REACHED: "reached", INTERCEPTED: "intercepted", CRASHED: "crashed", TIMEOUT: "timeout" };

export class Episode {
  // scenario: { start, goal, bird: { start, strategy, ambush_node, speed, lead_time, trigger_distance } }
  constructor(world, scenario, dronePolicy, seed = 1, { recordEvery = 2 } = {}) {
    const birdPolicy = scenario.bird;
    this.scenario = scenario;
    this.start = scenario.start || world.map.start;
    this.goal = scenario.goal || world.map.goal;
    // The drone hovers at its start for this long while the bird is observed,
    // then flies its plan. Observations shown to the model come from here.
    this.hold = scenario.hold ?? world.physics.observeSeconds ?? 0;
    this.world = world;
    this.P = world.physics;
    this.dp = dronePolicy;
    this.bp = birdPolicy;
    this.seed = seed;
    this.R = rng(seed);
    this.recordEvery = recordEvery;
    const N = world.nodes;

    this.t = 0;
    this.step = 0;
    this.done = false;
    this.result = null;
    this.events = [];
    this.frames = [];

    this.drone = {
      pos: N[this.start].slice(),
      vel: [0, 0, 0],
      route: dronePolicy.route.slice(),
      idx: 1,
      gust: [0, 0, 0],
      replanCooldown: 0,
      evading: false,
      pathLength: 0,
    };

    const jitter = [this.R.normal() * 0.4, this.R.normal() * 0.2, this.R.normal() * 0.4];
    const home = birdPolicy.ambush_node;
    this.bird = {
      pos: world.resolve(v.add(N[birdPolicy.start || world.map.birdStart], jitter), this.P.birdRadius),
      vel: [0, 0, 0],
      home,
      state: birdPolicy.strategy === "ambush" ? "reposition" : birdPolicy.strategy === "patrol" ? "patrol" : "hunt",
      // patrol flies back and forth between its start and ambush_node
      patrol: [v.add(N[birdPolicy.start || world.map.birdStart], [0, 0, 0]), N[home]],
      patrolIdx: 1,
      chase: 0,
      rest: 0,
      target: null,
      retarget: 0,
    };
    this.minSep = Infinity;
    this.closest = null;
    this.record();
  }

  log(type, detail = "") {
    this.events.push({ t: Math.round(this.t * 100) / 100, type, detail });
  }

  record() {
    this.frames.push({
      t: this.t,
      d: this.drone.pos.slice(),
      dv: this.drone.vel.slice(),
      b: this.bird.pos.slice(),
      bs: this.bird.state,
    });
  }

  finish(outcome, detail = "") {
    this.done = true;
    const W = this.world;
    this.log(outcome, detail);
    this.record();
    this.result = {
      seed: this.seed,
      outcome,
      detail,
      time: Math.round(this.t * 100) / 100,
      pathLength: Math.round(this.drone.pathLength * 10) / 10,
      minSeparation: Math.round(this.minSep * 100) / 100,
      // where the bird got closest to the drone (the real threat point)
      closest: this.closest,
      endNode: W.nearestVisibleNode(this.drone.pos, 0.1),
      endPos: this.drone.pos.map((x) => Math.round(x * 100) / 100),
      capture: outcome === OUTCOME.INTERCEPTED ? this.drone.pos.map((x) => Math.round(x * 100) / 100) : null,
      reward: outcome === OUTCOME.REACHED ? 1 : outcome === OUTCOME.TIMEOUT ? 0 : -1,
      routePlanned: this.dp.route,
      routeFinal: this.drone.route,
      events: this.events,
    };
  }

  run() {
    while (!this.done) this.tick();
    return this.result;
  }

  tick() {
    if (this.done) return;
    const dt = this.P.dt;
    this.stepDrone(dt);
    if (!this.done) this.stepBird(dt);
    this.t += dt;
    this.step++;
    const sep = v.dist(this.drone.pos, this.bird.pos);
    if (sep < this.minSep) {
      this.minSep = sep;
      const r2 = (p) => p.map((x) => Math.round(x * 100) / 100);
      this.closest = { t: Math.round(this.t * 100) / 100, drone: r2(this.drone.pos), bird: r2(this.bird.pos) };
    }
    if (!this.done && sep < this.P.catchDistance) {
      this.finish(OUTCOME.INTERCEPTED, `near ${this.world.nearestVisibleNode(this.drone.pos, 0.1)}`);
    }
    if (!this.done && this.t >= this.P.maxTime) this.finish(OUTCOME.TIMEOUT);
    if (!this.done && this.step % this.recordEvery === 0) this.record();
  }

  stepDrone(dt) {
    const W = this.world;
    const P = this.P;
    const d = this.drone;
    const p = this.dp;
    const N = W.nodes;
    const r = P.droneRadius;
    const last = () => d.route.length - 1;

    if (this.t < this.hold) {
      d.vel = [0, 0, 0];
      return;
    }

    // Skip ahead along the route when the next waypoint is already in view.
    if (this.step % 4 === 0) {
      while (d.idx < last() && W.segmentClear(d.pos, N[d.route[d.idx + 1]], r + 0.45)) d.idx++;
    }
    while (d.idx < last() && v.dist(d.pos, N[d.route[d.idx]]) < 0.8) d.idx++;

    const target = N[d.route[d.idx]];
    const dist = v.dist(d.pos, target);
    if (d.idx === last() && dist < W.map.goalRadius) {
      this.finish(OUTCOME.REACHED);
      return;
    }

    // Speed planning: brake toward the speed the next corner allows.
    const toT = v.norm(v.sub(target, d.pos));
    let vCorner = 0.6;
    if (d.idx < last()) {
      const after = v.norm(v.sub(N[d.route[d.idx + 1]], target));
      const sharp = (1 - v.dot(toT, after)) / 2;
      vCorner = p.cruise_speed * (1 - p.corner_slowdown * Math.min(1, sharp * 1.6));
    }
    const aBrake = P.droneMaxAccel * 0.7;
    const speed = Math.min(p.cruise_speed, Math.sqrt(vCorner * vCorner + 2 * aBrake * Math.max(0, dist - 0.8)));
    let desired = v.scale(toT, speed);

    // Reaction to the bird.
    const bd = v.dist(d.pos, this.bird.pos);
    const reacting = p.avoidance_distance > 0 && bd < p.avoidance_distance;
    if (reacting && !d.evading) this.log("drone_evade", `bird at ${bd.toFixed(1)} m`);
    d.evading = reacting;
    d.replanCooldown -= dt;
    if (reacting) {
      if (p.evade_strength > 0) {
        const away = v.norm(v.sub(d.pos, this.bird.pos));
        const w = p.evade_strength * (1 - bd / p.avoidance_distance);
        const evaded = v.clampLen(v.add(desired, v.scale(away, w * P.droneMaxSpeed)), P.droneMaxSpeed);
        // Only dodge if the dodge itself doesn't fly into a wall.
        if (W.segmentClear(d.pos, v.add(d.pos, v.scale(evaded, 0.35)), r)) desired = evaded;
      }
      if (p.replan_when_bird_nearby && d.replanCooldown <= 0) {
        d.replanCooldown = 1.5;
        const bp = this.bird.pos;
        const penalty = (id) => 40 * Math.max(0, 1 - v.dist(N[id], bp) / 9);
        const here = W.nearestVisibleNode(d.pos, r);
        const np = W.path(here, this.goal, penalty);
        const remaining = d.route.slice(d.idx);
        if (np && np.join() !== remaining.join() && np.slice(1).join() !== remaining.join()) {
          d.route = np;
          d.idx = 0;
          this.log("drone_replan", np.join(" → "));
        }
      }
    }

    // Wind gusts (Ornstein-Uhlenbeck), weaker vertically.
    const tau = 1.5;
    const s = P.gust * Math.sqrt((2 * dt) / tau);
    d.gust = [
      d.gust[0] - (d.gust[0] / tau) * dt + s * this.R.normal(),
      d.gust[1] - (d.gust[1] / tau) * dt + 0.4 * s * this.R.normal(),
      d.gust[2] - (d.gust[2] / tau) * dt + s * this.R.normal(),
    ];

    const acc = v.clampLen(v.scale(v.sub(desired, d.vel), 1 / 0.25), P.droneMaxAccel);
    d.vel = v.clampLen(v.add(d.vel, v.scale(v.add(acc, d.gust), dt)), P.droneMaxSpeed);
    const np = v.add(d.pos, v.scale(d.vel, dt));
    d.pathLength += v.dist(np, d.pos);
    d.pos = np;

    const hit = W.sphereHits(d.pos, r);
    if (hit) this.finish(OUTCOME.CRASHED, hit.id);
  }

  birdNavTarget(aim) {
    const W = this.world;
    const b = this.bird;
    const r = this.P.birdRadius;
    if (W.segmentClear(b.pos, aim, r)) return aim;
    const from = W.nearestVisibleNode(b.pos, r);
    const to = W.nearestVisibleNode(aim, r);
    const path = W.path(from, to) || [from];
    // Furthest waypoint along the path that is directly reachable.
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
      const lead = bp.strategy === "pursue" ? 0 : bp.lead_time;
      aim = v.add(d.pos, v.scale(d.vel, lead));
      const { min, max } = W.bounds;
      aim = aim.map((x, i) => Math.min(max[i] - 0.5, Math.max(min[i] + 0.5, x)));
      if (b.chase > P.birdStamina) {
        b.state = "return";
        b.chase = 0;
        this.log("bird_tired", `returning to ${b.home}`);
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
      if (b.rest <= 0) {
        b.state = bp.strategy === "ambush" ? "wait" : bp.strategy === "patrol" ? "patrol" : "hunt";
        if (b.state === "hunt") this.log("bird_hunt", "rested");
      }
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
        this.log("bird_hunt", `drone spotted at ${dd.toFixed(1)} m`);
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
}

export function runTrials(world, scenario, dronePolicy, seeds) {
  return seeds.map((seed) => new Episode(world, scenario, dronePolicy, seed).run());
}

export function summarize(results) {
  const n = results.length;
  const count = (o) => results.filter((r) => r.outcome === o).length;
  const reached = results.filter((r) => r.outcome === OUTCOME.REACHED);
  return {
    trials: n,
    reached: count(OUTCOME.REACHED),
    intercepted: count(OUTCOME.INTERCEPTED),
    crashed: count(OUTCOME.CRASHED),
    timeout: count(OUTCOME.TIMEOUT),
    successRate: n ? count(OUTCOME.REACHED) / n : 0,
    meanTimeReached: reached.length ? Math.round((reached.reduce((s, r) => s + r.time, 0) / reached.length) * 10) / 10 : null,
    minSeparation: Math.round(Math.min(...results.map((r) => r.minSeparation)) * 100) / 100,
    meanReward: n ? Math.round((results.reduce((s, r) => s + r.reward, 0) / n) * 100) / 100 : 0,
    collisionRate: n ? (count(OUTCOME.INTERCEPTED) + count(OUTCOME.CRASHED)) / n : 0,
    meanPathLength: reached.length ? Math.round((reached.reduce((s, r) => s + r.pathLength, 0) / reached.length) * 10) / 10 : null,
  };
}
