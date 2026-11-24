// The arena must fly exactly what the benchmark flies.
//   node --test arena/test/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { replayEpisode } from "../../sim/src/gym/core.js";
import { Reach } from "../../sim/src/gym/reach.js";
import { separateRandomSeed as nodeSeparate } from "../../sim/src/gym/policy_sandbox.js";
import { makeWorld, fly, replay, fingerprint, compareRuns, BUILTIN, MAP_PATH, SCENARIO_PATH } from "../runner.js";
import { coreProgramController } from "../controllers.js";
import { separateRandomSeed } from "../policy_core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../..");
// JSON has no -0 (Math.round can make one); recorded runs are JSON.
const J = (x) => JSON.parse(JSON.stringify(x));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const world = makeWorld(JSON.parse(read(MAP_PATH)));
const sets = JSON.parse(read(SCENARIO_PATH));
const route = (id) => [...sets.train, ...sets.dev, ...sets.heldout].find((s) => s.id === id);
const fixture = JSON.parse(read("arena/fixtures/determinism.json"));
const manifest = JSON.parse(read("arena/programs/manifest.json"));
const ripple = read("arena/programs/ripple-cap2-run3-v7.js");

// The arena's own code path: the page's controllers, with programs through
// policy_core.js (what the Web Worker runs), not node:vm.
async function arenaController(name, sc, seed) {
  if (BUILTIN[name]) return BUILTIN[name].make(world, sc);
  const code = name === "ripple-v7" ? ripple : name === "jitter" ? fixture.jitterProgram : null;
  const c = coreProgramController(code, await separateRandomSeed(seed));
  assert.equal(c.compileError, null);
  return c.controller;
}

test("the frozen program is byte-identical to its recorded source", () => {
  const sha = crypto.createHash("sha256").update(ripple).digest("hex");
  assert.equal(sha, manifest.programs[0].sha256);
});

test("the program's Math.random seed matches policy_sandbox.js", async () => {
  for (const s of [1, 820001, 830222, 4294967295]) assert.equal(await separateRandomSeed(s), nodeSeparate(s));
});

for (const c of fixture.cases) {
  test(`arena flies ${c.controller}@${c.level} on ${c.route} wind ${c.seed} exactly as the benchmark does`, async () => {
    const sc = route(c.route);
    const run = await fly(world, sc, c.seed, c.level, await arenaController(c.controller, sc, c.seed));
    assert.deepEqual(run.result, c.result);
    assert.deepEqual(J(run.steps.map((s) => s.command)), c.commands);
    assert.equal(fingerprint(run.frames), c.frames);
    assert.equal(fingerprint(run.contacts), c.contacts);
    // Replay from the recorded commands alone gives the same flight...
    const again = replay(world, sc, c.seed, c.level, c.commands);
    assert.deepEqual(again.result, c.result);
    assert.equal(fingerprint(again.frames), c.frames);
    assert.deepEqual(again.steps.map((s) => s.obs), run.steps.map((s) => s.obs));
    // ...and so does the simulator's own replayEpisode.
    assert.deepEqual(replayEpisode(new Reach(world, sc, c.seed, c.level), c.commands.map((command) => ({ command }))), c.result);
  });
}

for (const p of fixture.published ?? []) {
  test(`arena re-flies the published ${p.controller}@${p.level} ${p.route} wind ${p.seed} (${p.source})`, async () => {
    const sc = route(p.route);
    const run = await fly(world, sc, p.seed, p.level, await arenaController(p.controller, sc, p.seed));
    assert.deepEqual(run.result, p.result);
    assert.deepEqual(J(run.steps.map((s) => s.command)), p.commands);
    assert.equal(fingerprint(run.frames), p.frames);
  });
}

test("leaderboard order: reached, then time, then wall contacts", () => {
  const r = (outcome, time, contacts, minGoalDist = 0.9) => ({ result: { outcome, time, contacts, minGoalDist } });
  const runs = [r("timeout", 90.02, 0, 3), r("reached", 20, 5), r("reached", 12, 9), r("reached", 12, 2), r("timeout", 90.02, 0, 1)];
  assert.deepEqual(runs.sort(compareRuns).map((x) => [x.result.outcome, x.result.time, x.result.contacts, x.result.minGoalDist]), [
    ["reached", 12, 2, 0.9], ["reached", 12, 9, 0.9], ["reached", 20, 5, 0.9], ["timeout", 90.02, 0, 1], ["timeout", 90.02, 0, 3],
  ]);
});

test("a broken program hovers and reports, it does not crash the flight", async () => {
  const sc = route("D1");
  for (const code of ["function policy( {", "const x = 1;", "function policy(){ throw new Error('nope') }", "function policy(){ return { velocity: 'fast' } }"]) {
    const c = coreProgramController(code, 1);
    const run = await fly(world, sc, sc.seeds[0], "C3", c.controller);
    assert.equal(run.result.outcome, "timeout");
    assert.ok(run.steps.every((s) => s.command.velocity.every((x) => x === 0)));
    assert.ok(run.steps[0].error);
  }
});

test("a program cannot reach the network globals", () => {
  const c = coreProgramController("function policy(){ return { velocity: [typeof fetch === 'undefined' ? 1 : 0, typeof globalThis === 'undefined' ? 1 : 0, typeof process === 'undefined' ? 1 : 0] } }", 1);
  return c.controller({}).then((r) => assert.deepEqual(r.command.velocity, [1, 1, 1]));
});

// The page's first-run note says Ripple's flight program reaches route D21
// wind 1 and 43 of the 72 route and wind pairs offered (practice and
// development routes). Keep that sentence true.
test("first-run copy: D21 wind 1 is reached, and 43 of 72 pairs overall", async () => {
  let reached = 0, total = 0, d21 = null;
  for (const sc of [...sets.train, ...sets.dev])
    for (const seed of sc.seeds) {
      const run = await fly(world, sc, seed, "C3", await arenaController("ripple-v7", sc, seed));
      total++;
      if (run.result.outcome === "reached") reached++;
      if (sc.id === "D21" && seed === sc.seeds[0]) d21 = run.result;
    }
  assert.equal(d21.outcome, "reached");
  assert.deepEqual([reached, total], [43, 72]);
});
