import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { World } from "../src/world.js";
import { Reach, makeReachSets } from "../src/gym/reach.js";
import { runEpisode, replayEpisode } from "../src/gym/core.js";
import { compilePolicy, programController, extractCode } from "../src/gym/policy_sandbox.js";

const world = new World(JSON.parse(readFileSync(new URL("../maps/factory-full.json", import.meta.url))));
const sc = makeReachSets(world).dev[0];
const SIMPLE = `function policy(obs, memory) {
  memory.n = (memory.n || 0) + 1;
  const d = [obs.goal.position[0] - obs.position[0], 0, obs.goal.position[2] - obs.position[2]];
  const L = Math.hypot(d[0], d[2]) || 1;
  const jitter = Math.random() * 0.2;
  return { velocity: [3 * d[0] / L + jitter, 0, 3 * d[2] / L] };
}`;

test("extracts the code block from a reply", () => {
  assert.equal(extractCode("Here:\n```js\nfunction policy(){}\n```\nDone"), "function policy(){}");
  assert.equal(extractCode("function policy(){}"), "function policy(){}");
});

test("sandbox has no access to node globals", () => {
  for (const bad of ["process.exit(1)", "require('fs')", "fetch('x')", "setTimeout(()=>{},1)"]) {
    const p = compilePolicy(`function policy(o, m) { ${bad}; return { velocity: [0,0,0] }; }`);
    assert.ok(!p.error);
    p.newMemory();
    assert.throws(() => p.call({}), /not defined/);
  }
});

test("sandbox cannot reach the host through constructors, eval or string compilation", () => {
  const escapes = [
    `Number.constructor("return process")()`,
    `this.constructor.constructor("return process")()`,
    `Object.getPrototypeOf(globalThis).constructor.constructor("return process")()`,
    `(async function () {}).constructor("return process")()`,
    `obs.constructor.constructor("return process")()`,
    `memory.constructor.constructor("return process")()`,
    `(() => { try { null.x } catch (e) { return e.constructor.constructor("return process")() } })()`,
    `eval("process")`,
    `new Function("return process")()`,
  ];
  for (const expr of escapes) {
    const p = compilePolicy(`function policy(obs, memory) { const r = ${expr}; return { velocity: [0, 0, 0], say: typeof r }; }`);
    assert.ok(!p.error, expr);
    p.newMemory();
    assert.throws(() => p.call({ position: [0, 0, 0] }), /Code generation from strings disallowed|not defined/, expr);
  }
});

test("program-defined toJSON and getters stay inside the time limit", () => {
  const cases = [
    `function policy() { return { velocity: [0, 0, 0], toJSON() { while (true) {} } }; }`,
    `function policy() { throw { get message() { while (true) {} } }; }`,
  ];
  for (const code of cases) {
    const p = compilePolicy(code);
    p.newMemory();
    const t = Date.now();
    assert.throws(() => p.call({}), /timed out/i, code);
    assert.ok(Date.now() - t < 2000, code);
  }
  assert.match(compilePolicy(`throw { get message() { while (true) {} } }`).error, /compile error/);
});

// A timeout inside a promise job trips Node's async-hook bookkeeping when the
// test runner's hooks are active, so this case runs in its own process, the
// way the evaluation tools run.
test("a promise job that never ends times out and the drone hovers", () => {
  const script = `
    import { programController } from ${JSON.stringify(new URL("../src/gym/policy_sandbox.js", import.meta.url).href)};
    const ctl = programController("function policy() { Promise.resolve().then(() => { while (true) {} }); return { velocity: [1, 0, 0] }; }");
    const out = [];
    for (let i = 0; i < 2; i++) out.push(await ctl({}));
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  for (const rec of JSON.parse(r.stdout)) {
    assert.deepEqual(rec.command, { velocity: [0, 0, 0] });
    assert.match(rec.error, /timed out/i);
  }
});

test("seeded Math.random matches engine rng and Math cannot be replaced", async () => {
  const { rng } = await import("../src/engine.js");
  const R = rng(42);
  const p = compilePolicy(`function policy() { Math = null; return { velocity: [Math.random(), Math.random(), 0] }; }`, { seed: 42 });
  p.newMemory();
  assert.deepEqual(p.call({}).velocity, [R.next(), R.next(), 0]);
});

test("an infinite loop is cut off by the time limit and hovers", async () => {
  const ctl = programController("function policy(o, m) { while (true) {} }");
  const rec = await ctl(new Reach(world, sc, 1, "C3").observe());
  assert.deepEqual(rec.command, { velocity: [0, 0, 0] });
  assert.match(rec.error, /timed out/i);
});

test("memory persists within a flight; runs are deterministic (seeded Math.random) and replay exactly", async () => {
  const run = async () => runEpisode(new Reach(world, sc, sc.seeds[0], "C3"), programController(SIMPLE, { seed: 7 }));
  const a = await run(), b = await run();
  assert.deepEqual(a.result, b.result);
  assert.deepEqual(a.decisions.map((d) => d.command), b.decisions.map((d) => d.command));
  assert.deepEqual(replayEpisode(new Reach(world, sc, sc.seeds[0], "C3"), a.decisions), a.result);
});

test("bad return values and missing policy are reported, not thrown", async () => {
  const r = await programController("function policy() { return 5; }")(new Reach(world, sc, 1, "C3").observe());
  assert.match(r.error, /expected \{ velocity/);
  const m = await programController("const x = 1;")(new Reach(world, sc, 1, "C3").observe());
  assert.match(m.error, /does not define function policy/);
});
