// node --test sim/test/report.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReport, bootstrap, renderMarkdown } from "../tools/legacy/report.mjs";

const SEEDS = [1, 2, 3, 4];
const ep = (condition, id, reached, { belief = null, invalid = null, latencyMs = 1000, toolCalls = [] } = {}) => ({
  kind: "eval",
  condition,
  scenario: { id, start: "start", goal: "goal", bird: { strategy: "pursue" }, seeds: SEEDS },
  defender: { source: condition === "shortest" ? "comparator" : "ripple", invalid, provider: "HostA", latencyMs, toolCalls },
  belief,
  results: SEEDS.map((seed, i) => ({ seed, outcome: i < reached ? "reached" : "intercepted", reward: i < reached ? 1 : -1 })),
  summary: { reached, trials: 4, successRate: reached / 4 },
});
const good = { guess: "pursue", actual: "pursue", behaviorCorrect: true, familyCorrect: true, dangerError: 2, predictionError: 3 };
const bad = { guess: "patrol", actual: "pursue", behaviorCorrect: false, familyCorrect: false, dangerError: null, predictionError: 5 };
const session = (episodes, usingModel = true) => ({
  format: "ripple-arena/1",
  usingModel,
  evaluation: { conditions: [{ key: "shortest", label: "Shortest" }, { key: "raw", label: "Raw" }, { key: "tools", label: "Tools" }], episodes, metrics: {}, at: "x" },
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-test-"));
const write = (name, s) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(s));
  return p;
};
// Two replicate runs of the same two scenarios.
const runA = write("a.json", session([ep("shortest", "S1", 0), ep("shortest", "S2", 1), ep("raw", "S1", 2, { belief: bad }), ep("raw", "S2", 2, { belief: good }), ep("tools", "S1", 4, { belief: good, toolCalls: [{}, {}] }), ep("tools", "S2", 0, { invalid: "bad json" })]));
const runB = write("b.json", session([ep("shortest", "S1", 0), ep("shortest", "S2", 1), ep("raw", "S1", 1, { belief: bad }), ep("raw", "S2", 3, { belief: good }), ep("tools", "S1", 4, { belief: good }), ep("tools", "S2", 4, { belief: good })]));
const offline = write("offline-x.json", session([ep("raw", "S1", 4, { belief: good })]));
const heuristic = write("h.json", session([ep("raw", "S1", 4, { belief: good })], false));
const dup = write("dup.json", JSON.parse(fs.readFileSync(runA, "utf8")));

test("pools episodes by condition across replicate files and excludes offline/duplicates", () => {
  const r = buildReport([runA, runB, offline, heuristic, dup]);
  assert.equal(r.totals.files, 2);
  assert.deepEqual(r.excluded.map((x) => path.basename(x.path)).sort(), ["dup.json", "h.json", "offline-x.json"]);
  const raw = r.conditions.raw;
  assert.equal(raw.nFiles, 2);
  assert.equal(raw.nScenarios, 2);
  assert.equal(raw.nDecisions, 4);
  assert.equal(raw.nTrials, 16);
  assert.equal(raw.success.value, 8 / 16);
  assert.deepEqual(raw.perFile.map((f) => f.success), [0.5, 0.5]);
  assert.equal(raw.family.value, 0.5);
  assert.equal(raw.prediction.value, 4);
  assert.equal(r.conditions.shortest.family, null);
  assert.equal(r.baseline, "raw");
});

test("invalid decisions count as wrong beliefs", () => {
  const t = buildReport([runA, runB]).conditions.tools;
  assert.equal(t.invalid, 1);
  assert.equal(t.nDecisions, 4);
  assert.equal(t.family.value, 3 / 4); // not 3/3
  assert.equal(t.behavior.value, 3 / 4);
  assert.equal(t.danger.n, 3);
  assert.equal(t.toolCallsPerDecision, 0.5);
});

test("paired comparison averages replicates per scenario", () => {
  const p = buildReport([runA, runB]).comparisons.tools;
  assert.equal(p.nScenarios, 2);
  // S1: tools 8/8 vs raw 3/8; S2: tools 4/8 vs raw 5/8 -> mean diff (5/8 - 1/8)/2
  assert.equal(p.success.value, (5 / 8 - 1 / 8) / 2);
  // family: S1 1 - 0, S2 0.5 - 1
  assert.equal(p.family.value, (1 - 0.5) / 2);
});

test("bootstrap is deterministic and offline sessions stay separate when included", () => {
  const xs = [0, 1, 1, 0, 1, 0.5, 0.25];
  const stat = (s) => s.reduce((a, b) => a + b, 0) / s.length;
  assert.deepEqual(bootstrap(xs, stat), bootstrap(xs, stat));
  const r1 = buildReport([runA, runB]);
  const r2 = buildReport([runA, runB]);
  assert.deepEqual(r1.conditions, r2.conditions);
  assert.deepEqual(r1.comparisons, r2.comparisons);
  const withOff = buildReport([runA, heuristic], { includeOffline: true });
  assert.ok(withOff.conditions["offline:raw"]);
  assert.equal(withOff.conditions.raw.nDecisions, 2);
  assert.match(renderMarkdown(r1), /## What the data says/);
});
