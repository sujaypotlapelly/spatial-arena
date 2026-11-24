#!/usr/bin/env node
// Methodology v4 (docs/PREREGISTRATION_V4.md): give the sensor-only mission
// baselines the same candidate budget as the coding loop, then keep the best
// on TRAIN. The loop evaluates 24 runs x 8 versions = 192 programs on the 12
// training missions (wind seed 1); here the default parameters plus 192
// random parameter sets get exactly that, and the same rule picks the winner
// (successes, then progress, then earliest). No API calls. Dev and test
// missions are never touched.
//   node sim/tools/study/mission_tune_baseline.mjs --map canyon --task search \
//     --out runs/missions/v4tune/canyon-search
import fs from "node:fs";
import path from "node:path";
import { v } from "../../src/world.js";
import { runEpisode } from "../../src/gym/core.js";
import { RescueMission } from "../../src/gym/rescue_tasks.js";
import { explorer, padSeeker, EXPLORER_DEFAULTS, PADSEEKER_DEFAULTS } from "../../src/gym/mission_agents.js";
import { loadEnvironment, root } from "../benchmark_env.mjs";

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const E = loadEnvironment(opt("--map", "factory"));
const task = opt("--task", "search");
const N = Number(opt("--n", 192));
const DT = Number(opt("--dt", 1));
const outDir = path.resolve(opt("--out", path.join(root, "runs/missions/v4tune", `${E.name}-${task}`)));
fs.mkdirSync(outDir, { recursive: true });
const train = JSON.parse(fs.readFileSync(path.join(root, `sim/scenarios/mission-${E.name}-${task}.json`), "utf8")).train;
const SUCCESS = task === "search" ? "found" : "delivered";
const make = task === "search" ? explorer : padSeeker;
const DEFAULTS = task === "search" ? EXPLORER_DEFAULTS : PADSEEKER_DEFAULTS;

let s = 20261116;
const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const U = (lo, hi, d = 2) => +(lo + (hi - lo) * rand()).toFixed(d);
const sample = () => (task === "search"
  ? { minFree: U(0.5, 2.5), look: U(1, 8, 1), cell: U(1, 4, 1), freeWeight: U(0, 2), stick: U(0, 0.8), maxSpeed: U(1.5, 5.5), margin: U(0.2, 1.5), agl: U(0.5, 2.5) }
  : { minFree: U(0.5, 2.5), freeWeight: U(0, 2), freeCap: U(2, 12, 1), stick: U(0, 0.6), maxSpeed: U(1.5, 5.5), margin: U(0.2, 1.5), holdRadius: U(0.5, 2), holdGain: U(0.3, 2), holdSpeed: U(0.1, 0.34) });

const goalOf = (m) => (task === "search" ? m.targetPosition : v.add(m.targetPosition, [0, m.releaseHeight, 0]));
async function score(params) {
  let success = 0, progress = 0;
  for (const m of train) {
    const ep = await runEpisode(new RescueMission(E.world, m, m.seeds[0]), make(E.world, m, params), { dt: DT });
    success += ep.result.outcome === SUCCESS ? 1 : 0;
    const g = goalOf(m), d0 = v.dist(m.start, g);
    progress += Math.max(0, 1 - Math.min(...ep.frames.map((f) => v.dist([f[1], f[2], f[3]], g))) / d0);
  }
  return { success, progress: progress / train.length };
}

const log = fs.createWriteStream(path.join(outDir, "search.jsonl"));
const rows = [];
const t0 = Date.now();
const base = { i: 0, params: DEFAULTS, ...(await score(DEFAULTS)) };
rows.push(base);
log.write(JSON.stringify(base) + "\n");
console.log(`${E.name} ${task}: defaults on train ${SUCCESS} ${base.success}/${train.length}, progress ${Math.round(base.progress * 100)}%`);
for (let i = 1; i <= N; i++) {
  const params = sample();
  const r = { i, params, ...(await score(params)) };
  rows.push(r);
  log.write(JSON.stringify(r) + "\n");
  if (i % 48 === 0) console.log(`${i}/${N} sampled; best so far ${Math.max(...rows.map((x) => x.success))}/${train.length} [${Math.round((Date.now() - t0) / 1000)} s]`);
}
log.end();
const best = [...rows].sort((a, b) => b.success - a.success || b.progress - a.progress || a.i - b.i)[0];
fs.writeFileSync(path.join(outDir, "best.json"), JSON.stringify({ map: E.name, task, rule: `best TRAIN ${SUCCESS} count, then progress, then earliest`, candidates: rows.length, dt: DT, best }, null, 1));
console.log(`best on train: #${best.i} ${SUCCESS} ${best.success}/${train.length}, progress ${Math.round(best.progress * 100)}%`, JSON.stringify(best.params));
