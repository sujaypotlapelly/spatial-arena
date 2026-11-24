// Non-LLM baselines on the 12 held-out scenarios, to check whether Ripple's
// lead over the shortest-path comparator is just "turning the dodge
// controller on". No model calls.
//   node sim/tools/legacy/baseline_eval.mjs [--workers 8] [--out runs/experiments/baselines-<ts>]
//
// Conditions (same scenarios, same 4 seeds, same metric definitions as
// Arena.evaluate):
//   shortest       existing comparator (controller OFF)
//   shortest_ctrl  shortest route, controller ON with fixed sensible settings
//   heuristic      heuristicDefender's bird-aware branch (max-clearance route
//                  from the observed bird track + controller ON)
//   tuned          best single (route selector + controller) chosen by a grid
//                  sweep on the TRAINING scenarios only, then applied to held-out
//   oracle_fixed   same sweep but picked on held-out itself (an upper bound for
//                  any fixed setting; NOT a fair baseline, reported for context)
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { World, routeMenu } from "../../src/world.js";
import { shortestPathPolicy, validateDefender } from "../../src/policy.js";
import { runEpisode, referenceLength } from "../../src/scenarios.js";
import { heuristicDefender } from "../../src/agents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const world = new World(JSON.parse(fs.readFileSync(path.join(here, "../../maps/building.json"))));

const FIXED_CTRL = { cruise_speed: 4.2, corner_slowdown: 0.6, avoidance_distance: 6, evade_strength: 0.6, replan_when_bird_nearby: true };

// Route selectors: "rank k" (k-th shortest in the menu, clamped to menu size)
// or "clearance" (heuristicDefender's bird-aware choice from the observed track).
const SELECTORS = [...Array.from({ length: 8 }, (_, i) => `rank${i + 1}`), "clearance"];
function selectRoute(sel, sc) {
  const menu = routeMenu(world, sc.start, sc.goal);
  if (sel === "clearance") {
    const id = heuristicDefender(world, sc, { strategy: "bird-aware" }).route_id;
    return menu.find((r) => r.id === id);
  }
  const k = Number(sel.slice(4));
  return menu[Math.min(k, menu.length) - 1];
}

function controllerGrid() {
  const out = [];
  for (const cruise_speed of [3.0, 3.5, 4.2, 4.8, 5.5])
    for (const corner_slowdown of [0.3, 0.6, 0.9]) {
      out.push({ cruise_speed, corner_slowdown, avoidance_distance: 0, evade_strength: 0, replan_when_bird_nearby: false });
      for (const avoidance_distance of [4, 6, 8, 10])
        for (const evade_strength of [0.4, 0.7, 1.0])
          for (const replan_when_bird_nearby of [false, true]) out.push({ cruise_speed, corner_slowdown, avoidance_distance, evade_strength, replan_when_bird_nearby });
    }
  return out;
}

function policyFor(sel, ctrl, sc) {
  const r = selectRoute(sel, sc);
  return { bird_behavior_guess: "unknown", predicted_bird_position: null, danger_point: null, route_id: r.id, route: r.route, ...ctrl, rationale: `${sel} + fixed controller` };
}

function tally(world, scenarios, sel, ctrl) {
  let reached = 0, intercepted = 0, crashed = 0, trials = 0, solved = 0;
  for (const sc of scenarios) {
    const { summary } = runEpisode(world, sc, policyFor(sel, ctrl, sc), { keepFrames: false });
    reached += summary.reached;
    intercepted += summary.intercepted;
    crashed += summary.crashed;
    trials += summary.trials;
    if (summary.successRate >= 0.5) solved++;
  }
  return { reached, intercepted, crashed, trials, solved };
}

