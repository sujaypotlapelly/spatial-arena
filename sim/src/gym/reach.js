// Reach: fly from A to B through the factory scan. The control ladder
// (docs/CONTROL_LADDER.md) runs on this one task:
//   C1  pick the next waypoint; our A* plans the path there   (today's harness; sees the map, P0)
//   C2  give a free-space target point [x,y,z]; it flies straight there (senses only, P1)
//   C3  give a world-frame velocity [vx,vy,vz]                           (senses only, P1)
//   C4  give body-frame commands: turn, forward speed, climb             (senses only, egocentric P1)
// At C2-C4 nothing in the loop knows how to get from A to B except the model.

import { v, routeMenu } from "../world.js";
import { rng } from "../engine.js";
import { FreeDrone, clearance, lineOfSight, r1, r2, clamp } from "./core.js";
import { lidarScan } from "./rescue_tasks.js";

export const LEVELS = ["C1", "C2", "C3", "C4"];
export const TIME_LIMIT = 90;
export const GOAL_RADIUS = 1.0;
const DEG = Math.PI / 180;

// ---------- scenario sets ----------
// Start/goal waypoint pairs 15-35 m apart with no straight line of sight and
// a graph detour of at least 15% (so a straight line doesn't work). Disjoint
// train / dev / held-out / test sets, deterministic.
// The defaults are the factory benchmark's; other maps may pass a distance
// band suited to their size (sim/scenes/benchmark-sets.json). Changing the
// defaults would change the factory sets.
export function makeReachSets(world, { train = 12, dev = 24, heldout = 24, test = 48, seed = 20261114, minDist = 15, maxDist = 35, minDetour = 1.15, idPrefix = "", windOffset = 0 } = {}) {
  const ids = world.nodeIds;
  const cands = [];
  for (const a of ids)
    for (const b of ids) {
      if (a === b) continue;
      const d = v.dist(world.nodes[a], world.nodes[b]);
      if (d < minDist || d > maxDist) continue;
      if (world.segmentClear(world.nodes[a], world.nodes[b], 0.25)) continue;
      const p = world.path(a, b);
      if (!p) continue;
      const L = world.routeLength(p);
      if (L / d < minDetour) continue;
      cands.push({ start: a, goal: b, straight_m: Math.round(d * 10) / 10, graph_m: Math.round(L * 10) / 10 });
    }
  const R = rng(seed);
  for (let i = cands.length - 1; i > 0; i--) {
    const j = Math.floor(R.next() * (i + 1));
    [cands[i], cands[j]] = [cands[j], cands[i]];
  }
  // No reversed duplicates across sets.
  const used = new Set();
  const take = (n, prefix, seedBase) => {
    const out = [];
    for (const c of cands) {
      if (out.length >= n) break;
      const key = [c.start, c.goal].sort().join("|");
      if (used.has(key)) continue;
      used.add(key);
      const base = seedBase + windOffset + out.length * 10;
      out.push({ id: `${idPrefix}${prefix}${out.length + 1}`, ...c, seeds: [base + 1, base + 2] });
    }
    return out;
  };
  // "test" (added 2026-11-15, methodology v3) is taken after the other three, so
  // they are unchanged. It is evaluated once, under docs/PREREGISTRATION_V3.md.
  const out = { train: take(train, "T", 810000), dev: take(dev, "D", 820000), heldout: take(heldout, "H", 830000) };
  return { ...out, test: take(test, "X", 840000), nCandidates: cands.length };
}

