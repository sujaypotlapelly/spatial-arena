// Integrity check 1: do practice (train) and test routes share waypoints?
// Counts endpoint overlap in the published route sets and splits the recorded
// v3 factory test flights into "shares an endpoint with a practice route" and
// "shares none". Reads recorded results only: no flights, no model calls.
//   node sim/tools/study/integrity_overlap.mjs --runs <checkout>/runs
// Writes <runs>/integrity/overlap.json and prints the tables.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootCI, mean } from "../reach_metrics.mjs";
import { rng } from "../../src/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const RUNS = path.resolve(opt("--runs", path.join(root, "runs")));

// ---- 1. overlap counts, from the pinned scenario files ----
export function overlap(sets, against = "train", of = "test") {
  const ends = new Set(sets[against].flatMap((s) => [s.start, s.goal]));
  const starts = new Set(sets[against].map((s) => s.start));
  const goals = new Set(sets[against].map((s) => s.goal));
  const rows = sets[of].map((s) => ({
    id: s.id,
    shared: ends.has(s.start) || ends.has(s.goal),
    goalAtTrainEndpoint: ends.has(s.goal),
    goalIsTrainGoal: goals.has(s.goal),
    startIsTrainStart: starts.has(s.start),
    bothEndsShared: ends.has(s.start) && ends.has(s.goal),
  }));
  const n = (k) => rows.filter((r) => r[k]).length;
  return { n: rows.length, shared: n("shared"), goalAtTrainEndpoint: n("goalAtTrainEndpoint"), goalIsTrainGoal: n("goalIsTrainGoal"), startIsTrainStart: n("startIsTrainStart"), bothEndsShared: n("bothEndsShared"), rows };
}
const counts = {};
for (const map of ["factory", "residential", "canyon"]) {
  const file = map === "factory" ? "reach-factory-test.json" : `reach-${map}.json`;
  const pinned = JSON.parse(fs.readFileSync(path.join(root, "sim/scenarios", file), "utf8"));
  const train = map === "factory" ? JSON.parse(fs.readFileSync(path.join(root, "sim/scenarios/reach-factory.json"), "utf8")) : pinned;
  const sets = { train: train.train, dev: train.dev, heldout: train.heldout, test: pinned.test };
  counts[map] = Object.fromEntries(["dev", "heldout", "test"].map((k) => [k, (({ rows, ...c }) => c)(overlap(sets, "train", k))]));
  if (map === "factory") counts.factoryRows = overlap(sets, "train", "test").rows;
}
console.log("Routes sharing a start or goal waypoint with a train route:");
for (const map of ["factory", "residential", "canyon"]) for (const k of ["dev", "heldout", "test"]) { const c = counts[map][k]; console.log(`  ${map.padEnd(12)} ${k.padEnd(8)} ${c.shared}/${c.n} share an endpoint; ${c.goalAtTrainEndpoint} have their goal at a train endpoint; ${c.bothEndsShared} share both`); }

