// Opt-in perturbations for Reach: real wind and noisy senses.
//
// core.js and reach.js are hashed into the harness (HARNESS_FILES in
// sim/tools/reach_metrics.mjs), so this file adds subclasses instead of
// changing them. With no wind and no noise, PerturbedReach is never used:
// the evaluator builds the plain Reach, and every published flight re-flies
// unchanged.
//
// Wind. FreeDrone already has gusts: an Ornstein-Uhlenbeck acceleration with
// a standard deviation of physics.gust (0.8 m/s^2) and a 1.5 s correlation
// time, against a velocity loop with a 0.25 s time constant. That moves the
// drone about 0.2 m/s off its command (sim/tools/study/integrity_wind.mjs
// measures it). WindyDrone adds
//   - a steady wind: a constant horizontal acceleration of `steady` m/s^2
//     from a direction drawn once per flight. The velocity loop has no
//     integral term, so it settles `steady` x 0.25 m/s downwind of the command.
//   - stronger gusts: the same gust process scaled by `gustScale`.
// The wind direction comes from its own generator, seeded from the flight's
// wind seed, so the gust draws are the same sequence as in FreeDrone. With
// steady 0 and gustScale 1 a flight is identical to FreeDrone's (tested).
//
// Noise. observe() reports position, velocity, goal and free space exactly.
// PerturbedReach can add, per observation:
//   - position: Gaussian noise, `pos` m per axis (the goal distance is
//     recomputed from the noisy position so the two agree);
//   - velocity: Gaussian noise, `vel` m/s per axis;
//   - free space: multiplicative range noise (`range`, a fraction), and with
//     probability `dropout` a direction reports no return (the 12 m maximum),
//     the way a real range sensor fails.
// The noise generator is seeded from the wind seed but separate from it, so
// noise never changes the physics; a flight is replayable from its commands.

import { v } from "../world.js";
import { rng } from "../engine.js";
import { FreeDrone, clamp, r1 } from "./core.js";
import { Reach } from "./reach.js";

// Named levels used by reach_eval.mjs --wind / --noise.
export const WIND_LEVELS = {
  none: null,
  light: { steady: 1.5, gustScale: 2 },
  moderate: { steady: 3, gustScale: 3 },
  strong: { steady: 4.5, gustScale: 4 },
};
export const NOISE_LEVELS = {
  none: null,
  low: { pos: 0.1, vel: 0.1, range: 0.05, dropout: 0.02 },
  medium: { pos: 0.3, vel: 0.2, range: 0.1, dropout: 0.05 },
  high: { pos: 0.6, vel: 0.4, range: 0.2, dropout: 0.1 },
  severe: { pos: 1.0, vel: 0.6, range: 0.3, dropout: 0.2 },
};
export const resolveLevel = (table, name, flag) => {
  if (!(name in table)) throw new Error(`${flag} must be one of ${Object.keys(table).join(", ")}, not ${name}`);
  return table[name];
};

// Seeds derived from the flight's wind seed; distinct streams by construction.
const subSeed = (seed, salt) => ((seed >>> 0) ^ salt) >>> 0;
const WIND_SALT = 0x57494e44; // "WIND"
const NOISE_SALT = 0x4e4f4953; // "NOIS"

export class WindyDrone extends FreeDrone {
  constructor(world, pos, seed, { steady = 0, gustScale = 1 } = {}) {
    super(world, pos, seed);
    const a = rng(subSeed(seed, WIND_SALT)).next() * 2 * Math.PI;
    this.windDir = [Math.cos(a), 0, Math.sin(a)];
    this.windAcc = v.scale(this.windDir, steady);
    this.gustScale = gustScale;
  }

