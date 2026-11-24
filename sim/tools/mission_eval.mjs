#!/usr/bin/env node
// Evaluate controllers on the search / delivery mission sets
// (sim/scenarios/mission-<map>-<task>.json). The mission counterpart of
// reach_eval.mjs: every episode is re-flown from its recorded commands and
// must reproduce exactly. No model calls unless a condition needs one.
//   node sim/tools/mission_eval.mjs --map canyon --task search --set dev --seeds 2 \
//     --conditions oracle,explorer --out runs/missions/canyon-search-dev-baselines
//   node sim/tools/mission_eval.mjs --map residential --task delivery --set dev \
//     --conditions program --program runs/missions/.../best.js --out ...
// Conditions: oracle (privileged A* upper bound), explorer (search, sensors
// only), padseeker (delivery, sensors only), hover (does nothing: floor),
// tuned (the sensor-only baseline with --params), program (a model-written
// policy(obs, memory)).
// Missions v2 (--sets v2): sweep (coverage sweep on the drone's own onboard
// map; needs --sensors map), lanes (lane sweep of the assigned area),
// randomwalk, mapcover (knows the map, not the hiker), maporacle (knows the
// map and the hiker); delivery: dropseeker (sensors only), droporacle (map).
// --random separate|legacy: a program's Math.random seed, its own (default)
// or the wind's (as the v4 and v5 pilot runs; use legacy to re-fly them).
import fs from "node:fs";
import path from "node:path";
import { v } from "../src/world.js";
import { rng } from "../src/engine.js";
import { runEpisode, replayEpisode } from "../src/gym/core.js";
import { RescueMission } from "../src/gym/rescue_tasks.js";
import { programRandomSeed } from "../src/gym/policy_sandbox.js";
import { oracleSearch, oracleDelivery, explorer, padSeeker, frontierExplorer, coverageSweep, laneSweep, randomWalk, dropSeeker } from "../src/gym/mission_agents.js";
import { mapCover, mapOracle, dropOracle, walkableFloor } from "../src/gym/mission_v2.js";
import { missionProgram } from "../src/gym/mission_train.js";
import { sensedCoverage } from "../src/gym/mission_select.js";
import { loadEnvironment, root } from "./benchmark_env.mjs";

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const E = loadEnvironment(opt("--map", "factory"));
const task = opt("--task", "search");
const SETS = opt("--sets", "");
const file = path.join(root, `sim/scenarios/mission-${SETS ? `${SETS}-` : ""}${E.name}-${task}.json`);
if (!fs.existsSync(file)) throw new Error(`${path.relative(root, file)} missing; run sim/tools/maps/make_mission_sets.mjs`);
const sets = JSON.parse(fs.readFileSync(file, "utf8"));
const setName = opt("--set", "dev");
if (setName === "test" && !args.includes("--test-pass")) throw new Error("test missions are for the pre-registered pass only; add --test-pass to confirm");
const all = sets[setName];
if (!all?.length) throw new Error(`no ${setName} missions`);
const missions = all.slice(0, Number(opt("--limit", all.length)));
const nSeeds = Number(opt("--seeds", 2));
const dt = Number(opt("--dt", 1));
const sensors = opt("--sensors", "basic"); // v5 harness option; must match how a program was written
const RANDOM = opt("--random", "separate");
programRandomSeed(1, RANDOM);
if (![0.25, 0.5, 1].includes(dt)) throw new Error("--dt must be 0.25, 0.5 or 1");
const conditions = opt("--conditions", task === "search" ? "oracle,explorer" : "oracle,padseeker").split(",");
const tunedParams = opt("--params") ? JSON.parse(fs.readFileSync(opt("--params"), "utf8")).best.params : null;
if (conditions.includes("tuned") && !tunedParams) throw new Error("tuned needs --params runs/missions/v4tune/<cell>/best.json");
const programFile = opt("--program");
const programCode = programFile ? fs.readFileSync(programFile, "utf8") : null;
if (conditions.includes("program") && !programCode) throw new Error("program needs --program file.js");
const outDir = path.resolve(opt("--out", path.join(root, "runs/missions", `${E.name}-${task}-${setName}-${new Date().toISOString().replace(/[:.]/g, "-")}`)));
fs.mkdirSync(outDir, { recursive: true });
const W = E.world;
const isV2 = all[0].kind === "package-drop" || !!all[0].searchArea;
const floor = isV2 && task === "search" ? walkableFloor(W) : null;

