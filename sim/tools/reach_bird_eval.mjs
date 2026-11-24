// Reach with a bird (sim/src/gym/reach_bird.js): fly controllers on the bird
// scenario sets (train or dev; there is no bird test set) with no model calls.
//   node sim/tools/reach_bird_eval.mjs --set dev --out <dir> \
//     --conditions reactive,birdaware,keepaway,program=legacy:<path>,program=separate:<path>
//   node sim/tools/reach_bird_eval.mjs --verify <dir> [<dir> ...]
// Conditions:
//   reactive   reactiveReach (reach_agents.js), senses only, ignores obs.bird
//   birdaware  birdAwareReach (reach_bird_agents.js), senses only, uses obs.bird
//   hover      holds still at the launch point
//   keepaway   PRIVILEGED map + A* + true bird position (admission planner), upper bound only
//   program=<legacy|separate>:<file>  a policy(obs, memory) program; legacy gives
//              Math.random the wind seed (how the published cap2 programs ran)
// --no-bird flies the same routes with the bird removed (a control).
// Every flight is re-flown from its recorded commands and must reproduce
// exactly; episodes.jsonl keeps the commands and frames (with the bird) for
// rendering.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runEpisode, replayEpisode } from "../src/gym/core.js";
import { ReachBird } from "../src/gym/reach_bird.js";
import { reactiveReach } from "../src/gym/reach_agents.js";
import { birdAwareReach, plannerKeepAway } from "../src/gym/reach_bird_agents.js";
import { programController, programRandomSeed } from "../src/gym/policy_sandbox.js";
import { loadFactory, loadBirdSets } from "./reach_bird_scenarios.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../..");
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);

export function makeController(cond, world, sc, seed) {
  if (cond === "reactive") return reactiveReach(world, sc);
  if (cond === "birdaware") return birdAwareReach(world, sc);
  if (cond === "hover") return async () => ({ command: { velocity: [0, 0, 0] }, say: "hover" });
  if (cond === "keepaway") return plannerKeepAway(world, sc, sc.admission?.keepaway_planner?.setting ?? {});
  const m = /^program=(legacy|separate):(.+)$/.exec(cond);
  if (m) return programController(fs.readFileSync(m[2], "utf8"), { seed, randomSeed: programRandomSeed(seed, m[1]) });
  throw new Error(`unknown condition ${cond}`);
}

export async function flyOne(world, sc, seed, cond, { noBird = false } = {}) {
  const opts = noBird ? { bird: false } : {};
  const ep = await runEpisode(new ReachBird(world, sc, seed, opts), makeController(cond, world, sc, seed));
  const re = replayEpisode(new ReachBird(world, sc, seed, opts), ep.decisions);
  return { ep, exact: JSON.stringify(re) === JSON.stringify(ep.result) };
}

// Practice score per flight (reach_bird_cap.mjs selects on it): reached 1;
// timed out 0.5 x progress; caught 0.25 x progress, where progress = 1 -
// closest distance to the goal / straight-line distance.
export const flightScore = (outcome, progress) => (outcome === "reached" ? 1 : outcome === "timeout" ? 0.5 * progress : 0.25 * progress);
export const progressOf = (sc, result) => Math.max(0, 1 - result.minGoalDist / sc.straight_m);

export function tally(rows) {
  const n = rows.length;
  const c = (o) => rows.filter((r) => r.result.outcome === o).length;
  const out = { n, reached: c("reached"), caught: c("caught"), timeout: c("timeout"), contacts: rows.reduce((a, r) => a + r.result.contacts, 0), exact: rows.filter((r) => r.exact).length };
  if (rows.every((r) => r.score !== undefined)) out.score = Math.round(rows.reduce((a, r) => a + r.score, 0) * 1000) / 1000;
  return out;
}

async function verify(dirs) {
  const { world } = loadFactory();
  const S = loadBirdSets();
  const scen = Object.fromEntries([...S.train, ...S.train_v1, ...S.dev].map((s) => [s.id, s]));
  let total = 0, ok = 0;
  for (const dir of dirs) {
    const f = path.join(dir, "episodes.jsonl");
    if (!fs.existsSync(f)) continue;
    let n = 0, k = 0;
    for (const line of fs.readFileSync(f, "utf8").trim().split("\n")) {
      const e = JSON.parse(line);
      n++;
      const re = replayEpisode(new ReachBird(world, scen[e.scenario], e.seed, e.noBird ? { bird: false } : {}), e.decisionLog);
      if (JSON.stringify(re) === JSON.stringify(e.result)) k++;
      else console.log(`  mismatch ${dir} ${e.condition} ${e.scenario} ${e.seed}`);
    }
    console.log(`${dir}: ${k}/${n} exact`);
    total += n;
    ok += k;
  }
  console.log(`ALL: ${ok}/${total} exact`);
  if (ok !== total) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (args[0] === "--verify") { await verify(args.slice(1)); process.exit(); }
  const setName = opt("--set", "dev");
  if (!["train", "train_v1", "dev"].includes(setName)) throw new Error("--set must be train, train_v1 or dev (there is no bird test set)");
  const noBird = args.includes("--no-bird");
  const { world } = loadFactory();
  const S = loadBirdSets();
  const scenarios = S[setName];
  const conditions = opt("--conditions", "reactive,birdaware,keepaway").split(",");
  const outDir = path.resolve(opt("--out", path.join(root, "runs/reach-bird", `${setName}-${Date.now()}`)));
  fs.mkdirSync(outDir, { recursive: true });
  const out = fs.createWriteStream(path.join(outDir, "episodes.jsonl"));
  const rows = [];
  for (const cond of conditions) {
    for (const sc of scenarios)
      for (const seed of sc.seeds) {
        const { ep, exact } = await flyOne(world, sc, seed, cond, { noBird });
        const row = { condition: cond, scenario: sc.id, seed, strategy: sc.bird.strategy, noBird, result: ep.result, exact, score: Math.round(flightScore(ep.result.outcome, progressOf(sc, ep.result)) * 1000) / 1000, decisionLog: ep.decisions.map((d) => ({ t: d.t, command: d.command, ...(d.say ? { say: d.say } : {}), ...(d.error ? { error: d.error } : {}) })), frames: ep.frames };
        out.write(JSON.stringify(row) + "\n");
        rows.push(row);
      }
    const t = tally(rows.filter((r) => r.condition === cond));
    console.log(`${cond.replace(/:.*cap2\/run3\/best\.js$/, ":cap2/run3/best.js")}${noBird ? " (no bird)" : ""}: n=${t.n} reached ${t.reached}, caught ${t.caught}, timeout ${t.timeout}, score ${t.score}, replay exact ${t.exact}/${t.n}`);
  }
  out.end();
  const summary = { at: new Date().toISOString(), set: setName, noBird, map: "factory", scenarioFile: "sim/scenarios/reach-bird-factory.json", conditions: Object.fromEntries(conditions.map((c) => [c, tally(rows.filter((r) => r.condition === c))])) };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
  if (rows.some((r) => !r.exact)) { console.error("some flights did not replay exactly"); process.exitCode = 1; }
}