// ---------------- stats ----------------
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// Same definitions as Arena.evaluate.
function metricsFrom(label, eps) {
  const trials = eps.flatMap((e) => e.results.map((r) => ({ r, e })));
  const n = trials.length;
  const count = (o) => trials.filter(({ r }) => r.outcome === o).length;
  const reached = trials.filter(({ r }) => r.outcome === "reached");
  const eff = reached.map(({ r, e }) => r.pathLength / referenceLength(world, e.scenario));
  const k = { reached: reached.length, intercepted: count("intercepted"), crashed: count("crashed"), timeout: count("timeout"), invalid: count("invalid") };
  return {
    label,
    scenarios: eps.length,
    trials: n,
    counts: k,
    successRate: n ? k.reached / n : 0,
    successCI95: wilson(k.reached, n),
    interceptRate: n ? k.intercepted / n : 0,
    interceptCI95: wilson(k.intercepted, n),
    crashRate: n ? k.crashed / n : 0,
    crashCI95: wilson(k.crashed, n),
    collisionRate: n ? (k.intercepted + k.crashed) / n : 0,
    pathEfficiency: eff.length ? eff.reduce((a, b) => a + b, 0) / eff.length : null,
    invalidActions: eps.filter((e) => e.defender?.invalid).length,
    scenariosSolved: eps.filter((e) => e.summary.successRate >= 0.5).length,
    perScenario: Object.fromEntries(eps.map((e) => [e.scenario.id, e.summary.reached])),
  };
}

function runCondition(label, heldout, makePolicy) {
  const eps = heldout.map((sc) => {
    const policy = makePolicy(sc);
    const ep = runEpisode(world, sc, policy, { keepFrames: false });
    return { scenario: sc, defender: { policy }, ...ep, routes: policy.route_id };
  });
  const m = metricsFrom(label, eps);
  m.routesChosen = Object.fromEntries(eps.map((e) => [e.scenario.id, e.routes]));
  return m;
}

function sweep(sets, nWorkers) {
  const grid = controllerGrid();
  const jobs = [];
  for (const sel of SELECTORS) for (const ctrl of grid) jobs.push({ i: jobs.length, sel, ctrl });
  const chunks = Array.from({ length: nWorkers }, (_, w) => jobs.filter((j) => j.i % nWorkers === w));
  return Promise.all(
    chunks.map(
      (chunk) =>
        new Promise((res, rej) => {
          const wk = new Worker(fileURLToPath(import.meta.url), { workerData: { jobs: chunk, sets } });
          wk.once("message", res);
          wk.once("error", rej);
        }),
    ),
  ).then((parts) => parts.flat().sort((a, b) => a.i - b.i));
}

const better = (key) => (a, b) => b[key].reached - a[key].reached || a[key].intercepted + a[key].crashed - (b[key].intercepted + b[key].crashed) || b[key].solved - a[key].solved || a.i - b.i;

// Ripple numbers recomputed from a saved session's evaluation episodes.
function rippleFrom(file, heldout) {
  const s = JSON.parse(fs.readFileSync(file));
  const out = {};
  const heldById = Object.fromEntries(heldout.map((h) => [h.id, h]));
  let scenarioMismatch = 0;
  for (const c of s.evaluation.conditions) {
    if (c.key === "shortest") continue;
    const eps = s.evaluation.episodes.filter((e) => e.condition === c.key);
    let replayed = 0, replayMismatch = 0;
    for (const e of eps) {
      const h = heldById[e.scenario.id];
      if (!h || e.scenario.start !== h.start || e.scenario.goal !== h.goal || JSON.stringify(e.scenario.bird) !== JSON.stringify(h.bird) || e.scenario.seeds.join() !== h.seeds.join()) scenarioMismatch++;
      // Re-simulate Ripple's saved decision with the CURRENT engine, so the
      // baselines and Ripple are compared under the same physics.
      if (!e.defender.invalid) {
        const sim = runEpisode(world, e.scenario, e.defender.policy, { keepFrames: false });
        replayed++;
        if (sim.results.map((r) => r.outcome).join() !== e.results.map((r) => r.outcome).join()) replayMismatch++;
      }
    }
    out[c.key] = { ...metricsFrom(c.label, eps), recordedSuccessRate: s.evaluation.metrics[c.key].successRate, replayed, replayMismatch };
  }
  return { file: path.relative(root, file), usingModel: s.usingModel, strategySource: s.strategy?.source, scenarioMismatch, conditions: out };
}