// What a controller under test sees: the mission's own observation. Nothing
// is added; this is here so the boundary is explicit and auditable.
const publicObs = (obs) => obs;
const CTL = {
  oracle: (m) => (task === "search" ? oracleSearch(W, m, { dt }) : oracleDelivery(W, m, { dt })),
  explorer: (m) => explorer(W, m),
  padseeker: (m) => padSeeker(W, m),
  frontier: (m) => frontierExplorer(W, m), // needs --sensors map-v5pilot
  sweep: (m) => coverageSweep(W, m), // needs --sensors map
  lanes: (m) => laneSweep(W, m),
  randomwalk: (m, seed) => randomWalk(W, m, seed),
  mapcover: (m) => mapCover(W, m, { floor, dt }),
  maporacle: (m) => mapOracle(W, m, { dt }),
  dropseeker: (m) => dropSeeker(W, m),
  droporacle: (m) => dropOracle(W, m, { dt }),
  // tuned: the cell's sensor-only baseline with parameters picked on TRAIN (mission_tune_baseline.mjs).
  tuned: (m) => (task === "search" ? explorer(W, m, tunedParams) : padSeeker(W, m, tunedParams)),
  hover: () => async () => ({ command: { velocity: [0, 0, 0] }, say: "hover" }),
  program: (m, seed) => missionProgram(programCode, { seed, randomSeed: programRandomSeed(seed, RANDOM), kind: m.kind }),
};
for (const c of conditions) if (!CTL[c]) throw new Error(`unknown condition ${c}`);

const SUCCESS = task === "search" ? "found" : "delivered";
const seedsFor = (m) => Array.from({ length: nSeeds }, (_, k) => (k < m.seeds.length ? m.seeds[k] : m.seeds[0] + 1000 * k));
const jobs = [];
for (const c of conditions) for (const m of missions) for (const seed of seedsFor(m)) jobs.push({ c, m, seed });
console.log(`${jobs.length} episodes: ${conditions.join(", ")} x ${missions.length} ${E.name} ${task} ${setName} missions x ${nSeeds} seeds, decisions every ${dt} s`);
const log = fs.createWriteStream(path.join(outDir, "episodes.jsonl"));
const t0 = Date.now();
const rows = [];
for (const { c, m, seed } of jobs) {
  const inner = CTL[c](m, seed);
  const ctl = async (obs) => inner(publicObs(obs));
  const ep = await runEpisode(new RescueMission(W, m, seed, { sensors }), ctl, { dt });
  const replayEnv = new RescueMission(W, m, seed, { sensors });
  const re = replayEpisode(replayEnv, ep.decisions, { dt });
  const replayOk = JSON.stringify(re) === JSON.stringify(ep.result) && JSON.stringify(replayEnv.frames) === JSON.stringify(ep.frames);
  // Analysis only (privileged): closest approach to the hiker / hover point.
  const goal = task === "search" || m.kind === "package-drop" ? m.targetPosition : v.add(m.targetPosition, [0, m.releaseHeight, 0]);
  const start = v.dist(m.start, goal);
  const closest = Math.min(...ep.frames.map((f) => v.dist([f[1], f[2], f[3]], goal)));
  const row = { condition: c, mission: m.id, seed, dt, straight_m: m.straight_m, result: ep.result, replayOk, decisions: ep.decisions.length,
    errors: ep.decisions.filter((d) => d.error).length, success: ep.result.outcome === SUCCESS, progress: Math.max(0, 1 - closest / start), closest: Math.round(closest * 100) / 100,
    // Ground the drone's own detector looked at (search; sensor-derived, used for selection).
    ...(task === "search" ? { coverage: sensedCoverage(W, ep.frames, m.detectionRange, { area: m.searchArea }) } : {}),
    // Fraction of the sector's hiding places (one per 1-unit cell) that were
    // ever within detection range with line of sight (analysis only, privileged).
    ...(floor && m.searchArea ? { floorSeen: floorSeen(m, ep.frames) } : {}) };
  log.write(JSON.stringify({ ...row, decisionLog: ep.decisions.map(({ obs, ...d }) => d), frames: ep.frames }) + "\n");
  rows.push(row);
  if (rows.length % 20 === 0) process.stdout.write(`\r${rows.length}/${jobs.length} episodes [${Math.round((Date.now() - t0) / 1000)} s]   `);
}
console.log();

