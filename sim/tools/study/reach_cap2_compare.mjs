// Practice loop v1 (reach_cap.mjs) against v2 (reach_cap2.mjs): each run's
// frozen program (best on train) flown on the DEV routes. Local simulation
// only, no API calls. Dev plays no part in either loop; this is the readout.
//   node sim/tools/study/reach_cap2_compare.mjs --baseline runs/reach/cap-agentic/baseline \
//     --agentic runs/reach/cap-agentic/agentic --out runs/reach/cap-agentic/compare.json
// Intervals are 95% bootstrap intervals clustered by route (reach_metrics.mjs
// bootCI): a route's flights, across runs and winds, are resampled together.
import fs from "node:fs";
import path from "node:path";
import { Reach } from "../../src/gym/reach.js";
import { runEpisode } from "../../src/gym/core.js";
import { programController, programRandomSeed } from "../../src/gym/policy_sandbox.js";
import { loadEnvironment } from "../benchmark_env.mjs";
import { bootCI, mean } from "../reach_metrics.mjs";
import { heightLock } from "./height_lock.mjs";

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const SEEDS = Number(opt("--seeds", 2));
const arms = [["v1 one-shot", opt("--baseline")], ["v2 agentic", opt("--agentic")]].filter(([, d]) => d).map(([name, d]) => ({ name, dir: path.resolve(d) }));
if (!arms.length) throw new Error("give --baseline and/or --agentic");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const sd = (xs) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : 0; };

export async function flyDev(E, code, random, seeds) {
  const rows = [];
  for (const sc of E.sets.dev) for (const seed of sc.seeds.slice(0, seeds)) {
    if (!code) { rows.push({ scenario: sc.id, seed, reached: 0, progress: 0, contacts: null }); continue; }
    const ep = await runEpisode(new Reach(E.world, sc, seed, "C3"), programController(code, { seed, randomSeed: programRandomSeed(seed, random) }));
    rows.push({ scenario: sc.id, seed, reached: ep.result.outcome === "reached" ? 1 : 0, progress: Math.max(0, 1 - ep.result.minGoalDist / sc.straight_m), contacts: ep.result.contacts });
  }
  return rows;
}

