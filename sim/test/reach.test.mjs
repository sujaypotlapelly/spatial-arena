import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { World } from "../src/world.js";
import { Reach, makeReachSets, bodyDirs, LEVELS } from "../src/gym/reach.js";
import { runEpisode, replayEpisode } from "../src/gym/core.js";
import { plannerReach, straightReach, reactiveReach, rippleReach } from "../src/gym/reach_agents.js";

const world = new World(JSON.parse(readFileSync(new URL("../maps/factory-full.json", import.meta.url))));
const sets = makeReachSets(world);

test("scenario sets are disjoint, need a detour, and are deterministic", () => {
  const key = (s) => [s.start, s.goal].sort().join("|");
  const all = [...sets.train, ...sets.dev, ...sets.heldout].map(key);
  assert.equal(new Set(all).size, all.length);
  for (const s of sets.dev) assert.ok(s.graph_m / s.straight_m >= 1.15);
  assert.deepEqual(makeReachSets(world).dev, sets.dev);
});

test("every level replays exactly from recorded commands", async () => {
  const ctl = { C1: plannerReach, C2: straightReach, C3: reactiveReach };
  for (const sc of sets.dev.slice(0, 3)) {
    for (const level of LEVELS) {
      const c = level === "C4" ? () => async () => ({ command: { turn_deg: 20, forward_mps: 3, climb_mps: 0 } }) : ctl[level];
      const ep = await runEpisode(new Reach(world, sc, sc.seeds[0], level), c(world, sc));
      const re = replayEpisode(new Reach(world, sc, sc.seeds[0], level), ep.decisions);
      assert.deepEqual(re, ep.result, `${sc.id} ${level}`);
    }
  }
});

test("bad commands are sanitized", () => {
  const sc = sets.dev[0];
  assert.deepEqual(new Reach(world, sc, 1, "C2").apply({ target: "north", speed: 99 }), { target: null, speed: 5.5 });
  assert.deepEqual(new Reach(world, sc, 1, "C3").apply({ velocity: [100, 0, 0] }), { velocity: [5.49, 0, 0] }); // 1 cm/s under the cap so re-applying is a no-op
  assert.deepEqual(new Reach(world, sc, 1, "C4").apply({ turn_deg: 999, forward_mps: "fast" }), { turn_deg: 180, forward_mps: 0, climb_mps: 0 });
  assert.equal(new Reach(world, sc, 1, "C1").apply({ waypoint: "nowhere" }).waypoint, sc.goal);
});

test("body-frame directions: left is 90 degrees counter-clockwise of ahead", () => {
  const d = bodyDirs(0); // facing +x (east)
  assert.ok(Math.abs(d.ahead[0] - 1) < 1e-9);
  assert.ok(Math.abs(d.left[2] - 1) < 1e-9); // left of east is north (+z)
  assert.ok(Math.abs(d.right[2] + 1) < 1e-9);
});

test("C4 observation has no coordinates; C2/C3 have no map", () => {
  const sc = sets.dev[0];
  const o4 = new Reach(world, sc, 1, "C4").observe();
  assert.equal(o4.position, undefined);
  assert.equal(o4.goal.position, undefined);
  const o2 = new Reach(world, sc, 1, "C2").observe();
  assert.equal(o2.nearest_waypoint, undefined);
  const prompt = (await_ => rippleReach(world, sc, "C2", async () => ({ content: "{}" })))();
  assert.ok(prompt);
});

test("planner upper bound reaches most dev goals", async () => {
  let ok = 0;
  for (const sc of sets.dev.slice(0, 8)) {
    const ep = await runEpisode(new Reach(world, sc, sc.seeds[0], "C1"), plannerReach(world, sc));
    if (ep.result.outcome === "reached") ok++;
  }
  assert.ok(ok >= 6, `planner reached ${ok}/8`);
});

test("egocentric map facing north equals the north-up world map", async () => {
  const { asciiMap } = await import("../src/gym/reach_agents.js");
  const sc = sets.dev[0];
  const env = new Reach(world, sc, 1, "C4");
  env.heading = Math.PI / 2; // facing +z (north): ahead = north, right = east
  assert.equal(asciiMap(env, true), asciiMap(env, false));
});

