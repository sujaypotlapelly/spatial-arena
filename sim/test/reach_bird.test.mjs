import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { World, v } from "../src/world.js";
import { Reach } from "../src/gym/reach.js";
import { ReachBird, BIRD_SENSE_RANGE } from "../src/gym/reach_bird.js";
import { runEpisode, replayEpisode } from "../src/gym/core.js";
import { reactiveReach } from "../src/gym/reach_agents.js";
import { birdAwareReach, plannerKeepAway } from "../src/gym/reach_bird_agents.js";
import { programController } from "../src/gym/policy_sandbox.js";

const world = new World(JSON.parse(readFileSync(new URL("../maps/factory-full.json", import.meta.url))));
const birdSets = JSON.parse(readFileSync(new URL("../scenarios/reach-bird-factory.json", import.meta.url)));
const routes = JSON.parse(readFileSync(new URL("../scenarios/reach-factory.json", import.meta.url)));
const N = world.nodes;

test("bird sets: train and dev only, disjoint, routes unchanged from Reach", () => {
  assert.deepEqual(Object.keys(birdSets).filter((k) => Array.isArray(birdSets[k])).sort(), ["dev", "rejected", "train", "train_v1"]);
  const key = (s) => [s.start, s.goal].sort().join("|");
  const tr = new Set(birdSets.train.map(key));
  for (const s of birdSets.dev) assert.ok(!tr.has(key(s)), `${s.id} also in train`);
  const byId = Object.fromEntries([...routes.train, ...routes.dev].map((s) => [s.id, s]));
  const ids = new Set();
  for (const s of [...birdSets.train, ...birdSets.dev]) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    const { bird, admission, id, ...route } = s;
    const base = id.replace(/-nobird$|[b-z]$/, "");
    const { id: _, ...expect } = byId[base];
    assert.deepEqual(route, expect, id);
    assert.ok(bird);
    if (bird.strategy !== "absent") assert.ok(admission, id);
  }
  // Practice set v2: up to three admitted birds per train route plus every
  // train route with the bird absent; dev one bird per route; train_v1 is
  // the first admitted bird per train route.
  for (const r of routes.train) assert.ok(birdSets.train.some((s) => s.id === `${r.id}-nobird` && s.bird.strategy === "absent"));
  for (const r of routes.train) assert.ok(birdSets.train.filter((s) => s.id.replace(/[b-z]$/, "") === r.id).length <= 3);
  assert.deepEqual(birdSets.train_v1, birdSets.train.filter((s) => routes.train.some((r) => r.id === s.id)));
  assert.equal(new Set(birdSets.dev.map((s) => s.start + s.goal)).size, birdSets.dev.length);
  assert.ok(birdSets.train.length >= 30 && birdSets.dev.length >= 12);
});

test("absent bird: plain Reach flight, but the sensor still reads not visible", async () => {
  const sc = birdSets.train.find((s) => s.bird.strategy === "absent");
  const env = new ReachBird(world, sc, sc.seeds[0]);
  assert.deepEqual(env.observe().bird, { visible: false, last_seen_s_ago: null });
  const plain = await runEpisode(new Reach(world, sc, sc.seeds[0], "C3"), reactiveReach(world, sc));
  const ep = await runEpisode(new ReachBird(world, sc, sc.seeds[0]), reactiveReach(world, sc));
  assert.deepEqual(ep.result, { ...plain.result, minBirdDist: null, closest: null, caughtAt: null });
  assert.deepEqual(ep.frames, plain.frames);
  assert.deepEqual(replayEpisode(new ReachBird(world, sc, sc.seeds[0]), ep.decisions), ep.result);
});

test("deterministic: the same scenario and seed fly identically", async () => {
  for (const sc of birdSets.dev.slice(0, 4)) {
    const a = await runEpisode(new ReachBird(world, sc, sc.seeds[0]), birdAwareReach(world, sc));
    const b = await runEpisode(new ReachBird(world, sc, sc.seeds[0]), birdAwareReach(world, sc));
    assert.deepEqual(a.result, b.result);
    assert.deepEqual(a.frames, b.frames);
  }
});

test("episodes replay exactly from recorded commands, frames include the bird", async () => {
  const ctls = [reactiveReach, birdAwareReach, (w, sc) => plannerKeepAway(w, sc)];
  for (const sc of birdSets.dev.slice(0, 5)) {
    for (const ctl of ctls) {
      const ep = await runEpisode(new ReachBird(world, sc, sc.seeds[1]), ctl(world, sc));
      const env = new ReachBird(world, sc, sc.seeds[1]);
      const re = replayEpisode(env, ep.decisions);
      assert.deepEqual(re, ep.result, sc.id);
      assert.deepEqual(env.frames, ep.frames);
      assert.equal(ep.frames[0].length, 9); // t, x, y, z, heading, bx, by, bz, state
    }
  }
});