// ---- 2. the recorded v3 factory test flights, split ----
const shared = Object.fromEntries(counts.factoryRows.map((r) => [r.id, r]));
const load = (dir, cond) => fs.readFileSync(path.join(RUNS, "reach", dir, "episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.condition === cond)
  .map((e) => ({ scenario: e.scenario, seed: e.seed, reached: e.result.outcome === "reached" ? 1 : 0, progress: e.progress }));
const sel = JSON.parse(fs.readFileSync(path.join(RUNS, "reach/v3-selection.json"), "utf8"));
const tag = (run) => run.replace("/", "-");
const CTL = {
  "Map + A* planner (upper bound)": load("v3test-baselines", "planner@C1"),
  [`Program Ripple wrote (${sel.program.run})`]: load(`v3test-prog-${tag(sel.program.run)}`, "program@C3"),
  "All 24 programs, pooled": sel.programs.flatMap((p) => load(`v3test-prog-${tag(p.run)}`, "program@C3")),
  "Avoider, tuned on train": load("v3test-baselines", "tuned@C3"),
  "Avoider, hand-written": load("v3test-baselines", "reactive@C3"),
  [`Ripple, second by second (${sel.perSecond.name})`]: load(`v3test-ripple-${sel.perSecond.name}`, "ripple@C3"),
  "Ripple, second by second (plain prompt)": load("v3test-ripple-v0", "ripple@C3"),
  "Straight-line flyer": load("v3test-baselines", "straight@C2"),
};
const rate = (rs) => mean(rs.map((r) => r.reached));
// Difference between two disjoint groups of routes: bootstrap each group's routes separately.
function diffCI(a, b, B = 10000, seed = 2026) {
  const ga = Object.values(Object.groupBy(a, (r) => r.scenario)), gb = Object.values(Object.groupBy(b, (r) => r.scenario));
  const rand = rng(seed).next;
  const draw = (g) => rate(g.flatMap(() => g[Math.floor(rand() * g.length)]));
  const vals = [];
  for (let i = 0; i < B; i++) vals.push(draw(ga) - draw(gb));
  vals.sort((x, y) => x - y);
  return [vals[Math.floor(0.025 * B)], vals[Math.floor(0.975 * B)]];
}
const cell = (rs) => ({ reached: rs.filter((r) => r.reached).length, flights: rs.length, routes: new Set(rs.map((r) => r.scenario)).size, rate: rate(rs), ci: bootCI(rs, rate) });
const split = {};
const pct = (x) => `${Math.round(x * 100)}%`;
const show = (c) => `${c.reached}/${c.flights} = ${pct(c.rate)} [${pct(c.ci[0])}, ${pct(c.ci[1])}]`;
console.log("\nv3 factory test, reached, split by whether the route shares an endpoint with a train route (95% CI, bootstrap over routes):");
for (const [name, rs] of Object.entries(CTL)) {
  const S = rs.filter((r) => shared[r.scenario].shared), N = rs.filter((r) => !shared[r.scenario].shared), G = rs.filter((r) => shared[r.scenario].goalAtTrainEndpoint);
  split[name] = { all: cell(rs), shared: cell(S), none: cell(N), goalAtTrainEndpoint: cell(G), sharedMinusNone: rate(S) - rate(N), sharedMinusNoneCI: diffCI(S, N) };
  const s = split[name];
  console.log(`  ${name}\n    all ${show(s.all)} | shared ${show(s.shared)} | none ${show(s.none)} | goal at train endpoint ${show(s.goalAtTrainEndpoint)} | shared minus none ${Math.round(s.sharedMinusNone * 100)} pp [${Math.round(s.sharedMinusNoneCI[0] * 100)}, ${Math.round(s.sharedMinusNoneCI[1] * 100)}]`);
}
// ---- 3. the v4 outdoor test flights (residential, canyon), split the same way ----
const v4sel = JSON.parse(fs.readFileSync(path.join(RUNS, "v4-selection.json"), "utf8"));
const v4split = {};
for (const map of ["residential", "canyon"]) {
  const pinned = JSON.parse(fs.readFileSync(path.join(root, "sim/scenarios", `reach-${map}.json`), "utf8"));
  const sh = Object.fromEntries(overlap({ train: pinned.train, test: pinned.test }).rows.map((r) => [r.id, r]));
  const L = (dir, cond) => fs.readFileSync(path.join(RUNS, "v4test", `reach-${map}`, dir, "episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.condition === cond).map((e) => ({ scenario: e.scenario, seed: e.seed, reached: e.result.outcome === "reached" ? 1 : 0 }));
  const pick = v4sel.cells[`reach-${map}`].program;
  const C = {
    [`Program Ripple wrote here (${pick.run})`]: L(`prog-${pick.run}`, "program@C3"),
    "Avoider, tuned on train": L("baselines", "tuned@C3"),
    "Avoider, hand-written": L("baselines", "reactive@C3"),
    "Straight-line flyer": L("baselines", "straight@C2"),
  };
  v4split[map] = {};
  console.log(`\nv4 ${map} test, reached, split the same way:`);
  for (const [name, rs] of Object.entries(C)) {
    const S = rs.filter((r) => sh[r.scenario].shared), N = rs.filter((r) => !sh[r.scenario].shared);
    const o = (v4split[map][name] = { all: cell(rs), shared: cell(S), none: cell(N), sharedMinusNone: rate(S) - rate(N), sharedMinusNoneCI: diffCI(S, N) });
    console.log(`  ${name}\n    all ${show(o.all)} | shared ${show(o.shared)} | none ${show(o.none)} | shared minus none ${Math.round(o.sharedMinusNone * 100)} pp [${Math.round(o.sharedMinusNoneCI[0] * 100)}, ${Math.round(o.sharedMinusNoneCI[1] * 100)}]`);
  }
}

// How alike are a route's two wind seeds? (integrity check 2 uses this)
const seedAgreement = {};
for (const [name, rs] of Object.entries(CTL)) {
  if (name.startsWith("All 24")) continue;
  const by = Object.values(Object.groupBy(rs, (r) => r.scenario));
  seedAgreement[name] = { same: by.filter((g) => g.every((r) => r.reached === g[0].reached)).length, routes: by.length };
}
console.log("\nRoutes where both wind seeds gave the same outcome:");
for (const [name, a] of Object.entries(seedAgreement)) console.log(`  ${name}: ${a.same}/${a.routes}`);
const out = path.join(RUNS, "integrity");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "overlap.json"), JSON.stringify({ at: new Date().toISOString(), counts, split, v4split, seedAgreement }, null, 1));
console.log("\nwrote", path.join(out, "overlap.json"));
