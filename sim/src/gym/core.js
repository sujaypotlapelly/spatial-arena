// Shared pieces for Spatial Gym environments (docs/ENVIRONMENTS.md):
// a free-flight drone that flies to any [x, y, z] (no waypoint graph), short
// range clearance "lidar", line of sight, and the closed decision loop with
// recorded, replayable commands.

import { v } from "../world.js";
import { rng } from "../engine.js";

export const DT_DECISION = 1.0;
export const r1 = (p) => p.map((x) => Math.round(x * 10) / 10);
export const r2 = (p) => p.map((x) => Math.round(x * 100) / 100);
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Free-flight drone. The autopilot flies straight at the commanded target,
// brakes on arrival, is pushed by seeded wind, and slides along geometry
// instead of crashing. Each new touch of geometry is counted as a contact.
export class FreeDrone {
  constructor(world, pos, seed) {
    this.W = world;
    this.P = world.physics;
    this.R = rng(seed);
    this.pos = pos.slice();
    this.vel = [0, 0, 0];
    this.gust = [0, 0, 0];
    this.target = null;
    this.speed = 0;
    this.touching = false;
    this.contacts = [];
    this.pathLength = 0;
  }

  sanitize(cmd = {}) {
    const max = this.P.droneMaxSpeed;
    const t = Array.isArray(cmd.target) && cmd.target.length === 3 && cmd.target.every((x) => Number.isFinite(Number(x))) ? cmd.target.map(Number) : null;
    const { min, max: bmax } = this.W.bounds;
    return {
      // Clamp inside the bounds by 1 cm before rounding, so re-applying a
      // recorded command is a no-op (exact replay).
      target: t ? r2(t.map((x, i) => clamp(x, min[i] + 0.01, bmax[i] - 0.01))) : null,
      speed: Math.round(clamp(Number(cmd.speed) || max, 0.3, max) * 10) / 10,
    };
  }

  command(raw) {
    const c = this.sanitize(raw);
    this.target = c.target;
    this.speed = c.speed;
    this.desiredVel = null;
    return c;
  }

  // Velocity mode (control levels C3/C4): hold this world-frame velocity.
  setVelocity(vel) {
    this.target = null;
    this.desiredVel = v.clampLen(vel, this.P.droneMaxSpeed);
  }

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
    const sg = P.gust * Math.sqrt((2 * dt) / tau);
    this.gust = [this.gust[0] - (this.gust[0] / tau) * dt + sg * this.R.normal(), this.gust[1] - (this.gust[1] / tau) * dt + 0.4 * sg * this.R.normal(), this.gust[2] - (this.gust[2] / tau) * dt + sg * this.R.normal()];
    const acc = v.clampLen(v.scale(v.sub(desired, this.vel), 1 / 0.25), P.droneMaxAccel);
    this.vel = v.clampLen(v.add(this.vel, v.scale(v.add(acc, this.gust), dt)), P.droneMaxSpeed);
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

// Free distance along each direction (metres, capped). World frame:
// +x east, -x west, +z north, -z south, +y up.
const DIRS = {
  east: [1, 0, 0], north_east: [Math.SQRT1_2, 0, Math.SQRT1_2], north: [0, 0, 1], north_west: [-Math.SQRT1_2, 0, Math.SQRT1_2],
  west: [-1, 0, 0], south_west: [-Math.SQRT1_2, 0, -Math.SQRT1_2], south: [0, 0, -1], south_east: [Math.SQRT1_2, 0, -Math.SQRT1_2], up: [0, 1, 0], down: [0, -1, 0],
};
export function clearance(world, p, r = 0.25, maxRange = 12, step = 0.25, dirs = DIRS) {
  const out = {};
  for (const [name, d] of Object.entries(dirs)) {
    let s = 0;
    while (s < maxRange && !world.sphereHits(v.add(p, v.scale(d, s + step)), r)) s += step;
    out[name] = Math.round(s * 10) / 10;
  }
  return out;
}

export const lineOfSight = (world, a, b, maxRange = Infinity) => v.dist(a, b) <= maxRange && world.segmentClear(a, b, 0.05);

// Closed loop: controller(obs, env) -> { command, ...record }. The env must
// implement observe(), apply(command) -> sanitized, tick(dt), done, result().
export async function runEpisode(env, controller, { dt = DT_DECISION } = {}) {
  const decisions = [];
  const stepsPer = Math.round(dt / env.P.dt);
  while (!env.done) {
    const rec = await controller(env.observe(), env);
    decisions.push({ ...rec, t: Math.round(env.t * 100) / 100, command: env.apply(rec.command) });
    for (let k = 0; k < stepsPer && !env.done; k++) env.tick(env.P.dt);
  }
  return { result: env.result(), decisions, frames: env.frames };
}

export function replayEpisode(env, decisions, { dt = DT_DECISION } = {}) {
  const stepsPer = Math.round(dt / env.P.dt);
  for (const d of decisions) {
    if (env.done) break;
    env.apply(d.command);
    for (let k = 0; k < stepsPer && !env.done; k++) env.tick(env.P.dt);
  }
  return env.result();
}

export function parseJson(text) {
  if (typeof text !== "string") return null;
  const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const o = JSON.parse(text.slice(s, e + 1));
    if (isObj(o)) return o;
  } catch {}
  // Fallback for replies that wrap the answer in other text containing braces
  // (reasoning traces, prose): the LAST balanced top-level object that parses.
  // Only reached when the span above fails, so any reply the original rule
  // accepted is read exactly as before.
  let found = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { const o = JSON.parse(text.slice(i, j + 1)); if (isObj(o)) found = o; } catch {}
        i = j;
        break;
      }
    }
  }
  return found;
}

