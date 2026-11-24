// Closed-loop matches (methodology v2). The drone and the bird are both
// controllers that re-decide every DECISION_DT seconds of sim time from what
// they can see. Sim time is paused while they decide, both decide at the
// same instant (neither sees the other's current command), and every command
// is recorded so a match replays bit-for-bit.
//
// Physics, wind, collisions and the catch rule are the v1 Episode's. The
// drone's "autopilot" flies the commanded waypoint path with wall-aware
// shortcuts only: v1's bird-avoidance reflex and automatic re-routing are
// off, so every evasive move is a controller decision.

import { v } from "./world.js";
import { Episode } from "./engine.js";

export const DECISION_DT = 1.0;
export const SIGHT_RANGE = 30; // metres, and only with a clear line of sight
const r2 = (p) => p.map((x) => Math.round(x * 100) / 100);
const r1 = (p) => p.map((x) => Math.round(x * 10) / 10);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export class Duel extends Episode {
  // scenario: v1 scenario ({ id, start, goal, bird: {...} }). birdMode:
  // "script" flies scenario.bird with the v1 behaviors; "command" flies
  // whatever the bird controller commands.
  constructor(world, scenario, seed, { birdMode = "script", recordEvery = 6 } = {}) {
    const start = scenario.start || world.map.start;
    const goal = scenario.goal || world.map.goal;
    const route = world.path(start, goal);
    super(world, { ...scenario, hold: 0 }, { route, cruise_speed: 0, corner_slowdown: 0.5, avoidance_distance: 0, evade_strength: 0, replan_when_bird_nearby: false }, seed, { recordEvery });
    this.birdMode = birdMode;
    this.drone.holding = true; // until the first command arrives
    this.bird.energy = this.P.birdStamina;
    this.bird.cmd = { mode: "wait" };
    this.seen = { byDrone: null, byBird: null }; // last sighting of the other agent
    this.updateSight(true);
  }

  // ---------- perception ----------
  visible(a, b) {
    return v.dist(a, b) <= SIGHT_RANGE && this.world.segmentClear(a, b, 0.05);
  }

  updateSight(force = false) {
    if (!force && this.step % 6 !== 0) return;
    if (this.visible(this.drone.pos, this.bird.pos)) {
      const t = Math.round(this.t * 100) / 100;
      this.seen.byDrone = { pos: r2(this.bird.pos), vel: r2(this.bird.vel), t };
      this.seen.byBird = { pos: r2(this.drone.pos), vel: r2(this.drone.vel), t };
    }
  }

  tick() {
    super.tick();
    if (!this.done) this.updateSight();
  }

  sighting(s) {
    if (!s) return { status: "not seen yet" };
    const ago = Math.round((this.t - s.t) * 10) / 10;
    return ago < 0.15 ? { status: "in view now", position: r1(s.pos), velocity: r1(s.vel) } : { status: `out of view; last seen ${ago} s ago`, last_position: r1(s.pos), last_velocity: r1(s.vel) };
  }

  droneObservation() {
    const W = this.world;
    return {
      time_s: Math.round(this.t * 10) / 10,
      drone: { position: r1(this.drone.pos), velocity: r1(this.drone.vel), nearest_waypoint: W.nearestVisibleNode(this.drone.pos, this.P.droneRadius) },
      goal: { waypoint: this.goal, position: r1(W.nodes[this.goal]), distance_m: Math.round(v.dist(this.drone.pos, W.nodes[this.goal]) * 10) / 10 },
      bird: this.sighting(this.seen.byDrone),
    };
  }

  birdObservation() {
    const W = this.world;
    const b = this.bird;
    return {
      time_s: Math.round(this.t * 10) / 10,
      bird: { position: r1(b.pos), velocity: r1(b.vel), nearest_waypoint: W.nearestVisibleNode(b.pos, this.P.birdRadius), sprint_energy_s: Math.round(b.energy * 10) / 10, resting: b.state === "rest" ? `${Math.round(b.rest * 10) / 10} s left` : false },
      drone: this.sighting(this.seen.byBird),
      drone_goal: { waypoint: this.goal, position: r1(W.nodes[this.goal]) },
    };
  }

  // ---------- commands ----------
  // Drone: { via: waypoint id, speed: m/s, hold: bool }. The autopilot flies
  // the shortest graph path here -> via -> goal.
  sanitizeDrone(cmd = {}) {
    const W = this.world;
    const via = typeof cmd.via === "string" && W.nodes[cmd.via] ? cmd.via : this.goal;
    return { via, speed: Math.round(clamp(Number(cmd.speed) || this.P.droneMaxSpeed, 0.5, this.P.droneMaxSpeed) * 10) / 10, hold: cmd.hold === true };
  }

  applyDrone(raw) {
    const cmd = this.sanitizeDrone(raw);
    const W = this.world;
    const d = this.drone;
    const prev = this.droneCmd;
    this.droneCmd = cmd;
    d.holding = cmd.hold;
    if (cmd.hold) return cmd;
    this.dp = { ...this.dp, cruise_speed: cmd.speed };
    // Same route as before (only speed changed, or a repeat): keep flying it.
    // Re-planning from scratch every second would turn the drone back toward
    // whatever waypoint happens to be nearest, penalising any controller
    // that re-issues commands.
    if (prev && !prev.hold && prev.via === cmd.via) return cmd;
    // Plan from whichever reachable entry waypoint gives the shortest total
    // trip to "via": the waypoint it is already flying toward (if still in
    // view) or the nearest visible one. No forced U-turns.
    const r = this.P.droneRadius;
    const cands = [W.nearestVisibleNode(d.pos, r)];
    const ahead = prev && !prev.hold ? d.route?.[d.idx] : null;
    if (ahead && ahead !== cands[0] && W.segmentClear(d.pos, W.nodes[ahead], r)) cands.push(ahead);
    let from = cands[0];
    let best = Infinity;
    for (const c of cands) {
      const p = W.path(c, cmd.via);
      if (!p) continue;
      const cost = v.dist(d.pos, W.nodes[c]) + W.routeLength(p);
      if (cost < best) [best, from] = [cost, c];
    }
    const a = W.path(from, cmd.via) || [from];
    const b = cmd.via === this.goal ? [cmd.via] : W.path(cmd.via, this.goal) || [cmd.via];
    d.route = [...a, ...b.slice(1)];
    d.idx = 0;
    this.dp.route = d.route;
    return cmd;
  }

  // Bird: { mode: "chase" | "goto" | "wait", target: waypoint id (goto),
  // lead_s: 0-2 (chase: aim this far ahead of the drone's last seen motion),
  // speed: m/s }.
  sanitizeBird(cmd = {}) {
    const W = this.world;
    const mode = ["chase", "goto", "wait"].includes(cmd.mode) ? cmd.mode : "wait";
    const out = { mode, speed: Math.round(clamp(Number(cmd.speed) || this.P.birdMaxSpeed, 0.5, this.P.birdMaxSpeed) * 10) / 10 };
    if (mode === "goto") out.target = typeof cmd.target === "string" && W.nodes[cmd.target] ? cmd.target : this.goal;
    if (mode === "chase") out.lead_s = Math.round(clamp(Number(cmd.lead_s) || 0, 0, 2) * 10) / 10;
    return out;
  }

  applyBird(raw) {
    const cmd = this.sanitizeBird(raw);
    this.bird.cmd = cmd;
    this.bird.target = null;
    return cmd;
  }

  // ---------- motion ----------
  // The v1 drone crashed on any wall contact, so in v1 crash rates measured
  // the controller's speed/cornering choices. Here the autopilot owns wall
  // safety for every controller alike: the drone slides along walls (as the
  // bird always has), and losses are tactical (caught or out of time).
  stepDrone(dt) {
    const W = this.world;
    const P = this.P;
    const d = this.drone;
    const N = W.nodes;
    const r = P.droneRadius;
    let desired = [0, 0, 0];
    if (!d.holding) {
      const last = d.route.length - 1;
      if (this.step % 4 === 0) while (d.idx < last && W.segmentClear(d.pos, N[d.route[d.idx + 1]], r + 0.45)) d.idx++;
      while (d.idx < last && v.dist(d.pos, N[d.route[d.idx]]) < 0.8) d.idx++;
      const target = N[d.route[d.idx]];
      const dist = v.dist(d.pos, target);
      if (d.route[d.idx] === this.goal && d.idx === last && dist < W.map.goalRadius) {
        this.finish("reached");
        return;
      }
      const toT = v.norm(v.sub(target, d.pos));
      let vCorner = 0.6;
      if (d.idx < last) {
        const after = v.norm(v.sub(N[d.route[d.idx + 1]], target));
        const sharp = (1 - v.dot(toT, after)) / 2;
        vCorner = this.dp.cruise_speed * (1 - 0.7 * Math.min(1, sharp * 1.6));
      }
      const speed = Math.min(this.dp.cruise_speed, Math.sqrt(vCorner * vCorner + 2 * P.droneMaxAccel * 0.7 * Math.max(0, dist - 0.8)));
      desired = v.scale(toT, speed);
    }
    const tau = 1.5;
    const s = P.gust * Math.sqrt((2 * dt) / tau);
    d.gust = [d.gust[0] - (d.gust[0] / tau) * dt + s * this.R.normal(), d.gust[1] - (d.gust[1] / tau) * dt + 0.4 * s * this.R.normal(), d.gust[2] - (d.gust[2] / tau) * dt + s * this.R.normal()];
    const acc = v.clampLen(v.scale(v.sub(desired, d.vel), 1 / 0.25), P.droneMaxAccel);
    d.vel = v.clampLen(v.add(d.vel, v.scale(v.add(acc, d.gust), dt)), P.droneMaxSpeed);
    const np = W.moveSphere(d.pos, v.add(d.pos, v.scale(d.vel, dt)), r);
    d.vel = v.scale(v.sub(np, d.pos), 1 / dt);
    d.pathLength += v.dist(np, d.pos);
    d.pos = np;
  }

  stepBird(dt) {
    if (this.birdMode === "script") return super.stepBird(dt);
    const P = this.P;
    const W = this.world;
    const b = this.bird;
    const c = b.cmd;
    let speed = c.speed;
    let aim = null;

    if (b.state === "rest") {
      b.rest -= dt;
      speed = 0;
      if (b.rest <= 0) {
        b.state = "active";
        b.energy = P.birdStamina;
      }
    } else {
      b.state = "active";
      if (c.mode === "chase") {
        const s = this.seen.byBird;
        aim = s ? v.add(s.pos, v.scale(s.vel, c.lead_s || 0)) : W.nodes[this.goal];
        const { min, max } = W.bounds;
        aim = aim.map((x, i) => Math.min(max[i] - 0.5, Math.max(min[i] + 0.5, x)));
      } else if (c.mode === "goto") aim = W.nodes[c.target];
      // Sprinting (above 60% of top speed) drains energy; empty = forced rest.
      if (speed > 0.6 * P.birdMaxSpeed && aim) b.energy -= dt;
      else b.energy = Math.min(P.birdStamina, b.energy + 0.5 * dt);
      if (b.energy <= 0) {
        b.state = "rest";
        b.rest = P.birdRest;
        this.log("bird_tired", "forced rest");
      }
    }

    let desired = [0, 0, 0];
    if (aim && b.state !== "rest") {
      b.retarget -= dt;
      if (b.retarget <= 0 || !b.target) {
        b.target = this.birdNavTarget(aim);
        b.retarget = 0.2;
      }
      const to = v.sub(b.target, b.pos);
      const dist = v.len(to);
      const s = c.mode === "chase" ? speed : Math.min(speed, dist * 1.5);
      desired = v.scale(v.norm(to), s);
    }
    const acc = v.clampLen(v.scale(v.sub(desired, b.vel), 1 / 0.3), P.birdMaxAccel);
    b.vel = v.clampLen(v.add(b.vel, v.scale(acc, dt)), P.birdMaxSpeed);
    const np = W.moveSphere(b.pos, v.add(b.pos, v.scale(b.vel, dt)), P.birdRadius);
    b.vel = v.scale(v.sub(np, b.pos), 1 / dt);
    b.pos = np;
  }
}