  // FreeDrone.step with the gust scaled and the steady wind added. Kept in
  // the same order of operations so that steady 0, gustScale 1 is exact.
  step(dt, t) {
    const P = this.P;
    let desired = [0, 0, 0];
    if (this.desiredVel && !this.target) desired = this.desiredVel;
    else if (this.target) {
      const to = v.sub(this.target, this.pos);
      const d = v.len(to);
      const s = Math.min(this.speed, Math.sqrt(2 * P.droneMaxAccel * 0.7 * Math.max(0, d - 0.1)));
      if (d > 0.05) desired = v.scale(v.norm(to), s);
    }
    const tau = 1.5;
    const sg = P.gust * this.gustScale * Math.sqrt((2 * dt) / tau);
    this.gust = [this.gust[0] - (this.gust[0] / tau) * dt + sg * this.R.normal(), this.gust[1] - (this.gust[1] / tau) * dt + 0.4 * sg * this.R.normal(), this.gust[2] - (this.gust[2] / tau) * dt + sg * this.R.normal()];
    const acc = v.clampLen(v.scale(v.sub(desired, this.vel), 1 / 0.25), P.droneMaxAccel);
    const push = v.add(this.gust, this.windAcc);
    this.vel = v.clampLen(v.add(this.vel, v.scale(v.add(acc, push), dt)), P.droneMaxSpeed);
    const want = v.add(this.pos, v.scale(this.vel, dt));
    const np = this.W.moveSphere(this.pos, want, P.droneRadius);
    const blocked = v.dist(np, want) > 1e-6;
    if (blocked && !this.touching) this.contacts.push({ t: Math.round(t * 100) / 100, at: r1(np) });
    this.touching = blocked;
    this.vel = v.scale(v.sub(np, this.pos), 1 / dt);
    this.pathLength += v.dist(np, this.pos);
    this.pos = np;
  }
}

const rnd1 = (x) => Math.round(x * 10) / 10;

export class PerturbedReach extends Reach {
  // opts: everything Reach takes, plus
  //   wind:  null or { steady, gustScale }
  //   noise: null or { pos, vel, range, dropout }
  constructor(world, scenario, seed, level, opts = {}) {
    super(world, scenario, seed, level, opts);
    this.wind = opts.wind ?? null;
    this.noise = opts.noise ?? null;
    if (this.wind) {
      // Same start, same seed: only the physics of the push changes.
      this.drone = new WindyDrone(world, world.nodes[scenario.start], seed, this.wind);
    }
    this.noiseR = rng(subSeed(seed, NOISE_SALT));
  }

  observe() {
    const o = super.observe();
    const N = this.noise;
    if (!N) return o;
    const R = this.noiseR;
    const g = (s) => (s > 0 ? s * R.normal() : 0);
    if (o.position) {
      o.position = o.position.map((x) => rnd1(x + g(N.pos)));
      if (o.goal?.position) o.goal.distance_m = rnd1(v.dist(o.position, o.goal.position));
    }
    if (o.velocity) o.velocity = o.velocity.map((x) => rnd1(x + g(N.vel)));
    if (o.speed_forward_mps !== undefined) o.speed_forward_mps = rnd1(o.speed_forward_mps + g(N.vel));
    if (o.climb_rate_mps !== undefined) o.climb_rate_mps = rnd1(o.climb_rate_mps + g(N.vel));
    if (o.free_space_m) {
      const fs = {};
      for (const [k, d] of Object.entries(o.free_space_m)) {
        // Draw both numbers every time, so the stream does not depend on outcomes.
        const drop = R.next() < (N.dropout || 0);
        const n = g(N.range);
        fs[k] = drop ? 12 : rnd1(clamp(d * (1 + n), 0, 12));
      }
      o.free_space_m = fs;
    }
    return o;
  }
}

// What reach_eval builds: the plain Reach unless a perturbation is asked for,
// so default runs use exactly the published code path.
export function makeReachEnv(world, scenario, seed, level, opts = {}) {
  return opts.wind || opts.noise ? new PerturbedReach(world, scenario, seed, level, opts) : new Reach(world, scenario, seed, level, opts);
}
