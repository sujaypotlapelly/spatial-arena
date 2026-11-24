// The bring-your-own-model path end to end, against a local mock
// OpenAI-compatible server (sim/tools/arena/mock_openai.mjs): no key, no
// network, no cost.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startMockServer } from "../tools/arena/mock_openai.mjs";
import { loadEnvironment } from "../tools/benchmark_env.mjs";
import { programTask } from "../tools/arena/program_mode.mjs";
import { resolveSettings, instrumentChat } from "../tools/arena/model_settings.mjs";
import { commitmentOf, makeHiddenRoutes, openHiddenSplit, generatorHash, publicSetsHash, readCommitments, tunedWaypoints, COMMIT_FILE } from "../tools/arena/hidden_split.mjs";
import { programController, timingVerdict } from "../src/gym/policy_sandbox.js";
import { Reach } from "../src/gym/reach.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.join(here, "../tools/bench.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "arena-test-"));

// bench.mjs in a child process, without blocking this process (the mock
// server lives here).
function bench(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BENCH, ...args], { env: { ...process.env, ARENA_ENV_FILE: "/nonexistent" } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function withMock(mode, entry, fn) {
  const server = await startMockServer({ mode });
  try {
    const dir = tmp();
    const reg = path.join(dir, "models.json");
    fs.writeFileSync(reg, JSON.stringify({ defaults: { maxTokens: 400, temperature: 0.7 }, models: [{ id: "m", model: "mock-model", baseUrl: server.url, ...entry }] }));
    return await fn({ server, dir, reg });
  } finally {
    await server.close();
  }
}
const card = (dir, id = "m") => JSON.parse(fs.readFileSync(path.join(dir, id, "scorecard.json"), "utf8"));

test("steady mock: one command preflights, flies a dev sample and writes a scorecard", async () => {
  await withMock("steady", { price: { in: 1, out: 1 } }, async ({ server, dir, reg }) => {
    const r = await bench(["--registry", reg, "--model", "m", "--map", "factory", "--out", dir]);
    assert.equal(r.status, 0, r.stderr);
    const S = card(dir);
    assert.equal(S.episodes, 4);
    assert.equal(S.set, "dev");
    assert.equal(S.replies.invalidTruncated, 0);
    assert.equal(S.replies.invalidWrong, 0);
    assert.ok(S.progress > 0, "the steady pilot makes progress");
    assert.equal(S.calls.costSource, "reported by the host");
    assert.ok(S.calls.costUsd > 0 && S.calls.latencyMs.median !== null);
    assert.ok(fs.readFileSync(path.join(dir, "m/SCORECARD.md"), "utf8").includes("| Reached |"));
    // What reached the endpoint: the model id, the default settings, no OpenRouter routing.
    const flight = server.requests.find((q) => q.body.messages[0].content.includes("piloting"));
    assert.equal(flight.body.model, "mock-model");
    assert.equal(flight.body.temperature, 0.7);
    assert.equal(flight.body.max_tokens, 400);
    assert.equal(flight.body.provider, undefined);
    assert.equal(flight.auth, "Bearer none");
    // Every episode replays exactly and the report reads the folder.
    const rows = fs.readFileSync(path.join(dir, "m/episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.every((e) => e.replayOk && e.arenaHash && e.mode === "live"));
    const rep = spawnSync(process.execPath, [path.join(here, "../tools/bench_report.mjs"), dir, "--registry", reg], { encoding: "utf8" });
    assert.equal(rep.status, 0, rep.stderr);
  });
});

test("truncating mock: the preflight stops the run, and cut-offs are never counted as wrong answers", async () => {
  await withMock("truncate", {}, async ({ dir, reg }) => {
    const r = await bench(["--registry", reg, "--model", "m", "--map", "factory", "--limit", "1", "--out", dir]);
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.match(r.stdout, /finish=length/);
    assert.ok(!fs.existsSync(path.join(dir, "m/episodes.jsonl")));
    const r2 = await bench(["--registry", reg, "--model", "m", "--map", "factory", "--limit", "1", "--ignore-preflight", "--out", dir]);
    assert.equal(r2.status, 0, r2.stderr);
    const S = card(dir);
    assert.ok(S.replies.invalidTruncated > 0);
    assert.equal(S.replies.invalidWrong, 0);
    assert.equal(S.replies.episodesWithTruncation, 1);
    assert.equal(S.valid, false);
    assert.match(S.problems.join(" "), /cut off by the 400-token limit/);
    assert.ok(S.calls.finishes["length"] > 0, "finish reasons are recorded per call");
  });
});

test("malformed mock: unusable replies are counted as wrong, not as cut off", async () => {
  await withMock("malformed", {}, async ({ dir, reg }) => {
    const r = await bench(["--registry", reg, "--model", "m", "--map", "factory", "--limit", "1", "--ignore-preflight", "--out", dir]);
    assert.equal(r.status, 0, r.stderr);
    const S = card(dir);
    assert.equal(S.replies.invalidWrong, S.replies.decisions);
    assert.equal(S.replies.invalidTruncated, 0);
    assert.equal(S.calls.truncatedCalls, 0);
  });
});

test("thinking mock: cut off at 400 tokens; fine with thinking off or a bigger budget; retries are configurable", async () => {
  await withMock("thinker", {}, async ({ dir, reg }) => {
    const r = await bench(["--registry", reg, "--model", "m", "--map", "factory", "--limit", "1", "--out", dir]);
    assert.equal(r.status, 4);
    assert.match(r.stdout, /probably thinking/);
  });
  // A non-OpenRouter server takes its own switch in extraBody.
  await withMock("thinker", { thinking: false, extraBody: { chat_template_kwargs: { enable_thinking: false } } }, async ({ server, dir, reg }) => {
    const r = await bench(["--registry", reg, "--model", "m", "--map", "factory", "--limit", "1", "--out", dir]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(card(dir).replies.invalidTruncated, 0);
    assert.deepEqual(server.requests.at(-1).body.chat_template_kwargs, { enable_thinking: false });
  });
  await withMock("thinker", { maxTokens: 2000 }, async ({ dir, reg }) => {
    const r = await bench(["--registry", reg, "--model", "m", "--map", "factory", "--limit", "1", "--out", dir]);
    assert.equal(r.status, 0, r.stderr);
    const S = card(dir);
    assert.equal(S.replies.invalidTruncated + S.replies.truncatedButUsable, 0);
    assert.ok(S.calls.reasoningTokens > 0);
    assert.equal(S.settings.maxTokens, 2000);
  });
  // retry.truncated asks again on a cut-off and is flagged as non-standard.
  let n = 0;
  const chat = async () => (++n < 3 ? { content: '{"vel', finish: "length" } : { content: "{}", finish: "stop" });
  const s = resolveSettings({ id: "x", retry: { truncated: 2 } });
  const I = instrumentChat(chat, { retryTruncated: s.retry.truncated });
  assert.equal((await I.chat([])).finish, "stop");
  assert.equal(I.stats.truncationRetries, 2);
  assert.match(s.nonStandard.join(), /extra attempt/);
});

test("program mode on another environment: practice on train, freeze, fly dev, time every policy call", async () => {
  await withMock("steady", {}, async ({ dir, reg }) => {
    const r = await bench(["--registry", reg, "--model", "m", "--map", "canyon5b", "--mode", "program", "--iters", "2", "--out", dir]);
    assert.equal(r.status, 0, r.stderr);
    const S = card(dir, "m-program");
    assert.equal(S.mode, "program");
    assert.equal(S.program.versions.length, 2);
    assert.equal(S.environment.name, "canyon5b");
    assert.equal(S.timing.timeouts, 0);
    assert.ok(S.timing.calls > 0 && S.timing.machineIndependent);
    assert.ok(fs.existsSync(path.join(dir, "m-program/best.js")));
  });
});

test("environment and set guards", async () => {
  const dir = tmp();
  const a = await bench(["--fake", "--model", "fake", "--map", "residential-video", "--out", dir]);
  assert.notEqual(a.status, 0);
  assert.match(a.stderr, /not an admitted environment \(film only\)/);
  const b = await bench(["--fake", "--model", "fake", "--map", "factory", "--set", "test", "--out", dir]);
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /pre-registration/);
});

test("program-mode prompt matches reach_cap.mjs (the published practice loop) for the factory", () => {
  const out = tmp();
  const r = spawnSync(process.execPath, [path.join(here, "../tools/reach_cap.mjs"), "--print-prompt", "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const E = loadEnvironment("factory");
  const obs = new Reach(E.world, E.sets.train[0], 1, "C3").observe();
  assert.equal(programTask(E, obs) + "\n", r.stdout);
});

test("policy budgets: legacy is unchanged, arena times every call and flags machine-dependent timing", async () => {
  const E = loadEnvironment("factory");
  const obs = new Reach(E.world, E.sets.dev[0], 1, "C3").observe();
  const quick = "function policy(o) { return { velocity: [1, 0, 0] }; }";
  const legacy = await programController(quick, { seed: 1 })(obs);
  assert.deepEqual(Object.keys(legacy).sort(), ["command", "say"]);
  const arena = await programController(quick, { seed: 1, budget: "arena" })(obs);
  assert.equal(typeof arena.callMs, "number");
  // About 150 ms of work: over the 50 ms legacy limit, inside the 1000 ms arena limit.
  const slow = "function policy(o) { const t = Date.now(); while (Date.now() - t < 150) {} return { velocity: [1, 0, 0] }; }";
  const l = await programController(slow, { seed: 1 })(obs);
  assert.match(l.error, /timed out/);
  assert.equal(l.timeout, undefined);
  const s = await programController(slow, { seed: 1, budget: "arena" })(obs);
  assert.equal(s.error, undefined);
  const v = timingVerdict([s]);
  assert.equal(v.timeouts, 0);
  assert.equal(v.machineIndependent, false, "150 ms is over a tenth of the limit");
  const loop = "function policy(o) { for (;;) {} }";
  const t = await programController(loop, { seed: 1, budget: { callTimeoutMs: 30, record: true } })(obs);
  assert.equal(t.timeout, true);
});

test("hidden split: the seed opens only its commitment; routes avoid every public pair and public wind", async () => {
  const E = loadEnvironment("factory");
  const seed = crypto.randomBytes(32).toString("hex");
  const n = 6;
  const dir = tmp();
  const file = path.join(dir, "splits.json");
  fs.writeFileSync(file, JSON.stringify({ splits: [{ environment: "factory", n, commitment: commitmentOf(E, n, seed), generator: generatorHash(), publicSets: publicSetsHash(E) }] }));
  const { routes } = openHiddenSplit(E, seed, file);
  assert.equal(routes.length, n);
  assert.deepEqual(routes, makeHiddenRoutes(E, seed, n), "deterministic");
  const pub = new Set(["train", "dev", "heldout", "test"].flatMap((k) => E.sets[k].map((s) => [s.start, s.goal].sort().join("|"))));
  const pubWind = new Set(["train", "dev", "heldout", "test"].flatMap((k) => E.sets[k].flatMap((s) => s.seeds)));
  for (const r of routes) {
    assert.ok(!pub.has([r.start, r.goal].sort().join("|")));
    assert.ok(!tunedWaypoints(E).has(r.start) && !tunedWaypoints(E).has(r.goal), "no endpoint shared with train or dev");
    assert.ok(r.seeds.every((w) => !pubWind.has(w)));
    assert.ok(r.straight_m >= 15 && r.straight_m <= 35);
  }
  assert.throws(() => openHiddenSplit(E, crypto.randomBytes(32).toString("hex"), file), /does not match/);
  assert.throws(() => openHiddenSplit(E, "abc", file), /64 lowercase hex/);
  // bench flies it only with the seed, the commitment and an explicit confirmation.
  const seedFile = path.join(dir, "seed");
  fs.writeFileSync(seedFile, seed);
  const base = ["--fake", "--model", "fake", "--map", "factory", "--set", "hidden", "--hidden-seed-file", seedFile, "--hidden-commitments", file, "--limit", "1", "--out", dir];
  const a = await bench(base);
  assert.match(a.stderr, /--confirm-hidden/);
  const b = await bench([...base, "--confirm-hidden"]);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(card(dir, "fake").set, "hidden");
});

test("every published hidden-split commitment still matches its generator, map and public sets", () => {
  for (const c of readCommitments(COMMIT_FILE).splits) {
    const E = loadEnvironment(c.environment);
    assert.equal(c.generator, generatorHash(), `${c.environment}: sim/tools/arena/hidden_split.mjs or reach.js changed after the commitment`);
    assert.equal(c.publicSets, publicSetsHash(E));
    assert.match(c.commitment, /^[0-9a-f]{64}$/);
  }
});
