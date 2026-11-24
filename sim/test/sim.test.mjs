// node --test sim/test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World, routeMenu } from "../src/world.js";
import { Episode } from "../src/engine.js";
import { validateDefender, validateAttack, shortestPathPolicy, extractJson } from "../src/policy.js";
import { checkSolvable, runEpisode, TRAINING_TASK, TRAINING_SEEDS } from "../src/scenarios.js";
import { makeQuiz, scoreQuiz } from "../src/agents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const world = new World(JSON.parse(fs.readFileSync(path.join(here, "../maps/building.json"))));
const heldout = JSON.parse(fs.readFileSync(path.join(here, "../scenarios/heldout.json"))).scenarios;
const quietBird = { start: "perch", strategy: "ambush", ambush_node: "perch", speed: 4, lead_time: 0, trigger_distance: 2 };

test("every navigation edge is clear of collision geometry", () => {
  assert.deepEqual(world.blockedEdges(0.5), []);
});

test("simulation is deterministic for a given seed", () => {
  const sc = { ...TRAINING_TASK, bird: { ...quietBird, strategy: "pursue", trigger_distance: 10 } };
  const pol = shortestPathPolicy(world, sc);
  const a = new Episode(world, sc, pol, 42).run();
  const b = new Episode(world, sc, pol, 42).run();
  assert.equal(a.outcome, b.outcome);
  assert.equal(a.time, b.time);
});

test("every menu route reaches the goal when the bird stays put", () => {
  const sc = { ...TRAINING_TASK, bird: quietBird, seeds: [1, 2] };
  for (const r of routeMenu(world)) {
    const { summary } = runEpisode(world, sc, { route: r.route, cruise_speed: 3, corner_slowdown: 0.6, avoidance_distance: 0, evade_strength: 0, replan_when_bird_nearby: false }, { keepFrames: false });
    assert.ok(summary.reached >= 1, `${r.id} ${r.label} reached ${summary.reached}/2`);
  }
});

test("defender validation: route ids, invalid actions, clamping", () => {
  const sc = { ...TRAINING_TASK, bird: quietBird };
  const ok = validateDefender({ route_id: "r2", cruise_speed: 99 }, world, sc);
  assert.equal(ok.invalid, null);
  assert.equal(ok.policy.route_id, "R2");
  assert.equal(ok.policy.cruise_speed, 5.5);
  assert.ok(ok.warnings.some((w) => w.includes("clamped")));
  assert.ok(validateDefender({ route_id: "R99" }, world, sc).invalid);
  assert.ok(validateDefender({ route: ["start", "goal"] }, world, sc).invalid);
});

test("attacker validation keeps the bird off the start and goal", () => {
  const { bird, warnings } = validateAttack({ bird_start: "goal", strategy: "ambush", ambush_node: "start", speed: 10 }, world, TRAINING_TASK);
  assert.notEqual(bird.start, "goal");
  assert.notEqual(bird.ambush_node, "start");
  assert.equal(bird.speed, 4.6);
  assert.ok(warnings.length >= 3);
});

test("held-out scenarios are all solvable and differ from training", () => {
  assert.equal(heldout.length, 12);
  for (const sc of heldout) {
    assert.ok(checkSolvable(world, sc).solvable, sc.id);
    assert.ok(!sc.seeds.some((s) => TRAINING_SEEDS.includes(s)));
  }
});

test("extractJson handles fences, prose and arrays", () => {
  assert.deepEqual(extractJson('Sure:\n```json\n{"a": "}"}\n```'), { a: "}" });
  assert.deepEqual(extractJson('x [{"id":"Q1"}] y'), [{ id: "Q1" }]);
  assert.equal(extractJson("no json"), null);
});

test("quiz answers are not predictable from question order", () => {
  const q = makeQuiz();
  const evenCollide = q.filter((x, i) => i % 2 === 0 && x.truth.collide).length;
  const allCollide = q.filter((x) => x.truth.collide).length;
  assert.ok(allCollide >= 3 && allCollide <= 9);
  assert.notEqual(evenCollide, q.length / 2);
  const perfect = q.map((x) => ({ id: x.id, collide: x.truth.collide, t_closest: x.truth.t_closest }));
  assert.equal(scoreQuiz(q, perfect).accuracy, 1);
});