// ---------- environment ----------
export class Reach {
  // opts.sensors: "basic" (default) or "lidar" (v5 harness option; adds obs.scan
  // at C3 only, see lidarScan in rescue_tasks.js). The default keeps every
  // earlier recording identical.
  constructor(world, scenario, seed, level, opts = {}) {
    if (!LEVELS.includes(level)) throw new Error(`unknown level ${level}`);
    this.sensors = opts.sensors ?? "basic";
    this.world = world;
    this.P = world.physics;
    this.sc = scenario;
    this.level = level;
    this.goalPos = world.nodes[scenario.goal];
    this.drone = new FreeDrone(world, world.nodes[scenario.start], seed);
    this.heading = Math.atan2(this.goalPos[2] - this.drone.pos[2], this.goalPos[0] - this.drone.pos[0]) || 0; // C4 starts facing the goal's direction
    this.t = 0;
    this.step = 0;
    this.done = false;
    this.outcome = null;
    this.route = null; // C1 only
    this.frames = [];
    this.minGoalDist = v.dist(this.drone.pos, this.goalPos);
    this.record();
  }

  record() {
    const d = this.drone;
    this.frames.push([Math.round(this.t * 100) / 100, ...r2(d.pos), Math.round(this.heading * 1000) / 1000]);
  }

  // ---------- perception ----------
  goalInfo() {
    const d = this.drone;
    const to = v.sub(this.goalPos, d.pos);
    return { position: r1(this.goalPos), distance_m: Math.round(v.len(to) * 10) / 10, in_line_of_sight: lineOfSight(this.world, d.pos, this.goalPos, 40) };
  }

  observe() {
    const d = this.drone;
    const base = { time_s: Math.round(this.t * 10) / 10, time_left_s: Math.round((TIME_LIMIT - this.t) * 10) / 10, wall_contacts_so_far: d.contacts.length };
    if (this.level === "C1") {
      // P0: today's harness (the map, with coordinates).
      return { ...base, position: r1(d.pos), nearest_waypoint: this.world.nearestVisibleNode(d.pos, this.P.droneRadius), goal: { waypoint: this.sc.goal, ...this.goalInfo() } };
    }
    if (this.level === "C4") {
      // Egocentric: bearings relative to the drone's own heading.
      const to = v.sub(this.goalPos, d.pos);
      let rel = (Math.atan2(to[2], to[0]) - this.heading) / DEG;
      rel = ((rel + 540) % 360) - 180; // (-180, 180], positive = to the LEFT (counter-clockwise seen from above)
      const body = clearance(this.world, d.pos, this.P.droneRadius, 12, 0.25, bodyDirs(this.heading));
      const fwd = d.vel[0] * Math.cos(this.heading) + d.vel[2] * Math.sin(this.heading);
      return {
        ...base,
        speed_forward_mps: Math.round(fwd * 10) / 10,
        climb_rate_mps: Math.round(d.vel[1] * 10) / 10,
        goal: { bearing_deg: Math.round(rel), bearing_note: "0 = straight ahead, positive = to your left, negative = to your right", distance_m: Math.round(v.len(to) * 10) / 10, height_difference_m: Math.round(to[1] * 10) / 10, in_line_of_sight: lineOfSight(this.world, d.pos, this.goalPos, 40) },
        free_space_m: body,
      };
    }
    // P1, world frame (C2, C3).
    const o = { ...base, position: r1(d.pos), velocity: r1(d.vel), goal: this.goalInfo(), free_space_m: clearance(this.world, d.pos, this.P.droneRadius) };
    if (this.sensors === "lidar" && this.level === "C3") o.scan = lidarScan(this.world, d.pos);
    return o;
  }

