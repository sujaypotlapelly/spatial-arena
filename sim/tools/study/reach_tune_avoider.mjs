// Methodology v3, test 1: give the hand-written reactive avoider the same
// search budget the code-as-policy loop gets, then keep the best on TRAIN.
// The loop evaluated 24 runs x 8 versions = 192 candidate programs on the 12
// training routes (seed 1 of each); here 192 random avoider parameter sets get
// exactly that, and the same rule picks the winner (progress, then reached).
// No API calls. Dev, held-out and test routes are never touched.
//   node sim/tools/study/reach_tune_avoider.mjs --n 192 --out runs/reach/avoider-tuned
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Reach } from "../../src/gym/reach.js";
import { loadEnvironment, pinScenarios } from "../benchmark_env.mjs";
import { runEpisode } from "../../src/gym/core.js";
import { reactiveReach, AVOIDER_DEFAULTS } from "../../src/gym/reach_agents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const N = Number(opt("--n", 192));
const outDir = path.resolve(opt("--out", path.join(root, "runs/reach/avoider-tuned")));
fs.mkdirSync(outDir, { recursive: true });

// --map: benchmark environment (sim/scenes/benchmark-sets.json); factory by default.
const E = loadEnvironment(opt("--map", "factory"));
pinScenarios(E);
const world = E.world;
const { train, dev } = E.sets;

// Sanity (factory only, where recordings exist): the default parameters must
// reproduce the recorded hand-written avoider.
if (E.name === "factory") {
  const recorded = fs.readFileSync(path.join(root, "runs/reach/baselines-dev/episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.condition === "reactive@C3");
  for (const e of recorded.slice(0, 8)) {
    const sc = dev.find((s) => s.id === e.scenario);
    const ep = await runEpisode(new Reach(world, sc, e.seed, "C3"), reactiveReach(world, sc));
    if (JSON.stringify(ep.result) !== JSON.stringify(e.result)) throw new Error(`defaults no longer reproduce ${e.scenario}/${e.seed}`);
  }
  console.log("defaults reproduce the recorded avoider (8/8 dev episodes)");
}

// Search space around the hand-written values (seeded, so it's repeatable).
let s = 20261115;
const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const U = (lo, hi) => lo + (hi - lo) * rand();
const sample = () => ({
  minFree: +U(0.5, 2.5).toFixed(2),
  freeWeight: +U(0, 2).toFixed(2),
  freeCap: +U(2, 12).toFixed(1),
  stick: +U(0, 0.6).toFixed(2),
  maxSpeed: +U(1.5, 5.5).toFixed(2),
  margin: +U(0.2, 1.5).toFixed(2),
  climb: +U(0.3, 2).toFixed(2),
});

async function score(params) {
  let reached = 0, progress = 0;
  for (const sc of train) {
    const ep = await runEpisode(new Reach(world, sc, sc.seeds[0], "C3"), reactiveReach(world, sc, params));
    reached += ep.result.outcome === "reached" ? 1 : 0;
    progress += Math.max(0, 1 - ep.result.minGoalDist / sc.straight_m);
  }
  return { reached, progress: progress / train.length };
}

const log = fs.createWriteStream(path.join(outDir, "search.jsonl"));
const rows = [];
const base = { i: 0, params: AVOIDER_DEFAULTS, ...(await score(AVOIDER_DEFAULTS)) };
rows.push(base);
log.write(JSON.stringify(base) + "\n");
console.log(`defaults on train: reached ${base.reached}/12, progress ${Math.round(base.progress * 100)}%`);
for (let i = 1; i <= N; i++) {
  const params = sample();
  const r = { i, params, ...(await score(params)) };
  rows.push(r);
  log.write(JSON.stringify(r) + "\n");
  if (i % 24 === 0) console.log(`${i}/${N} sampled; best so far reached ${Math.max(...rows.map((x) => x.reached))}/12`);
}
log.end();
// Same rule as the program loop: progress, then reached, then earliest.
const best = [...rows].sort((a, b) => b.progress - a.progress || b.reached - a.reached || a.i - b.i)[0];
fs.writeFileSync(path.join(outDir, "best.json"), JSON.stringify({ rule: "best TRAIN progress, then reached, then earliest", candidates: rows.length, best }, null, 1));
console.log(`best on train: #${best.i} reached ${best.reached}/12, progress ${Math.round(best.progress * 100)}%`, JSON.stringify(best.params));
