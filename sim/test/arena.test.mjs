// The three ways people extend the arena: add a place, plug in a model, and
// give live steering a memory.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { World } from "../src/world.js";
import { Reach, makeReachSets } from "../src/gym/reach.js";
import { runEpisode, replayEpisode } from "../src/gym/core.js";
import { rippleReach, reachMessages, MEMORY_CHARS } from "../src/gym/reach_agents.js";
import { buildPlaceMap, placeEntry, checkPlace, checkDescription } from "../tools/maps/add_place.mjs";
import { loadEnvironment, ENVIRONMENTS } from "../tools/benchmark_env.mjs";
import { makeClient, clientFor, modelEntry } from "../tools/ripple_client.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const warehouse = JSON.parse(fs.readFileSync(path.join(root, "sim/scenes/places/warehouse.json"), "utf8"));

test("a place description becomes a fair, flyable place", async () => {
  const map = buildPlaceMap(warehouse);
  assert.deepEqual(buildPlaceMap(warehouse), map, "building is deterministic");
  const entry = placeEntry(warehouse);
  const c = await checkPlace(map, entry, { limit: 8 });
  assert.deepEqual(c.problems, []);
  assert.equal(c.sets.train.length, 12);
  assert.equal(c.sets.test.length, 24);
  assert.ok(c.reached.planner >= 0.9 && c.reached.straight < c.reached.planner);
  assert.equal(c.replays, c.flights);
  // No route appears in two sets.
  const key = (s) => [s.start, s.goal].sort().join("|");
  const all = [...c.sets.train, ...c.sets.dev, ...c.sets.test].map(key);
  assert.equal(new Set(all).size, all.length);
});

test("a bad description is refused with a reason", async () => {
  assert.throws(() => checkDescription({ ...warehouse, id: "Bad Name" }), /lower-case/);
  assert.throws(() => checkDescription({ ...warehouse, walls: [{ min: [1, 0, 1], max: [1, 2, 3] }] }), /min below max/);
  // An empty hall: every goal is in plain sight, so no route can be made.
  const open = { ...warehouse, id: "open-hall", walls: [{ min: [20, 0, 20], max: [20.5, 1, 20.5] }] };
  const c = await checkPlace(buildPlaceMap(open), placeEntry(open), { limit: 4 });
  assert.ok(c.problems.some((p) => /routes could be made/.test(p)), c.problems.join("; "));
});

test("the registered example place matches its description and its pinned routes", () => {
  assert.ok(ENVIRONMENTS.warehouse, "warehouse is registered");
  const E = loadEnvironment("warehouse");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, E.map), "utf8")), JSON.parse(JSON.stringify(buildPlaceMap(warehouse))));
  const pinned = JSON.parse(fs.readFileSync(path.join(root, E.scenarioFile), "utf8"));
  assert.deepEqual(pinned.dev, E.sets.dev);
});

test("the multi-model runner flies a place other than the factory", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "arena-bench-"));
  const run = (...a) => execFileSync("node", [path.join(root, "sim/tools/bench.mjs"), ...a], { cwd: root, encoding: "utf8" });
  run("--map", "warehouse", "--fake", "--models", "fake", "--baselines", "--set", "dev", "--limit", "3", "--seeds", "1", "--samples", "1", "--levels", "C3", "--out", out);
  const eps = fs.readFileSync(path.join(out, "fake/episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(eps.length, 3);
  assert.ok(eps.every((e) => e.map === "warehouse" && e.replayOk && e.scenario.startsWith("warehouse-")));
  const report = execFileSync("node", [path.join(root, "sim/tools/bench_report.mjs"), out], { cwd: root, encoding: "utf8" });
  assert.match(report, /Place and prompt: warehouse\./);
  // A second run on another place into the same folder is refused.
  assert.throws(() => run("--fake", "--models", "fake", "--set", "dev", "--limit", "1", "--seeds", "1", "--samples", "1", "--levels", "C3", "--out", out), /Use a new --out/);
  fs.rmSync(out, { recursive: true, force: true });
});