test("command cleanup is idempotent at every level (exact replay)", () => {
  const sc = sets.dev[0];
  // Vectors recorded from real runs that broke replay under earlier rules.
  for (const vel of [[-0.5, -0.5, -5.45], [0.5, -0.5, 5.45], [3.89, 0, 3.89], [100, 0, 0], [5.495, 0, 0]]) {
    const once = new Reach(world, sc, 1, "C3").apply({ velocity: vel });
    assert.deepEqual(new Reach(world, sc, 1, "C3").apply(once), once, JSON.stringify(vel));
  }
  let seed = 9;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 20 - 10;
  for (let i = 0; i < 300; i++) {
    const raw = { velocity: [rnd(), rnd(), rnd()], target: [rnd() * 6, rnd(), rnd() * 6], speed: rnd(), turn_deg: rnd() * 40, forward_mps: rnd(), climb_mps: rnd(), waypoint: sc.goal };
    for (const level of ["C1", "C2", "C3", "C4"]) {
      const once = new Reach(world, sc, 1, level).apply(raw);
      const twice = new Reach(world, sc, 1, level).apply(once);
      assert.deepEqual(twice, once, `${level} ${JSON.stringify(raw)}`);
    }
  }
});

test("named directions convert to the matching velocity; hold hovers", async () => {
  const { namedToVelocity } = await import("../src/gym/reach_agents.js");
  const close = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  assert.ok(close(namedToVelocity({ direction: "east", speed: 3 }), [3, 0, 0]));
  assert.ok(close(namedToVelocity({ direction: "north", speed: 2, vertical_mps: 1 }), [2 * Math.cos(Math.PI / 2), 1, 2]));
  assert.ok(close(namedToVelocity({ direction: "north-west", speed: Math.SQRT2 }), [-1, 0, 1]));
  assert.ok(close(namedToVelocity({ direction: "hold", speed: 5 }), [0, 0, 0]));
  assert.ok(close(namedToVelocity({ direction: "upward", speed: 5 }), [0, 0, 0]));
});

test("warn feature reports a time to contact consistent with free space", async () => {
  const { reachMessages } = await import("../src/gym/reach_agents.js");
  const sc = sets.dev[0];
  const env = new Reach(world, sc, 1, "C3");
  env.apply({ velocity: [3, 0, 0] });
  for (let i = 0; i < 30; i++) env.tick(env.P.dt);
  const msg = reachMessages(world, sc, "C3", env.observe(), [], { features: ["warn"] }, env)[1].content;
  assert.match(msg, /Proximity sensor: closest obstacle [\d.]+ m to the /);
  assert.match(msg, /moving [\d.]+ m\/s toward the (east|north-east|south-east)/);
});

test("lean prompt is much shorter and carries the same core readings", async () => {
  const { reachMessages } = await import("../src/gym/reach_agents.js");
  const sc = sets.dev[0];
  const env = new Reach(world, sc, 1, "C3");
  const full = reachMessages(world, sc, "C3", env.observe(), [], {}, env)[1].content;
  const lean = reachMessages(world, sc, "C3", env.observe(), [], { features: ["lean"] }, env)[1].content;
  assert.ok(lean.length < full.length * 0.6, `lean ${lean.length} vs full ${full.length}`);
  for (const k of ['"pos"', '"goal"', '"free"', '"goal_visible"']) assert.ok(lean.includes(k), k);
});

test("a 2 s decision interval replays exactly", async () => {
  for (const sc of sets.dev.slice(0, 3)) {
    const ep = await runEpisode(new Reach(world, sc, sc.seeds[0], "C3"), reactiveReach(world, sc), { dt: 2 });
    const re = replayEpisode(new Reach(world, sc, sc.seeds[0], "C3"), ep.decisions, { dt: 2 });
    assert.deepEqual(re, ep.result, sc.id);
    assert.ok(ep.decisions.every((d, i) => i === 0 || Math.abs(d.t - ep.decisions[i - 1].t - 2) < 1e-6));
  }
});
