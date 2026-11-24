// Integrity additions (2026-11-19): node-disjoint route sets, opt-in wind and
// opt-in sensor noise. None of these change the published sets or flights.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { World, v } from "../src/world.js";
import { Reach, makeReachSets } from "../src/gym/reach.js";
import { FreeDrone, runEpisode, replayEpisode } from "../src/gym/core.js";
import { straightReach, reactiveReach } from "../src/gym/reach_agents.js";
import { makeReachSetsDisjoint, sharedEndpoints, SET_ORDER } from "../src/gym/reach_sets_v2.js";
import { WindyDrone, PerturbedReach, makeReachEnv, WIND_LEVELS, NOISE_LEVELS } from "../src/gym/reach_perturb.js";

const load = (name) => new World(JSON.parse(readFileSync(new URL(`../maps/${name}.json`, import.meta.url))));
const factory = load("factory-full");

test("published factory sets do share endpoints (the gap this fixes)", () => {
  const pub = makeReachSets(factory);
  assert.equal(sharedEndpoints(factory, pub, "train", "test").shared.length, 18);
});

for (const name of ["factory-full", "residential", "canyon"]) {
  test(`node-disjoint sets on ${name}: no waypoint is used by two sets`, () => {
    const w = name === "factory-full" ? factory : load(name);
    const S = makeReachSetsDisjoint(w);
    const sizes = { train: 12, dev: 24, heldout: 24, test: 48 };
    const owner = {};
    for (const k of SET_ORDER) {
      assert.equal(S[k].length, sizes[k]);
      for (const r of S[k]) {
        for (const id of [r.start, r.goal]) {
          assert.ok(owner[id] === undefined || owner[id] === k, `${id} is in ${owner[id]} and ${k}`);
          owner[id] = k;
        }
        assert.ok(r.straight_m >= 15 && r.straight_m <= 35);
        assert.ok(r.graph_m / r.straight_m >= 1.15);
        assert.ok(!w.segmentClear(w.nodes[r.start], w.nodes[r.goal], 0.25), "no straight line of sight");
      }
    }
    // Explicitly: nothing train touches appears in dev, held-out or test, and
    // the default 3 m separation keeps the sets apart in space too.
    for (const k of ["dev", "heldout", "test"]) {
      const c = sharedEndpoints(w, S, "train", k);
      assert.deepEqual(c.shared, []);
      assert.ok(c.nearest_m >= 3, `${k} endpoint ${c.nearest_m} m from a train endpoint`);
    }
    const ids = SET_ORDER.flatMap((k) => S[k].map((r) => r.id));
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(makeReachSetsDisjoint(w).test, S.test, "deterministic");
  });
}

test("node-disjoint generator refuses rather than returning a short set", () => {
  assert.throws(() => makeReachSetsDisjoint(load("building"), { train: 40, dev: 40, heldout: 40, test: 40 }), /only \d+ of/);
});

const sc = makeReachSets(factory).dev[0];

test("WindyDrone with no steady wind and unscaled gusts is FreeDrone exactly", () => {
  const a = new FreeDrone(factory, factory.nodes[sc.start], 1234);
  const b = new WindyDrone(factory, factory.nodes[sc.start], 1234, { steady: 0, gustScale: 1 });
  for (const d of [a, b]) d.setVelocity([2, 0.3, -1]);
  for (let i = 0; i < 600; i++) { a.step(1 / 60, i / 60); b.step(1 / 60, i / 60); }
  assert.deepEqual(b.pos, a.pos);
  assert.deepEqual(b.vel, a.vel);
  assert.deepEqual(b.contacts, a.contacts);
});

test("no wind and no noise builds the plain Reach environment", () => {
  assert.equal(makeReachEnv(factory, sc, 1, "C3", {}).constructor, Reach);
  assert.equal(makeReachEnv(factory, sc, 1, "C3", { sensors: "basic" }).constructor, Reach);
  assert.equal(makeReachEnv(factory, sc, 1, "C3", { wind: WIND_LEVELS.light }).constructor, PerturbedReach);
});

test("steady wind pushes a hovering drone downwind; the push is seeded", () => {
  const open = { ...factory, physics: factory.physics, bounds: factory.bounds, moveSphere: (p, q) => q };
  const hover = (seed, wind) => { const d = new WindyDrone(open, [0, 5, 0], seed, wind); d.setVelocity([0, 0, 0]); for (let i = 0; i < 300; i++) d.step(1 / 60, i / 60); return d; };
  const d = hover(7, { steady: 4, gustScale: 0 });
  const along = v.dot(d.vel, d.windDir);
  assert.ok(Math.abs(along - 1) < 0.05, `settles near steady x 0.25 = 1 m/s downwind, got ${along}`);
  assert.deepEqual(hover(7, WIND_LEVELS.strong).pos, hover(7, WIND_LEVELS.strong).pos);
  assert.notDeepEqual(hover(7, WIND_LEVELS.strong).windDir, hover(8, WIND_LEVELS.strong).windDir);
});

test("windy and noisy flights re-run identically and replay from their commands", async () => {
  for (const [level, ctl] of [["C3", reactiveReach], ["C2", straightReach]]) {
    const opts = { wind: WIND_LEVELS.moderate, noise: NOISE_LEVELS.high };
    const a = await runEpisode(makeReachEnv(factory, sc, sc.seeds[0], level, opts), ctl(factory, sc));
    const b = await runEpisode(makeReachEnv(factory, sc, sc.seeds[0], level, opts), ctl(factory, sc));
    assert.deepEqual(b.result, a.result);
    assert.deepEqual(b.decisions.map((d) => d.command), a.decisions.map((d) => d.command));
    assert.deepEqual(replayEpisode(makeReachEnv(factory, sc, sc.seeds[0], level, opts), a.decisions), a.result);
  }
});

test("sensor noise perturbs readings but never the physics", () => {
  const clean = new Reach(factory, sc, 99, "C3");
  const noisy = new PerturbedReach(factory, sc, 99, "C3", { noise: NOISE_LEVELS.severe });
  const o = noisy.observe(), c = clean.observe();
  assert.deepEqual(noisy.drone.pos, clean.drone.pos);
  assert.notDeepEqual(o.position, c.position);
  assert.equal(o.goal.distance_m, Math.round(v.dist(o.position, o.goal.position) * 10) / 10);
  for (const k of Object.keys(c.free_space_m)) assert.ok(o.free_space_m[k] >= 0 && o.free_space_m[k] <= 12);
  // Same seed, same readings.
  assert.deepEqual(new PerturbedReach(factory, sc, 99, "C3", { noise: NOISE_LEVELS.severe }).observe(), o);
});
