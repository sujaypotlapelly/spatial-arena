import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeClient } from "../tools/ripple_client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tools = path.join(here, "../tools");
const run = (script, args) => spawnSync(process.execPath, [path.join(tools, script), ...args], { encoding: "utf8" });

test("bench runs a fake model and baselines, replays exactly, resumes, and reports", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "bench-test-"));
  const args = ["--fake", "--models", "fake", "--baselines", "--set", "dev", "--limit", "2", "--seeds", "1", "--samples", "2", "--levels", "C1,C3", "--out", out];
  const r1 = run("bench.mjs", args);
  assert.equal(r1.status, 0, r1.stderr);
  const eps = fs.readFileSync(path.join(out, "fake/episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(eps.length, 2 * 1 * 2 * 2); // scenarios × seeds × samples × levels
  assert.ok(eps.every((e) => e.replayOk && e.harnessHash && Number.isInteger(e.sample)));
  assert.deepEqual([...new Set(eps.map((e) => e.sample))].sort(), [0, 1]);
  assert.equal(fs.readFileSync(path.join(out, "baselines/episodes.jsonl"), "utf8").trim().split("\n").length, 3 * 2);
  const r2 = run("bench.mjs", args);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /8 already done, 0 to run/);
  const rep = run("bench_report.mjs", [out]);
  assert.equal(rep.status, 0, rep.stderr);
  const lb = JSON.parse(fs.readFileSync(path.join(out, "leaderboard.json")));
  const c1 = lb.cells.find((c) => c.condition === "fake@C1");
  assert.equal(c1.exact, c1.episodes);
  assert.equal(c1.K, 2);
  for (const id of ["fake", "baselines"]) {
    const file = path.join(out, id, "episodes.jsonl");
    fs.writeFileSync(file + ".gz", gzipSync(fs.readFileSync(file)));
    fs.unlinkSync(file);
  }
  const submitted = run("bench_report.mjs", [out]);
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "leaderboard.json"))).cells, lb.cells);
  assert.ok(fs.readFileSync(path.join(out, "LEADERBOARD.md"), "utf8").includes("| fake | C1 |"));
});

test("held-out runs need an explicit confirmation", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "bench-test-"));
  const r = run("bench.mjs", ["--fake", "--models", "fake", "--set", "heldout", "--limit", "1", "--out", out]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /confirm-heldout/);
});

test("real models need a host pin unless --allow-unpinned", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "bench-test-"));
  const reg = path.join(out, "models.json");
  fs.writeFileSync(reg, JSON.stringify({ models: [{ id: "x", model: "org/x", provider: null }] }));
  const r = run("bench.mjs", ["--registry", reg, "--models", "x", "--set", "dev", "--limit", "1", "--out", out]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no host pin/);
});

test("client sends the chosen model, pin, quantization and extra body", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-client-"));
  fs.writeFileSync(path.join(root, ".env"), `OPENROUTER_API_KEY=test-${Math.random()}\n`);
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ provider: "H", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: {} }) };
  });
  const pinned = makeClient({ root, model: "org/m", provider: "H", quantizations: ["bf16"], extraBody: { reasoning: { enabled: false } }, globalSlots: 0 });
  await pinned.chat([]);
  assert.equal(bodies[0].model, "org/m");
  assert.deepEqual(bodies[0].provider, { only: ["H"], allow_fallbacks: false, quantizations: ["bf16"] });
  assert.deepEqual(bodies[0].reasoning, { enabled: false });
  const unpinned = makeClient({ root, model: "org/m", provider: null, globalSlots: 0 });
  await unpinned.chat([]);
  assert.equal(bodies[1].provider, undefined);
  const legacy = makeClient({ root, globalSlots: 0 });
  await legacy.chat([]);
  assert.equal(bodies[2].model, "ricursiveai/ripple-65b-preview");
  assert.deepEqual(bodies[2].provider, { only: ["PrimeIntellect"], allow_fallbacks: false });
});
