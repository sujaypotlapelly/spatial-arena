#!/usr/bin/env node
// Proof that the missions v2 changes leave published and pilot mission runs
// reproducible under the legacy options (--random legacy --select legacy,
// --sensors map-v5pilot for the v5 pilot's onboard map). No model calls; it
// reads recordings from the main checkout's runs/ and flies no test set.
//
// A. Selection. For every recorded coding-loop run, recompute from its
//    recorded curve rows the base each version revised from and the frozen
//    version, with the legacy rule. Must equal the recording.
// B. Training evaluation. Re-fly recorded programs on their TRAIN missions
//    with the shared trainer (sim/src/gym/mission_train.js) under the legacy
//    options; success, progress, contacts per minute, runtime errors, compile
//    error and the full feedback text must equal the recorded v<k>-train.json.
// C. Dev episodes. Re-fly recorded DEV evaluation episodes (programs and
//    hand-written controllers) and compare result, commands and frames.
//
//   node sim/tools/mission_replay_check.mjs --runs <main>/runs [--versions frozen|all] [--out file.json]
import fs from "node:fs";
import path from "node:path";
import { runEpisode } from "../src/gym/core.js";
import { RescueMission } from "../src/gym/rescue_tasks.js";
import { programController } from "../src/gym/policy_sandbox.js";
import { explorer, padSeeker, frontierExplorer, oracleSearch, oracleDelivery } from "../src/gym/mission_agents.js";
import { makeTrainer } from "../src/gym/mission_train.js";
import { better, pickFrozen } from "../src/gym/mission_select.js";
import { loadEnvironment, root } from "./benchmark_env.mjs";

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const RUNS = path.resolve(opt("--runs", path.join(root, "runs")));
const VERSIONS = opt("--versions", "frozen");
const ONLY = opt("--only", "ABC");
const out = { at: new Date().toISOString(), runs: RUNS, versions: VERSIONS, A: [], B: [], C: [] };
const envs = {};
const env = (name) => (envs[name] ??= loadEnvironment(name));
const loops = [
  ...["factory-search", "canyon-search", "residential-search", "factory-delivery", "residential-delivery"].map((c) => `missions/v4cap/${c}`),
  ...["search-base", "search-lidar-rich", "search-rich", "search-map", "search-map-strong", "delivery-base", "delivery-lidar-rich", "delivery-strong"].map((c) => `v5pilot/${c}`),
].filter((d) => fs.existsSync(path.join(RUNS, d, "plan.json")));
const runDirs = (d) => fs.readdirSync(path.join(RUNS, d)).filter((r) => /^run\d+$/.test(r)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));

// ---------- A. selection ----------
if (ONLY.includes("A")) for (const d of loops) {
  const plan = JSON.parse(fs.readFileSync(path.join(RUNS, d, "plan.json"), "utf8"));
  let runs = 0, baseOk = 0, frozenOk = 0;
  for (const r of runDirs(d)) {
    const f = path.join(RUNS, d, r, "curve.json");
    if (!fs.existsSync(f)) continue;
    const { curve, best } = JSON.parse(fs.readFileSync(f, "utf8"));
    runs++;
    let base = null, ok = true;
    for (const row of curve) {
      const usable = !row.compileError && row.finish !== "length";
      if (usable && better(row, base, "legacy", plan.task)) base = row;
      if ((base?.version ?? null) !== row.base) ok = false;
    }
    baseOk += ok;
    frozenOk += pickFrozen(curve, "legacy", plan.task).version === best;
  }
  out.A.push({ loop: d, runs, baseSequenceMatches: baseOk, frozenMatches: frozenOk });
  console.log(`A ${d}: base sequence ${baseOk}/${runs}, frozen version ${frozenOk}/${runs}`);
}