test("memory: the model's own note and its trail come back the next second", async () => {
  const world = loadEnvironment("factory").world;
  const sc = makeReachSets(world).dev[0];
  const prompts = [];
  let n = 0;
  const chat = async (m) => {
    prompts.push(m[1].content);
    n++;
    if (n === 3) return { content: "garbled", provider: "t", finish: "stop" };
    return { content: JSON.stringify({ velocity: [1, 0, 0.5], say: "east", memory: `note ${n} ${"x".repeat(1000)}` }), provider: "t", finish: "stop" };
  };
  const env = new Reach(world, sc, sc.seeds[0], "C3");
  const ctl = rippleReach(world, sc, "C3", chat, { features: ["memory"] });
  const r1 = await ctl(env.observe(), env);
  assert.equal(r1.memory.length, MEMORY_CHARS, "memory is capped");
  await ctl(env.observe(), env);
  assert.match(prompts[1], /Your memory, written by you last second: "note 1 /);
  assert.match(prompts[1], /"position":\[/);
  // An invalid reply (two garbled attempts) keeps the previous memory.
  n = 2;
  const chat2 = async () => ({ content: "garbled", provider: "t", finish: "stop" });
  const ctl2 = rippleReach(world, sc, "C3", async (m) => (prompts.push(m[1].content), prompts.length <= 3 ? chat(m) : chat2(m)), { features: ["memory"] });
  prompts.length = 0; n = 0;
  await ctl2(env.observe(), env);
  await ctl2(env.observe(), env);
  await ctl2(env.observe(), env);
  const bad = await ctl2(env.observe(), env);
  assert.ok(bad.invalid);
  await ctl2(env.observe(), env);
  assert.match(prompts[prompts.length - 1], /written by you last second: "note /);
  // Without the feature the prompt is the original one.
  const plain = reachMessages(world, sc, "C3", env.observe(), [], {})[1].content;
  assert.ok(!plain.includes("memory") && plain.includes("Your last commands: []"));
});

test("a flight with memory replays exactly from its commands", async () => {
  const world = loadEnvironment("warehouse").world;
  const sc = loadEnvironment("warehouse").sets.dev[0];
  const chat = async () => ({ content: '{"velocity":[1.5,0,1],"say":"go","memory":"heading north-east"}', provider: "t", finish: "stop" });
  const ep = await runEpisode(new Reach(world, sc, sc.seeds[0], "C3"), rippleReach(world, sc, "C3", chat, { features: ["memory"], scene: "A warehouse." }));
  assert.deepEqual(replayEpisode(new Reach(world, sc, sc.seeds[0], "C3"), ep.decisions), ep.result);
});

test("a model on a custom OpenAI-compatible endpoint needs no OpenRouter key", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: '{"velocity":[0,0,2]}' }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 7 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arena-noenv-"));
  try {
    const client = clientFor(emptyRoot, { id: "local", model: "my-local-model", baseUrl: `http://127.0.0.1:${server.address().port}/v1/`, provider: "ignored" }, { globalSlots: 0 });
    const r = await client.chat([{ role: "user", content: "hi" }]);
    assert.equal(r.content, '{"velocity":[0,0,2]}');
    assert.equal(seen[0].url, "/v1/chat/completions");
    assert.equal(seen[0].body.model, "my-local-model");
    assert.equal(seen[0].body.provider, undefined, "the OpenRouter host pin is not sent elsewhere");
    assert.equal(client.ledger.calls, 1);
    client.close();
  } finally {
    server.close();
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("the model list is the one place a model is defined", () => {
  assert.equal(modelEntry(root, "ripple-65b").model, "ricursiveai/ripple-65b-preview");
  assert.throws(() => modelEntry(root, "nope"), /add it to sim\/bench\/models.json/);
  assert.equal(typeof makeClient, "function");
});
