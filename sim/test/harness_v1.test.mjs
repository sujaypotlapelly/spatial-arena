// Harness v1: the rules a plugged-in model is scored under. Each test is one
// defect found in the v0 harness (docs/HARNESS_CHANGELOG.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { World } from "../src/world.js";
import { rng } from "../src/engine.js";
import { Reach, makeReachSets } from "../src/gym/reach.js";
import { runEpisode } from "../src/gym/core.js";
import { rippleReach } from "../src/gym/reach_agents.js";
import { compilePolicy, separateRandomSeed, programRandomSeed } from "../src/gym/policy_sandbox.js";
import { bootCI, harnessVersion, harnessHash, HARNESS_VERSION } from "../tools/reach_metrics.mjs";

const world = new World(JSON.parse(readFileSync(new URL("../maps/factory-full.json", import.meta.url))));
const sc = makeReachSets(world).dev[0];

// A model that returns the given replies in order, then repeats the last one.
const scripted = (replies) => {
  let i = 0;
  const chat = async () => ({ content: replies[Math.min(i++, replies.length - 1)], provider: "test", finish: "stop" });
  return { chat, calls: () => i };
};
const obsOf = (level) => new Reach(world, sc, sc.seeds[0], level).observe();

test("a reply with the wrong shape is flagged invalid, retried once, and never becomes a silent hover", async () => {
  for (const bad of ['{"ok":true}', '{"command":{"velocity":[1,0,0]}}', '{"velocity":[1,0]}', '{"velocity":[1,null,0]}', '{"velocity":"north"}']) {
    const m = scripted(['{"velocity":[2,0,1]}', bad]);
    const ctl = rippleReach(world, sc, "C3", m.chat);
    const first = await ctl(obsOf("C3"));
    assert.deepEqual(first.command, { velocity: [2, 0, 1] });
    assert.ok(!first.invalid);
    const second = await ctl(obsOf("C3"));
    assert.match(second.invalid, /wrong shape/, bad);
    assert.deepEqual(second.command, { velocity: [2, 0, 1] }, "the previous command stands");
    assert.equal(second.meta.attempts, 2);
    assert.equal(m.calls(), 3);
  }
});

test("a good reply is read exactly as before", async () => {
  const ctl = rippleReach(world, sc, "C3", scripted(['Thinking... {"velocity":["1.5",0,-2],"say":"south"}']).chat);
  const r = await ctl(obsOf("C3"));
  assert.deepEqual(r.command, { velocity: ["1.5", 0, -2] });
  assert.equal(r.invalid, undefined);
  assert.equal(r.meta.attempts, 1);
});

test("at C4 an invalid reply holds the heading instead of turning again", async () => {
  const m = scripted(['{"turn_deg":90,"forward_mps":2,"climb_mps":0}', "no idea"]);
  const ctl = rippleReach(world, sc, "C4", m.chat);
  const turns = [];
  for (let k = 0; k < 4; k++) turns.push((await ctl(obsOf("C4"))).command);
  assert.deepEqual(turns.map((c) => c.turn_deg), [90, 0, 0, 0]);
  assert.ok(turns.slice(1).every((c) => c.forward_mps === 2), "it keeps flying forward on the heading it had");
});

test("a network failure is not scored as a decision: the flight is rejected", async () => {
  const chat = async () => { throw Object.assign(new Error("transport failed (7 non-rate-limit errors)"), { transport: true }); };
  await assert.rejects(runEpisode(new Reach(world, sc, sc.seeds[0], "C3"), rippleReach(world, sc, "C3", chat)), /transport failed/);
  // An ordinary error from a model wrapper is still the model's problem.
  const flaky = async () => { throw new Error("model wrapper crashed"); };
  const r = await rippleReach(world, sc, "C3", flaky)(obsOf("C3"));
  assert.match(r.invalid, /model wrapper crashed/);
});

test("a program's random numbers can be kept apart from the wind's seed", () => {
  const draw = (opts) => {
    const p = compilePolicy("function policy(obs, memory) { return { velocity: [Math.random(), Math.random(), Math.random()] }; }", opts);
    p.newMemory();
    return p.call({}).velocity;
  };
  const seed = 840011;
  const wind = rng(seed);
  const windDraws = [wind.next(), wind.next(), wind.next()];
  assert.deepEqual(draw({ seed }), windDraws, "legacy: the published behaviour, unchanged");
  const apart = draw({ seed, randomSeed: programRandomSeed(seed, "separate") });
  assert.notDeepEqual(apart, windDraws);
  assert.deepEqual(apart, draw({ seed, randomSeed: separateRandomSeed(seed) }), "still deterministic");
  assert.equal(programRandomSeed(seed, "legacy"), seed);
  assert.throws(() => programRandomSeed(seed, "other"));
});

test("bootstrap intervals use a generator that does not cycle", () => {
  const next = rng(12345).next;
  const seen = new Set();
  for (let i = 0; i < 200000; i++) seen.add(next());
  assert.ok(seen.size > 199000);
  const rows = Array.from({ length: 48 }, (_, i) => [{ scenario: `X${i}`, reached: i % 3 === 0 ? 1 : 0 }, { scenario: `X${i}`, reached: i % 3 === 0 ? 1 : 0 }]).flat();
  const [lo, hi] = bootCI(rows, (x) => x.reduce((s, r) => s + r.reached, 0) / x.length);
  assert.ok(lo > 0.18 && lo < 0.25 && hi > 0.43 && hi < 0.5, `${lo}..${hi}`);
});

test("flights are labelled with a harness version", () => {
  assert.equal(harnessVersion(harnessHash()), HARNESS_VERSION);
  assert.equal(harnessVersion("5e7fe2e30a94c0f3"), "v0");
  assert.match(harnessVersion("0000000000000000"), /unknown/);
});
