// Shared Reach episode scoring: re-flies a recorded episode from its
// commands and returns the outcome metrics plus contact metrics that only a
// replay can give (time spent touching geometry, progress before the first
// contact). Used by reach_contact_audit.mjs and bench_report.mjs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { World, v } from "../src/world.js";
import { Reach } from "../src/gym/reach.js";
import { rng } from "../src/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, "../..");

export function loadReach() {
  const world = new World(JSON.parse(fs.readFileSync(path.join(here, "../maps/factory-full.json"))));
  const sets = JSON.parse(fs.readFileSync(path.join(here, "../scenarios/reach-factory.json")));
  const scen = Object.fromEntries([...sets.train, ...sets.dev, ...sets.heldout].map((s) => [s.id, s]));
  return { world, sets, scen };
}

// Pre-registered contact-aware secondary: reached while
// touching geometry at most this share of the flight. The senses-only
// reactive avoider sits at 6-9%.
export const TOUCH_MAX = 0.15;

export function auditEpisode(world, scen, e) {
  const env = new Reach(world, scen[e.scenario], e.seed, e.level);
  const start = v.dist(env.drone.pos, env.goalPos);
  const stepsPer = Math.round((e.dt || 1) / env.P.dt);
  let ticks = 0, touching = 0, firstContactMin = null;
  for (const d of e.decisionLog) {
    if (env.done) break;
    env.apply(d.command);
    for (let k = 0; k < stepsPer && !env.done; k++) {
      env.tick(env.P.dt);
      ticks++;
      if (env.drone.touching) touching++;
      if (firstContactMin === null && env.drone.contacts.length > 0) firstContactMin = env.minGoalDist;
    }
  }
  const res = env.result();
  const reached = res.outcome === "reached";
  const touch = ticks ? touching / ticks : 0;
  return {
    exact: JSON.stringify(res) === JSON.stringify(e.result),
    reached: reached ? 1 : 0,
    clean: reached && res.contacts === 0 ? 1 : 0,
    le3: reached && res.contacts <= 3 ? 1 : 0,
    reachedLowTouch: reached && touch <= TOUCH_MAX ? 1 : 0,
    progress: Math.max(0, 1 - env.minGoalDist / start),
    progressFirst: Math.max(0, 1 - (firstContactMin ?? env.minGoalDist) / start),
    contacts: res.contacts,
    perMin: res.contacts / (res.time / 60),
    touching: touch,
    time: res.time,
  };
}

// Hash of everything that defines the Reach task and the v0 harness. Runs
// with different hashes are not comparable; bench_report refuses to mix them.
export const HARNESS_FILES = ["sim/src/gym/reach.js", "sim/src/gym/reach_agents.js", "sim/src/gym/core.js", "sim/src/world.js", "sim/src/engine.js", "sim/maps/factory-full.json", "sim/scenarios/reach-factory.json"];
// Harness versions. Flights from different versions are not comparable, so a
// report covers one version only.
//   v0  the published results (methodology v3 and v4). A reply with the wrong
//       shape became an unflagged hover, an invalid reply at C4 repeated the
//       previous turn, and a network failure was scored as an invalid decision.
//   v1  the current code: those three are fixed (docs/HARNESS_CHANGELOG.md).
// The hashes listed for v0 are the ones recorded in existing run files. The
// current code is always the current version, whatever its hash.
export const HARNESS_VERSION = "v1";
export const EARLIER_HARNESS = {
  "5e7fe2e30a94c0f3": "v0",
  "fcd8c3c8b1f7f8b3": "v0",
};
export const harnessVersion = (h, current = harnessHash()) => (h === current ? HARNESS_VERSION : EARLIER_HARNESS[h] ?? `unknown (${h})`);
// For adding flights to an existing run: only the exact same code will do.
export const sameHarness = (h, current = harnessHash()) => h === current;
export function harnessHash() {
  const h = crypto.createHash("sha256");
  for (const f of HARNESS_FILES) h.update(f + "\0" + fs.readFileSync(path.join(ROOT, f)) + "\0");
  return h.digest("hex").slice(0, 16);
}

export const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// Cluster bootstrap over scenarios (rows carry .scenario).
// The generator is engine.js rng. An earlier inline generator lost
// precision past 2^53 and repeated every 10,466 draws, far fewer than one
// bootstrap needs; the published v3 and v4 reports still use it so their
// numbers don't move (docs/HARNESS_CHANGELOG.md has the recheck).
export function bootCI(rows, stat, B = 10000, seed = 12345) {
  const by = Object.values(Object.groupBy(rows, (r) => r.scenario));
  const rand = rng(seed).next;
  const vals = [];
  for (let i = 0; i < B; i++) vals.push(stat(by.flatMap(() => by[Math.floor(rand() * by.length)])));
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * B)], vals[Math.floor(0.975 * B)]];
}