// Play one match. drone / bird are async controllers:
//   (observation, duel) => { command, ...anything to record }
// bird = null flies the scenario's scripted bird. Returns the outcome, every
// decision (sanitized commands plus whatever the controller recorded), and
// 10 Hz frames.
export async function playMatch(world, scenario, seed, { drone, bird = null, dt = DECISION_DT } = {}) {
  const m = new Duel(world, scenario, seed, { birdMode: bird ? "command" : "script" });
  const stepsPer = Math.round(dt / m.P.dt);
  const decisions = [];
  while (!m.done) {
    const [dd, bd] = await Promise.all([drone(m.droneObservation(), m), bird ? bird(m.birdObservation(), m) : null]);
    const rec = { t: Math.round(m.t * 100) / 100, drone: { ...dd, command: m.applyDrone(dd.command) } };
    if (bird) rec.bird = { ...bd, command: m.applyBird(bd.command) };
    decisions.push(rec);
    for (let k = 0; k < stepsPer && !m.done; k++) m.tick();
  }
  return { result: m.result, decisions, frames: m.frames };
}

// Re-fly recorded commands; must reproduce the outcome exactly.
export function replayMatch(world, scenario, seed, decisions, { dt = DECISION_DT, birdMode } = {}) {
  const hasBird = birdMode ? birdMode === "command" : decisions.some((d) => d.bird);
  const m = new Duel(world, scenario, seed, { birdMode: hasBird ? "command" : "script" });
  const stepsPer = Math.round(dt / m.P.dt);
  for (const d of decisions) {
    if (m.done) break;
    m.applyDrone(d.drone.command);
    if (hasBird) m.applyBird(d.bird.command);
    for (let k = 0; k < stepsPer && !m.done; k++) m.tick();
  }
  return m.result;
}