const out = { at: new Date().toISOString(), set: "dev", seedsPerRoute: SEEDS, arms: [] };
for (const arm of arms) {
  const plan = readJson(path.join(arm.dir, "plan.json"));
  const E = loadEnvironment(plan.map);
  const calls = readLines(path.join(arm.dir, "calls.jsonl")).filter((c) => c.role === "programmer");
  const runDirs = fs.readdirSync(arm.dir).filter((d) => /^run\d+$/.test(d)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  const runs = [];
  for (const r of runDirs) {
    const run = Number(r.slice(3));
    const curve = readJson(path.join(arm.dir, r, "curve.json"));
    const bestRow = curve.curve.find((c) => c.version === curve.best) ?? null;
    const bestFile = path.join(arm.dir, r, "best.js");
    const code = curve.best != null && fs.existsSync(bestFile) && !bestRow?.compileError ? fs.readFileSync(bestFile, "utf8") : null;
    const rows = (await flyDev(E, code, plan.programRandom ?? "legacy", SEEDS)).map((x) => ({ ...x, run }));
    const mine = calls.filter((c) => c.run === run);
    const nTrain = E.sets.train.length * (plan.trainSeeds ?? 1);
    runs.push({
      run, frozen: curve.best, versions: curve.curve.length,
      trainReached: bestRow ? bestRow.reached / nTrain : 0, trainProgress: bestRow?.progress ?? 0,
      devReached: mean(rows.map((x) => x.reached)), devReachedCount: rows.reduce((a, x) => a + x.reached, 0), devProgress: mean(rows.map((x) => x.progress)), devFlights: rows.length,
      modelCalls: mine.length, toolCalls: curve.curve.reduce((a, c) => a + (c.toolCalls ?? 0), 0) || null,
      promptTokens: mine.reduce((a, c) => a + (c.usage?.prompt_tokens || 0), 0), completionTokens: mine.reduce((a, c) => a + (c.usage?.completion_tokens || 0), 0),
      cachedPromptTokens: mine.reduce((a, c) => a + (c.usage?.prompt_tokens_details?.cached_tokens || 0), 0),
      costUsd: mine.reduce((a, c) => a + (c.usage?.cost || 0), 0),
      modelSeconds: Math.round(mine.reduce((a, c) => a + (c.latencyMs || 0), 0) / 1000),
      wallSeconds: curve.wallSeconds ?? null,
      heightLock: code ? heightLock(code) : null,
      rows,
    });
  }
  const all = runs.flatMap((r) => r.rows);
  const rate = (k) => (xs) => mean(xs.map((x) => x[k]));
  out.arms.push({
    name: arm.name, dir: arm.dir, plan: { tool: plan.tool ?? "reach_cap", runs: plan.runs, iters: plan.iters ?? null, rounds: plan.rounds ?? null, callsPerRound: plan.callsPerRound ?? null, tokenBudget: plan.tokenBudget ?? null },
    flights: all.length, reachedCount: all.reduce((a, x) => a + x.reached, 0),
    reached: rate("reached")(all), reachedCI: bootCI(all, rate("reached")),
    progress: rate("progress")(all), progressCI: bootCI(all, rate("progress")),
    heightLocked: runs.filter((r) => r.heightLock?.locked).length,
    perRunReached: runs.map((r) => r.devReached), perRunProgress: runs.map((r) => r.devProgress),
    reachedSpread: { min: Math.min(...runs.map((r) => r.devReached)), max: Math.max(...runs.map((r) => r.devReached)), sd: sd(runs.map((r) => r.devReached)) },
    progressSpread: { min: Math.min(...runs.map((r) => r.devProgress)), max: Math.max(...runs.map((r) => r.devProgress)), sd: sd(runs.map((r) => r.devProgress)) },
    tokensPerRun: mean(runs.map((r) => r.promptTokens + r.completionTokens)), promptPerRun: mean(runs.map((r) => r.promptTokens)), completionPerRun: mean(runs.map((r) => r.completionTokens)),
    costPerRunUsd: mean(runs.map((r) => r.costUsd)), modelSecondsPerRun: mean(runs.map((r) => r.modelSeconds)), wallSecondsPerRun: runs.every((r) => r.wallSeconds != null) ? mean(runs.map((r) => r.wallSeconds)) : null,
    runs,
  });
}

// Difference between the arms, clustered by route: both arms fly the same
// routes and winds, so a resampled route brings its flights from both arms.
if (out.arms.length === 2) {
  const [A, B] = out.arms;
  const tag = (arm, k) => arm.runs.flatMap((r) => r.rows.map((x) => ({ ...x, arm: k })));
  const both = [...tag(A, 0), ...tag(B, 1)];
  const diff = (key) => (xs) => (mean(xs.filter((x) => x.arm === 1).map((x) => x[key])) ?? 0) - (mean(xs.filter((x) => x.arm === 0).map((x) => x[key])) ?? 0);
  out.difference = { note: `${B.name} minus ${A.name}`, reached: diff("reached")(both), reachedCI: bootCI(both, diff("reached")), progress: diff("progress")(both), progressCI: bootCI(both, diff("progress")) };
}

const pct = (x) => `${Math.round(x * 100)}%`;
const k = (x) => `${(x / 1000).toFixed(1)}k`;
for (const a of out.arms) {
  console.log(`\n${a.name} (${path.basename(a.dir)}): ${a.runs.length} runs, ${a.flights} dev flights`);
  console.log(`  reached ${a.reachedCount}/${a.flights} = ${pct(a.reached)} [${pct(a.reachedCI[0])}, ${pct(a.reachedCI[1])}], progress ${pct(a.progress)} [${pct(a.progressCI[0])}, ${pct(a.progressCI[1])}]`);
  console.log(`  across runs: reached ${pct(a.reachedSpread.min)} to ${pct(a.reachedSpread.max)} (SD ${(a.reachedSpread.sd * 100).toFixed(1)} points), progress ${pct(a.progressSpread.min)} to ${pct(a.progressSpread.max)} (SD ${(a.progressSpread.sd * 100).toFixed(1)} points)`);
  console.log(`  height-locked frozen programs (height_lock.mjs probe): ${a.heightLocked} of ${a.runs.length}`);
  for (const r of a.runs) console.log(`  run ${r.run}: frozen v${r.frozen} of ${r.versions}, train ${pct(r.trainReached)} reached / ${pct(r.trainProgress)} progress, dev ${r.devReachedCount}/${r.devFlights} = ${pct(r.devReached)} reached / ${pct(r.devProgress)} progress, ${r.modelCalls} model calls${r.toolCalls ? `, ${r.toolCalls} tool calls` : ""}, tokens ${k(r.promptTokens)} in + ${k(r.completionTokens)} out = ${k(r.promptTokens + r.completionTokens)}, $${r.costUsd.toFixed(4)}, model time ${r.modelSeconds} s${r.wallSeconds != null ? `, wall ${r.wallSeconds} s` : ""}${r.heightLock?.locked ? `, HEIGHT-LOCKED (drift ${JSON.stringify(r.heightLock.drifts)} m)` : ""}`);
}
if (out.difference) console.log(`\n${out.difference.note}: reached ${(out.difference.reached * 100).toFixed(1)} points [${(out.difference.reachedCI[0] * 100).toFixed(1)}, ${(out.difference.reachedCI[1] * 100).toFixed(1)}], progress ${(out.difference.progress * 100).toFixed(1)} points [${(out.difference.progressCI[0] * 100).toFixed(1)}, ${(out.difference.progressCI[1] * 100).toFixed(1)}]`);
if (opt("--out")) {
  fs.writeFileSync(path.resolve(opt("--out")), JSON.stringify({ ...out, arms: out.arms.map((a) => ({ ...a, runs: a.runs.map(({ rows, ...r }) => ({ ...r, rows: rows.map(({ run, ...x }) => x) })) })) }, null, 1));
  console.log("wrote", opt("--out"));
}