  // ---------- action ----------
  apply(raw = {}) {
    const W = this.world;
    const d = this.drone;
    const max = this.P.droneMaxSpeed;
    if (this.level === "C1") {
      const via = typeof raw.waypoint === "string" && W.nodes[raw.waypoint] ? raw.waypoint : this.sc.goal;
      const speed = Math.round(clamp(Number(raw.speed) || 4, 0.3, max) * 10) / 10;
      if (!this.route || this.routeVia !== via) {
        const here = W.nearestVisibleNode(d.pos, this.P.droneRadius);
        const a = W.path(here, via) || [here];
        const b = via === this.sc.goal ? [via] : W.path(via, this.sc.goal) || [via];
        this.route = [...a, ...b.slice(1)];
        this.routeIdx = 0;
        this.routeVia = via;
      }
      this.c1Speed = speed;
      return { waypoint: via, speed };
    }
    if (this.level === "C2") return d.command({ target: raw.target, speed: raw.speed });
    if (this.level === "C3") {
      const vel = Array.isArray(raw.velocity) && raw.velocity.length === 3 && raw.velocity.every((x) => Number.isFinite(Number(x))) ? raw.velocity.map(Number) : [0, 0, 0];
      // Idempotent: a recorded command re-applied on replay must come out identical.
      // Scale to 1 cm/s under the cap before rounding: rounding moves the
      // length by at most 0.009, so the result is under the cap and a no-op
      // to re-apply.
      // Keep the rounded command if it is within the cap; only otherwise
      // scale it to 1 cm/s under the cap. Either way the output is rounded
      // and within the cap, so it maps to itself (idempotent by construction).
      let c = r2(vel);
      if (v.len(c) > max) c = r2(v.scale(vel, (max - 0.01) / v.len(vel)));
      d.setVelocity(c);
      return { velocity: c };
    }
    // C4: turn (degrees, + = left), then fly forward and climb at the given rates.
    const turn = Math.round(clamp(Number(raw.turn_deg) || 0, -180, 180));
    const fwd = Math.round(clamp(Number(raw.forward_mps) || 0, -2, max) * 10) / 10;
    const climb = Math.round(clamp(Number(raw.climb_mps) || 0, -2, 2) * 10) / 10;
    this.heading += turn * DEG;
    d.setVelocity([fwd * Math.cos(this.heading), climb, fwd * Math.sin(this.heading)]);
    return { turn_deg: turn, forward_mps: fwd, climb_mps: climb };
  }

  tick(dt) {
    if (this.done) return;
    const W = this.world;
    const d = this.drone;
    if (this.level === "C1" && this.route) {
      // Pure pursuit along the A* route: the furthest route node in view.
      const r = this.P.droneRadius;
      if (this.step % 4 === 0) while (this.routeIdx < this.route.length - 1 && W.segmentClear(d.pos, W.nodes[this.route[this.routeIdx + 1]], r + 0.3)) this.routeIdx++;
      while (this.routeIdx < this.route.length - 1 && v.dist(d.pos, W.nodes[this.route[this.routeIdx]]) < 0.8) this.routeIdx++;
      d.target = W.nodes[this.route[this.routeIdx]];
      d.speed = this.c1Speed;
      d.desiredVel = null;
    }
    d.step(dt, this.t);
    this.t += dt;
    this.step++;
    const gd = v.dist(d.pos, this.goalPos);
    this.minGoalDist = Math.min(this.minGoalDist, gd);
    if (gd < GOAL_RADIUS) this.finish("reached");
    else if (this.t >= TIME_LIMIT) this.finish("timeout");
    if (this.step % 6 === 0 || this.done) this.record();
  }

  finish(outcome) {
    this.done = true;
    this.outcome = outcome;
  }

  result() {
    const d = this.drone;
    return {
      outcome: this.outcome,
      time: Math.round(this.t * 100) / 100,
      contacts: d.contacts.length,
      pathLength: Math.round(d.pathLength * 10) / 10,
      minGoalDist: Math.round(this.minGoalDist * 10) / 10,
      endPos: r2(d.pos),
    };
  }
}

// Ray directions in the drone's body frame (heading measured from +x toward +z).
export function bodyDirs(heading) {
  const body = { ahead: 0, ahead_left: 45, left: 90, behind_left: 135, behind: 180, behind_right: -135, right: -90, ahead_right: -45 };
  const out = {};
  for (const [name, rel] of Object.entries(body)) {
    const a = heading + rel * DEG;
    out[name] = [Math.cos(a), 0, Math.sin(a)];
  }
  out.up = [0, 1, 0];
  out.down = [0, -1, 0];
  return out;
}