function floorSeen(m, frames) {
  const a = m.searchArea, cells = new Map();
  for (const s of floor.spots) if (s.x >= a.min[0] && s.x <= a.max[0] && s.z >= a.min[1] && s.z <= a.max[1]) { const k = `${Math.floor(s.x)},${Math.floor(s.z)}`; if (!cells.has(k)) cells.set(k, s.target); }
  const seen = new Set();
  let lastT = -Infinity;
  for (const f of frames) {
    if (f[0] - lastT < 0.5) continue;
    lastT = f[0];
    const p = [f[1], f[2], f[3]];
    for (const [k, t] of cells) if (!seen.has(k) && Math.abs(t[0] - p[0]) <= m.detectionRange && Math.abs(t[2] - p[2]) <= m.detectionRange && v.dist(p, t) <= m.detectionRange && W.segmentClear(p, t, 0.05)) seen.add(k);
  }
  return Math.round((seen.size / Math.max(cells.size, 1)) * 1000) / 1000;
}

function boot(rs, stat, B = 2000) {
  const by = Object.values(Object.groupBy(rs, (r) => r.mission));
  const rand = rng(12345).next;
  const vals = [];
  for (let i = 0; i < B; i++) vals.push(stat(by.flatMap(() => by[Math.floor(rand() * by.length)])));
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * B)], vals[Math.floor(0.975 * B)]];
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const rate = (rs) => rs.filter((r) => r.success).length / rs.length;
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const cells = conditions.map((c) => {
  const rs = rows.filter((r) => r.condition === c), ok = rs.filter((r) => r.success);
  const outcomes = {};
  for (const r of rs) outcomes[r.result.outcome] = (outcomes[r.result.outcome] || 0) + 1;
  return { condition: c, episodes: rs.length, success: rate(rs), successCI: boot(rs, rate), progress: mean(rs.map((r) => r.progress)),
    timeSuccess: mean(ok.map((r) => r.result.time)), contacts: mean(rs.map((r) => r.result.contacts)), touchFraction: mean(rs.map((r) => r.result.touchFraction)),
    errors: rs.reduce((a, r) => a + r.errors, 0), outcomes, replayOk: rs.filter((r) => r.replayOk).length,
    successes: ok.length,
    ...(task === "search" ? { coverage: mean(rs.map((r) => r.coverage)) } : {}),
    ...(rs[0]?.floorSeen != null ? { floorSeen: mean(rs.map((r) => r.floorSeen)) } : {}),
    ...(rs[0]?.result.drop ? { released: rs.filter((r) => r.result.drop.released).length, landingErrorMedian: median(rs.map((r) => r.result.drop.landingError).filter((x) => x != null)),
      releaseHeightMedian: median(rs.map((r) => r.result.drop.releaseHeight).filter((x) => x != null)) } : {}) };
});
const pct = (x) => (x == null ? "  - " : `${Math.round(x * 100)}%`.padStart(4));
const f1 = (x) => (x == null ? "  -  " : x.toFixed(1).padStart(5));
console.log(`condition    n  ${SUCCESS} [95% CI]   progress  time_s contacts touching  replay  outcomes`);
for (const c of cells) console.log(`${c.condition.padEnd(10)} ${String(c.episodes).padStart(3)}  ${pct(c.success)} [${pct(c.successCI[0])}-${pct(c.successCI[1])}]     ${pct(c.progress)}   ${f1(c.timeSuccess)}  ${f1(c.contacts)}    ${pct(c.touchFraction)}   ${c.replayOk}/${c.episodes}  ${JSON.stringify(c.outcomes)}${c.floorSeen != null ? `  floor seen ${pct(c.floorSeen)}` : ""}${c.coverage != null ? `  covered ${Math.round(c.coverage)} m2` : ""}${c.landingErrorMedian != null ? `  released ${c.released}, median landing error ${c.landingErrorMedian}, median release height ${c.releaseHeightMedian}` : ""}`);
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ at: new Date().toISOString(), map: E.name, task, set: setName, dt, seeds: nSeeds, sets: SETS || "v4", sensors, random: RANDOM, program: programFile, params: opt("--params"), missions: missions.map((m) => m.id), wallSeconds: Math.round((Date.now() - t0) / 1000), cells }, null, 1));
log.end();
console.log("wrote", path.relative(root, outDir));
