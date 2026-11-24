// Improvement-over-time curves for code as policy: every program version of
// every run, scored on TRAIN (what the model saw) and on DEV (never seen; this
// is analysis only and did not influence which version was frozen).
// Local simulation only, no API calls.
//   node sim/tools/study/reach_cap_report.mjs runs/reach/cap
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../../src/world.js";
import { Reach, makeReachSets } from "../../src/gym/reach.js";
import { runEpisode } from "../../src/gym/core.js";
import { programController, programRandomSeed } from "../../src/gym/policy_sandbox.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const dir = path.resolve(process.argv[2]);
// Re-fly each program the way its run flew it (plan.json records it; runs from before that are "legacy").
const planFile = path.join(dir, "plan.json");
const RANDOM = (fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, "utf8")).programRandom : null) ?? "legacy";
const world = new World(JSON.parse(fs.readFileSync(path.join(here, "../../maps/factory-full.json"))));
const sets = makeReachSets(world);

async function score(code, scenarios, nSeeds) {
  let reached = 0, progress = 0, n = 0;
  for (const sc of scenarios)
    for (const seed of sc.seeds.slice(0, nSeeds)) {
      const ep = await runEpisode(new Reach(world, sc, seed, "C3"), programController(code, { seed, randomSeed: programRandomSeed(seed, RANDOM) }));
      n++;
      if (ep.result.outcome === "reached") reached++;
      progress += Math.max(0, 1 - ep.result.minGoalDist / sc.straight_m);
    }
  return { reached: reached / n, progress: progress / n, n };
}

const runs = fs.readdirSync(dir).filter((d) => /^run\d+$/.test(d)).sort();
const out = { runs: [] };
for (const r of runs) {
  const curve = JSON.parse(fs.readFileSync(path.join(dir, r, "curve.json")));
  const rows = [];
  for (const c of curve.curve) {
    const code = fs.readFileSync(path.join(dir, r, `v${c.version}.js`), "utf8");
    const dev = await score(code, sets.dev, 2);
    rows.push({ version: c.version, trainReached: c.reached / 12, trainProgress: c.progress, devReached: dev.reached, devProgress: dev.progress, compileError: c.compileError, codeChars: c.codeChars });
    console.log(`${r} v${c.version}: train ${c.reached}/12 (${Math.round(c.progress * 100)}%)  dev ${Math.round(dev.reached * 100)}% reached (${Math.round(dev.progress * 100)}% progress)${c.version === curve.best ? "  <- frozen (best on train)" : ""}`);
  }
  out.runs.push({ run: r, best: curve.best, rows });
}
fs.writeFileSync(path.join(dir, "curves.json"), JSON.stringify(out, null, 1));
console.log("wrote", path.relative(root, path.join(dir, "curves.json")));