// ---------- B. training evaluation ----------
if (ONLY.includes("B")) for (const d of loops) {
  const plan = JSON.parse(fs.readFileSync(path.join(RUNS, d, "plan.json"), "utf8"));
  const E = env(plan.map);
  const sets = JSON.parse(fs.readFileSync(path.join(root, `sim/scenarios/mission-${plan.map}-${plan.task}.json`), "utf8"));
  const sensors = plan.sensors === "map" ? "map-v5pilot" : plan.sensors ?? "basic";
  const trainer = makeTrainer({ world: E.world, task: plan.task, dt: plan.dt ?? 1, sensors, feedback: plan.feedback ?? "basic", trainSeeds: plan.trainSeeds ?? 1, random: "legacy", select: "legacy" });
  let checked = 0, same = 0, changed = 0, runsAll = 0, zeroLegacy = 0, zeroEarned = 0;
  const diffs = [];
  for (const r of runDirs(d)) {
    const cf = path.join(RUNS, d, r, "curve.json");
    if (!fs.existsSync(cf)) continue;
    const { curve, best } = JSON.parse(fs.readFileSync(cf, "utf8"));
    const versions = VERSIONS === "all" ? curve.map((c) => c.version) : [best];
    const rows = [];
    for (const k of versions) {
      const rec = JSON.parse(fs.readFileSync(path.join(RUNS, d, r, `v${k}-train.json`), "utf8"));
      const code = fs.readFileSync(path.join(RUNS, d, r, `v${k}.js`), "utf8");
      const res = await trainer.evaluate(code, sets.train);
      const now = { success: res.success, progress: res.progress, contactsPerMin: res.contactsPerMin ?? null, errors: res.errors ?? null, compileError: res.compileError ?? null, report: trainer.report(res) };
      const was = { success: rec.success, progress: rec.progress, contactsPerMin: rec.contactsPerMin, errors: rec.errors, compileError: rec.compileError, report: rec.report };
      checked++;
      const c = curve.find((x) => x.version === k);
      rows.push({ version: k, success: res.success, progress: res.progress, coverage: res.coverage, compileError: c.compileError, finish: c.finish });
      if (JSON.stringify(now) === JSON.stringify(was)) same++;
      else diffs.push({ run: r, version: k, fields: Object.keys(now).filter((f) => JSON.stringify(now[f]) !== JSON.stringify(was[f])) });
    }
    // With every version re-flown: which version the earned rule would freeze.
    if (VERSIONS === "all" && plan.task === "search") {
      const L = pickFrozen(rows, "legacy", plan.task), Ea = pickFrozen(rows, "earned", plan.task);
      runsAll++; changed += L.version !== Ea.version; zeroLegacy += L.success === 0; zeroEarned += Ea.success === 0;
    }
  }
  const earnedVsLegacy = runsAll ? { runs: runsAll, frozenVersionChanges: changed, frozenWithZeroFindsLegacy: zeroLegacy, frozenWithZeroFindsEarned: zeroEarned } : null;
  if (earnedVsLegacy) console.log(`  earned vs legacy selection on ${d}: ${JSON.stringify(earnedVsLegacy)}`);
  out.B.push({ loop: d, sensors, checked, identical: same, diffs: diffs.slice(0, 10), earnedVsLegacy });
  console.log(`B ${d} (sensors ${sensors}): ${same}/${checked} recorded train evaluations identical${diffs.length ? ` ${JSON.stringify(diffs.slice(0, 3))}` : ""}`);
}

// ---------- C. dev episodes ----------
const devDirs = [
  ["v5pilot/search-map-dev", "map-v5pilot"], ["v5pilot/search-map-strong-dev", "map-v5pilot"], ["v5pilot/frontier-dev", "map-v5pilot"],
  ["v5pilot/search-base-dev", "basic"], ["v5pilot/search-rich-dev", "basic"], ["v5pilot/delivery-base-dev", "basic"], ["v5pilot/delivery-strong-dev", "basic"],
  ["v5dev/search-canyon5", "basic"], ["v5dev/delivery-residential5", "basic"],
].filter(([d]) => fs.existsSync(path.join(RUNS, d, "episodes.jsonl")));
if (ONLY.includes("C")) for (const [d, sensors] of devDirs) {
  const S = JSON.parse(fs.readFileSync(path.join(RUNS, d, "summary.json"), "utf8"));
  if (S.set === "test") throw new Error(`${d} is a test pass; not replayed`);
  const E = env(S.map), W = E.world;
  const sets = JSON.parse(fs.readFileSync(path.join(root, `sim/scenarios/mission-${S.map}-${S.task}.json`), "utf8"));
  const byId = Object.fromEntries(sets[S.set].map((m) => [m.id, m]));
  const code = S.program ? fs.readFileSync(path.join(path.dirname(RUNS), S.program), "utf8") : null;
  const CTL = {
    program: (m, seed) => programController(code, { seed }),
    explorer: (m) => explorer(W, m), padseeker: (m) => padSeeker(W, m), frontier: (m) => frontierExplorer(W, m),
    oracle: (m) => (S.task === "search" ? oracleSearch(W, m, { dt: S.dt }) : oracleDelivery(W, m, { dt: S.dt })),
  };
  let n = 0, same = 0;
  const bad = [];
  for (const line of fs.readFileSync(path.join(RUNS, d, "episodes.jsonl"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line), m = byId[e.mission];
    const ep = await runEpisode(new RescueMission(W, m, e.seed, { sensors }), CTL[e.condition](m, e.seed), { dt: e.dt });
    const cmds = (x) => JSON.stringify(x.map((q) => q.command));
    const ok = JSON.stringify(ep.result) === JSON.stringify(e.result) && cmds(ep.decisions) === cmds(e.decisionLog) && JSON.stringify(ep.frames) === JSON.stringify(e.frames);
    n++; same += ok;
    if (!ok && bad.length < 5) bad.push(`${e.condition} ${e.mission} seed ${e.seed}`);
  }
  out.C.push({ dir: d, map: S.map, set: S.set, sensors, episodes: n, identical: same, mismatches: bad });
  console.log(`C ${d} (${S.map} ${S.set}, sensors ${sensors}): ${same}/${n} episodes identical${bad.length ? ` ${bad.join("; ")}` : ""}`);
}

if (opt("--out")) fs.writeFileSync(path.resolve(opt("--out")), JSON.stringify(out, null, 1));