test("with the bird disabled the class is plain Reach", async () => {
  for (const sc of routes.dev.slice(0, 4)) {
    const plain = await runEpisode(new Reach(world, sc, sc.seeds[0], "C3"), reactiveReach(world, sc));
    const noBird = await runEpisode(new ReachBird(world, sc, sc.seeds[0]), reactiveReach(world, sc));
    assert.deepEqual(noBird.result, plain.result);
    assert.deepEqual(noBird.frames, plain.frames);
    assert.deepEqual(noBird.decisions, plain.decisions);
  }
  const sc = birdSets.dev[0];
  const plain = await runEpisode(new Reach(world, sc, sc.seeds[0], "C3"), reactiveReach(world, sc));
  const off = await runEpisode(new ReachBird(world, sc, sc.seeds[0], { bird: false }), reactiveReach(world, sc));
  assert.deepEqual(off.result, plain.result);
  assert.deepEqual(off.frames, plain.frames);
  assert.equal(new ReachBird(world, sc, 1, { bird: false }).observe().bird, undefined);
});

test("the bird does not change the drone's wind", () => {
  const sc = birdSets.dev[0];
  const a = new ReachBird(world, sc, sc.seeds[0]);
  const b = new ReachBird(world, sc, sc.seeds[0], { bird: false });
  for (let k = 0; k < 30; k++) { a.drone.step(a.P.dt, k * a.P.dt); b.drone.step(b.P.dt, k * b.P.dt); }
  assert.deepEqual(a.drone.pos, b.drone.pos);
});

test("bird sensor: visible in the open within range, hidden behind walls", () => {
  const sc = birdSets.dev[0];
  const env = new ReachBird(world, sc, sc.seeds[0]);
  const d = env.drone.pos;
  const ids = world.nodeIds.map((id) => [id, v.dist(N[id], d)]).filter(([, r]) => r > 3 && r < BIRD_SENSE_RANGE - 2);
  const open = ids.find(([id]) => world.segmentClear(d, N[id], 0.05));
  const hidden = ids.find(([id]) => !world.segmentClear(d, N[id], 0.05));
  assert.ok(open && hidden, "need one visible and one hidden waypoint near the start");

  env.bird.pos = N[open[0]].slice();
  env.bird.vel = [1, 0, -2];
  let o = env.observe();
  assert.equal(o.bird.visible, true);
  assert.deepEqual(o.bird.position, N[open[0]].map((x) => Math.round(x * 10) / 10));
  assert.deepEqual(o.bird.velocity, [1, 0, -2]);
  assert.equal(o.bird.distance_m, Math.round(open[1] * 10) / 10);

  env.bird.pos = N[hidden[0]].slice();
  env.t += 1.5;
  o = env.observe();
  assert.deepEqual(o.bird, { visible: false, last_seen_s_ago: 1.5 });

  // Out of range in the open: not reported either.
  const far = world.nodeIds.find((id) => v.dist(N[id], d) > BIRD_SENSE_RANGE + 1 && world.segmentClear(d, N[id], 0.05));
  if (far) {
    env.bird.pos = N[far].slice();
    assert.equal(env.observe().bird.visible, false);
  }
});

test("catch rule: within catch distance ends the flight as caught", () => {
  const sc = birdSets.dev[0];
  const env = new ReachBird(world, sc, sc.seeds[0]);
  const free = Object.entries({ east: [1, 0, 0], west: [-1, 0, 0], north: [0, 0, 1], south: [0, 0, -1] }).find(([, u]) => world.segmentClear(env.drone.pos, v.add(env.drone.pos, v.scale(u, 2)), 0.4));
  assert.ok(free);
  // Just outside the catch distance, a parked bird does not catch.
  env.bp = { ...env.bp, speed: 0 };
  env.bird.state = "rest";
  env.bird.rest = 100;
  env.bird.pos = v.add(env.drone.pos, v.scale(free[1], env.P.catchDistance + 0.3));
  env.apply({ velocity: [0, 0, 0] });
  env.tick(env.P.dt);
  assert.equal(env.done, false);
  // Inside it: caught, with where it happened.
  env.bird.pos = v.add(env.drone.pos, v.scale(free[1], env.P.catchDistance - 0.2));
  env.tick(env.P.dt);
  const r = env.result();
  assert.equal(r.outcome, "caught");
  assert.ok(r.minBirdDist < env.P.catchDistance);
  assert.deepEqual(r.caughtAt, env.drone.pos.map((x) => Math.round(x * 100) / 100));
  assert.equal(r.closest.t, r.time);
});

test("a hovering drone is caught by a pursuing bird; a program flies the same", async () => {
  const sc = birdSets.train.find((s) => s.id === "T2");
  assert.equal(sc.bird.strategy, "pursue");
  const hover = async () => ({ command: { velocity: [0, 0, 0] } });
  const ep = await runEpisode(new ReachBird(world, sc, sc.seeds[0]), hover);
  assert.equal(ep.result.outcome, "caught");
  const prog = programController("function policy(obs, memory) { return { velocity: [0, 0, 0] }; }");
  const ep2 = await runEpisode(new ReachBird(world, sc, sc.seeds[0]), prog);
  assert.deepEqual(ep2.result, ep.result);
});