// Generic model controller: build(obs, history, opts) -> messages;
// read(parsed) -> { command, ...record }. One retry for a reply that can't
// be used; after that the previous command stands and the decision is
// flagged invalid.
//   check(parsed) -> null, or a string saying what is wrong with the reply's
//     shape (for example a velocity that isn't three numbers). A reply that
//     fails the check is treated like one that doesn't parse.
//   stand(prev) -> the command to hold when a reply is invalid. The default
//     repeats the previous command; a relative command (a turn) must not be
//     repeated, so its caller passes a version with the turn removed.
// An error marked { transport: true } (the network or the host failed, not
// the model) is never scored as a decision: it is rethrown so the runner can
// drop the flight and fly it again.
export function rippleController(chat, build, read, { fallback = {}, meta = {}, opts = {}, check = null, stand = (prev) => prev } = {}) {
  const history = [];
  return async (obs, env) => {
    const msgs = build(obs, history, opts, env);
    let reply = null, parsed = null, error = null, attempts = 0;
    while (attempts < 2 && !parsed) {
      attempts++;
      try {
        reply = await chat(msgs, { ...meta, t: obs.time_s });
        parsed = parseJson(reply.content);
        if (!parsed) error = "unparseable reply";
        else if (check) {
          const wrong = check(parsed);
          if (wrong) { error = `wrong shape: ${wrong}`; parsed = null; }
        }
      } catch (err) {
        if (err?.transport) throw err;
        error = String(err.message || err);
      }
    }
    const prev = history.length ? history[history.length - 1].command : null;
    const rec = parsed ? read(parsed, obs) : { command: prev ? stand(prev) : fallback, invalid: error, say: "" };
    rec.meta = { attempts, provider: reply?.provider ?? null, latencyMs: reply?.latencyMs ?? null, ...(reply?.finish && reply.finish !== "stop" ? { finish: reply.finish } : {}) };
    // The model's own memory carries over an invalid reply unchanged.
    const memory = rec.memory ?? (history.length ? history[history.length - 1].memory : undefined);
    history.push({ t: obs.time_s, command: rec.command, say: rec.say, obs, ...(memory !== undefined ? { memory } : {}) });
    return rec;
  };
}