function simSrcState() {
  try {
    const head = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
    const dirty = execSync("git status --porcelain -- sim/src", { cwd: root }).toString().trim();
    return dirty ? `${head} + uncommitted edits (${dirty.split("\n").map((l) => l.trim()).join("; ")})` : `${head} (clean)`;
  } catch {
    return "unknown";
  }
}

function paired(a, b) {
  let w = 0, t = 0, l = 0;
  for (const id of Object.keys(a.perScenario)) {
    const x = a.perScenario[id], y = b.perScenario[id];
    if (x > y) w++;
    else if (x < y) l++;
    else t++;
  }
  // two-sided sign test on non-tied scenarios
  const n = w + l;
  let p = 0;
  const choose = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
  for (let k = 0; k <= n; k++) if (Math.min(k, n - k) <= Math.min(w, l)) p += choose(n, k) / 2 ** n;
  return { wins: w, ties: t, losses: l, signTestP: n ? Math.min(1, p) : 1 };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const heldout = JSON.parse(fs.readFileSync(path.join(here, "../../scenarios/heldout.json"))).scenarios;

  // Training scenarios: the attacker-proposed episodes Ripple trained on, from
  // both saved Ripple sessions (deduplicated). Never the held-out set.
  const trainFiles = [path.join(root, "sim/recordings/ripple-training.json"), path.join(root, "sim/recordings/run2-930b632/session.json")];
  const seen = new Set();
  const training = [];
  for (const f of trainFiles) {
    const s = JSON.parse(fs.readFileSync(f));
    for (const ep of s.training || []) {
      const key = JSON.stringify([ep.scenario.start, ep.scenario.goal, ep.scenario.bird, ep.scenario.seeds]);
      if (seen.has(key)) continue;
      seen.add(key);
      training.push({ ...ep.scenario, id: `${path.basename(path.dirname(f))}:${ep.scenario.id}` });
    }
  }
  console.log(`training scenarios: ${training.length} (from ${trainFiles.length} Ripple sessions); held-out: ${heldout.length}`);

  const nWorkers = Number(opt("--workers") || Math.max(1, Math.min(10, os.cpus().length - 2)));
  const t0 = Date.now();
  // --sweep-cache <file>: reuse a previous sweep (it depends only on the
  // scenario files and the engine), or write one there after running.
  const cache = opt("--sweep-cache");
  let sw;
  if (cache && fs.existsSync(cache)) {
    sw = JSON.parse(fs.readFileSync(cache));
    console.log(`sweep: loaded ${sw.length} configs from ${cache}`);
  } else {
    sw = await sweep({ train: training, heldout }, nWorkers);
    if (cache) fs.writeFileSync(cache, JSON.stringify(sw));
    console.log(`sweep: ${sw.length} configs x (${training.length} train + ${heldout.length} held-out) scenarios in ${Math.round((Date.now() - t0) / 1000)} s on ${nWorkers} workers`);
  }

  const byTrain = [...sw].sort(better("train"));
  const byHeld = [...sw].sort(better("heldout"));
  const best = byTrain[0];
  const oracle = byHeld[0];
  // How sensitive is the tuned pick? Held-out success of the top-10 training configs.
  const top10 = byTrain.slice(0, 10).map((c) => ({ sel: c.sel, ctrl: c.ctrl, train: c.train, heldout: c.heldout }));

  const conds = {
    shortest: runCondition("Shortest-path comparator (controller OFF)", heldout, (sc) => shortestPathPolicy(world, sc)),
    shortest_ctrl: runCondition("Shortest route + controller ON (4.2/0.6/6m/0.6/replan)", heldout, (sc) => policyFor("rank1", FIXED_CTRL, sc)),
    heuristic: runCondition("Bird-aware heuristic (max-clearance route + controller ON)", heldout, (sc) => validateDefender(heuristicDefender(world, sc, { strategy: "bird-aware" }), world, sc).policy),
    tuned: runCondition(`Tuned on training: ${best.sel} + ${JSON.stringify(best.ctrl)}`, heldout, (sc) => policyFor(best.sel, best.ctrl, sc)),
    oracle_fixed: runCondition(`Oracle fixed (picked ON held-out, upper bound): ${oracle.sel} + ${JSON.stringify(oracle.ctrl)}`, heldout, (sc) => policyFor(oracle.sel, oracle.ctrl, sc)),
  };
  // Best fixed controller per selector among "controller OFF" configs too, for context.
  const ctrlOffBest = byTrain.find((c) => c.ctrl.avoidance_distance === 0);

  const ripple = {
    recording: rippleFrom(path.join(root, "sim/recordings/ripple-training.json"), heldout),
    current930b632: rippleFrom(path.join(root, "sim/recordings/run2-930b632/session.json"), heldout),
  };

  const rippleRows = {
    "ripple_rec_original": ripple.recording.conditions.original,
    "ripple_rec_strategy": ripple.recording.conditions.strategy,
    "ripple_930_original": ripple.current930b632.conditions.original,
    "ripple_930_strategy": ripple.current930b632.conditions.strategy,
  };
  const strongest = ["shortest_ctrl", "heuristic", "tuned"].map((k) => [k, conds[k]]).sort((a, b) => b[1].successRate - a[1].successRate)[0];
  const comparisons = {};
  for (const [rk, rm] of Object.entries(rippleRows)) {
    comparisons[rk] = {};
    for (const bk of ["shortest", "shortest_ctrl", "heuristic", "tuned", "oracle_fixed"]) {
      comparisons[rk][bk] = { successDiffPP: Math.round((rm.successRate - conds[bk].successRate) * 1000) / 10, ...paired(rm, conds[bk]) };
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = opt("--out") || path.join(root, `runs/experiments/baselines-${ts}`);
  fs.mkdirSync(outDir, { recursive: true });
  const result = {
    kind: "baseline-eval",
    at: new Date().toISOString(),
    simSrc: simSrcState(),
    note: "Non-LLM baselines on sim/scenarios/heldout.json (12 scenarios x 4 seeds = 48 trials), same metric definitions as Arena.evaluate. Wilson 95% intervals treat the 48 trials as independent; seeds within a scenario are correlated, so true uncertainty is wider. 'tuned' is selected on training scenarios only. 'oracle_fixed' is selected on held-out and is an upper bound, not a fair baseline.",
    fixedController: FIXED_CTRL,
    trainingScenarios: training.map((s) => ({ id: s.id, start: s.start, goal: s.goal, bird: s.bird, seeds: s.seeds })),
    sweep: { selectors: SELECTORS, controllers: controllerGrid().length, configs: sw.length, best: { sel: best.sel, ctrl: best.ctrl, train: best.train, heldout: best.heldout }, oracle: { sel: oracle.sel, ctrl: oracle.ctrl, train: oracle.train, heldout: oracle.heldout }, bestControllerOff: ctrlOffBest && { sel: ctrlOffBest.sel, ctrl: ctrlOffBest.ctrl, train: ctrlOffBest.train, heldout: ctrlOffBest.heldout }, top10ByTraining: top10 },
    baselines: conds,
    ripple,
    strongestFairBaseline: strongest[0],
    comparisons,
  };
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));

  // ---- markdown table ----
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  const ci = (c) => `[${(c[0] * 100).toFixed(0)}–${(c[1] * 100).toFixed(0)}]`;
  const row = (name, m) => `| ${name} | ${pct(m.successRate)} ${ci(m.successCI95)} | ${pct(m.interceptRate)} ${ci(m.interceptCI95)} | ${pct(m.crashRate)} ${ci(m.crashCI95)} | ${m.scenariosSolved}/${m.scenarios} |`;
  const lines = [
    "| Condition | Success [95% CI] | Intercepted | Crashed | Solved |",
    "|---|---|---|---|---|",
    row("Ripple + strategy (930b632 run)", rippleRows.ripple_930_strategy),
    row("Ripple original (930b632 run)", rippleRows.ripple_930_original),
    row("Ripple original (recording)", rippleRows.ripple_rec_original),
    row("Ripple + strategy (recording)", rippleRows.ripple_rec_strategy),
    row(`Tuned fixed (train-only sweep: ${best.sel}, ${best.ctrl.cruise_speed}/${best.ctrl.corner_slowdown}/${best.ctrl.avoidance_distance}m/${best.ctrl.evade_strength}/${best.ctrl.replan_when_bird_nearby ? "replan" : "no-replan"})`, conds.tuned),
    row("Bird-aware heuristic (clearance route + controller ON)", conds.heuristic),
    row("Shortest route + controller ON", conds.shortest_ctrl),
    row("Shortest comparator (controller OFF)", conds.shortest),
    row(`*Oracle fixed (picked on held-out: ${oracle.sel}, ${oracle.ctrl.cruise_speed}/${oracle.ctrl.corner_slowdown}/${oracle.ctrl.avoidance_distance}m/${oracle.ctrl.evade_strength}/${oracle.ctrl.replan_when_bird_nearby ? "replan" : "no-replan"})*`, conds.oracle_fixed),
  ];
  const md = [
    `## Held-out baselines (12 scenarios × 4 seeds = 48 trials)`,
    "",
    ...lines,
    "",
    `Sweep: ${sw.length} configs (${SELECTORS.length} route selectors × ${controllerGrid().length} controller settings) on ${training.length} training scenarios. Tuned pick: train ${best.train.reached}/${best.train.trials}, held-out ${best.heldout.reached}/${best.heldout.trials}. Top-10 training configs on held-out: ${top10.map((c) => c.heldout.reached).join(", ")} /48.`,
    "",
    "Paired per-scenario comparison (Ripple vs baseline; wins/ties/losses on reached-of-4, two-sided sign test):",
    "",
    "| Ripple run | vs | Δ success (pp) | W/T/L | sign-test p |",
    "|---|---|---|---|---|",
    ...Object.entries(comparisons).flatMap(([rk, cs]) => ["shortest_ctrl", "heuristic", "tuned", "shortest"].map((bk) => `| ${rk} | ${bk} | ${cs[bk].successDiffPP > 0 ? "+" : ""}${cs[bk].successDiffPP} | ${cs[bk].wins}/${cs[bk].ties}/${cs[bk].losses} | ${cs[bk].signTestP.toFixed(3)} |`)),
    "",
    `Recomputed Ripple success matches recorded: ${Object.values(rippleRows).every((m) => Math.abs(m.successRate - m.recordedSuccessRate) < 1e-9)}; held-out scenario mismatches vs heldout.json: recording ${ripple.recording.scenarioMismatch}, 930b632 ${ripple.current930b632.scenarioMismatch}. Ripple decisions re-simulated on the current engine with a different outcome: ${Object.entries(rippleRows).map(([k, m]) => `${k} ${m.replayMismatch}/${m.replayed}`).join(", ")}. sim/src state: ${result.simSrc}.`,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "results.md"), md + "\n");
  console.log(md);
  console.log(`\nwrote ${path.relative(root, outDir)}/results.json and results.md`);
}

// ---------------- entry (last, so every const above is initialised) ----------------
if (!isMainThread) {
  const { jobs, sets } = workerData;
  const out = jobs.map(({ i, sel, ctrl }) => ({ i, sel, ctrl, ...Object.fromEntries(Object.entries(sets).map(([k, scs]) => [k, tally(world, scs, sel, ctrl)])) }));
  parentPort.postMessage(out);
} else {
  await main();
}
