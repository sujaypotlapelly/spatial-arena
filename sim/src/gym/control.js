// Pluggable control levels for gym environments.
// One adapter turns a raw command into drone motion at any level, so an
// environment (Gate Run, Fog Search) doesn't commit to one:
//   C1  pick the next waypoint (or an env-defined target such as "gate"); A* on the graph flies there
//   C2  a free-space target point [x, y, z]; the drone flies straight at it
//   C3  a world-frame velocity [vx, vy, vz]
//   C4  body-frame commands: turn_deg (+ = left), forward_mps, climb_mps
// The sanitizing rules match Reach.apply exactly (sim/src/gym/reach.js), so a
// recorded command re-applied on replay maps to itself (exact replay).

import { v } from "../world.js";
import { clamp } from "./core.js";

export const CONTROL_LEVELS = ["C1", "C2", "C3", "C4"];
const DEG = Math.PI / 180;

export class Control {
  // opts.resolveVia(via) -> { node, tail: [[x,y,z], ...] } | null lets the env
  // define extra C1 targets (e.g. "gate": route to the node nearest the next
  // gate, then fly the tail points through it). opts.defaultVia is used when
  // the command names nothing valid. opts.heading is the C4 start heading.
  constructor(world, drone, level, { heading = 0, resolveVia = null, defaultVia = null } = {}) {
    if (!CONTROL_LEVELS.includes(level)) throw new Error(`unknown level ${level}`);
    this.W = world;
    this.drone = drone;
    this.P = world.physics;
    this.level = level;
    this.heading = heading;
    this.resolveVia = resolveVia;
    this.defaultVia = defaultVia;
    this.route = null;
    this.pin = Infinity;
    this.routeVia = null;
    this.routeKey = null;
    this.c1Speed = 4;
    this.step = 0;
  }

  validVia(via) {
    if (typeof via !== "string") return false;
    if (this.W.nodes[via]) return true;
    return !!(this.resolveVia && this.resolveVia(via));
  }

  apply(raw = {}) {
    const d = this.drone;
    const max = this.P.droneMaxSpeed;
    if (this.level === "C1") {
      const via = this.validVia(raw.waypoint) ? raw.waypoint : this.defaultVia;
      const speed = Math.round(clamp(Number(raw.speed) || 4, 0.3, max) * 10) / 10;
      const res = this.W.nodes[via] ? { node: via, tail: [] } : this.resolveVia ? this.resolveVia(via) : null;
      const key = res ? `${via}|${JSON.stringify(res.tail)}` : null;
      if (res && (!this.route || this.routeKey !== key)) {
        const here = this.W.nearestVisibleNode(d.pos, this.P.droneRadius);
        const ids = (res.node && this.W.path(here, res.node)) || [here];
        this.route = [...ids.map((id) => this.W.nodes[id]), ...res.tail];
        // Tail points are pinned: the look-ahead shortcut may advance to the
        // first one but never past it (it must actually be reached).
        this.pin = res.tail.length ? ids.length : Infinity;
        this.routeIdx = 0;
        this.routeVia = via;
        this.routeKey = key;
      }
      this.c1Speed = speed;
      return { waypoint: via, speed };
    }
    if (this.level === "C2") return d.command({ target: raw.target, speed: raw.speed });
    if (this.level === "C3") {
      const vel = Array.isArray(raw.velocity) && raw.velocity.length === 3 && raw.velocity.every((x) => Number.isFinite(Number(x))) ? raw.velocity.map(Number) : [0, 0, 0];
      let c = vel.map((x) => Math.round(x * 100) / 100 + 0);
      if (v.len(c) > max) c = v.scale(vel, (max - 0.01) / v.len(vel)).map((x) => Math.round(x * 100) / 100 + 0);
      d.setVelocity(c);
      return { velocity: c };
    }
    // "+ 0" turns a rounded -0 into 0, so re-applying a command is an exact no-op.
    const turn = Math.round(clamp(Number(raw.turn_deg) || 0, -180, 180)) + 0;
    const fwd = Math.round(clamp(Number(raw.forward_mps) || 0, -2, max) * 10) / 10 + 0;
    const climb = Math.round(clamp(Number(raw.climb_mps) || 0, -2, 2) * 10) / 10 + 0;
    this.heading += turn * DEG;
    d.setVelocity([fwd * Math.cos(this.heading), climb, fwd * Math.sin(this.heading)]);
    return { turn_deg: turn, forward_mps: fwd, climb_mps: climb };
  }

  // Call once per physics tick, before drone.step (C1 pure pursuit only).
  tick() {
    if (this.level === "C1" && this.route) {
      const W = this.W, d = this.drone, r = this.P.droneRadius;
      if (this.step % 4 === 0) while (this.routeIdx < this.route.length - 1 && this.routeIdx < this.pin && W.segmentClear(d.pos, this.route[this.routeIdx + 1], r + 0.3)) this.routeIdx++;
      while (this.routeIdx < this.route.length - 1 && v.dist(d.pos, this.route[this.routeIdx]) < 0.8) this.routeIdx++;
      d.target = this.route[this.routeIdx];
      d.speed = this.c1Speed;
      d.desiredVel = null;
    }
    this.step++;
  }

  fallback() {
    return this.level === "C3" ? { velocity: [0, 0, 0] } : this.level === "C4" ? { turn_deg: 0, forward_mps: 0, climb_mps: 0 } : this.level === "C2" ? { target: null } : { waypoint: this.defaultVia, speed: 3 };
  }
}

// Egocentric helpers shared by C4 observations.
export function relBearingDeg(heading, from, to) {
  let rel = (Math.atan2(to[2] - from[2], to[0] - from[0]) - heading) / DEG;
  return Math.round(((rel + 540) % 360) - 180); // (-180, 180], + = to the left
}

const COMPASS8 = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];
export const compassOf = (dx, dz) => COMPASS8[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8];
