// Reach control-ladder evaluation.
//   node sim/tools/reach_eval.mjs --set dev --seeds 1 \
//     --conditions ripple@C1,ripple@C2,ripple@C3,ripple@C4,planner@C1,straight@C2,reactive@C3 \
//     --out runs/reach/ladder-dev
// Every episode is re-flown from its recorded commands and must reproduce.
// Each Ripple decision's predictions (position and goal distance in 1 s)
// are scored against what physics actually did.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v } from "../src/world.js";
import { makeReachEnv, WIND_LEVELS, NOISE_LEVELS, resolveLevel } from "../src/gym/reach_perturb.js";
import { runEpisode, replayEpisode } from "../src/gym/core.js";
import { rippleReach, plannerReach, straightReach, reactiveReach } from "../src/gym/reach_agents.js";
import { programController, programRandomSeed } from "../src/gym/policy_sandbox.js";
import { rng } from "../src/engine.js";
import { makeClient, preflight, modelEntry, clientFor } from "./ripple_client.mjs";
import { loadEnvironment, pinScenarios } from "./benchmark_env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../..");
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);

// --map building: zero-shot transfer to the two-floor greybox building (same
// physics). Its routes are one "test" set of 40, built by the same rule.
// --map canyon | residential: the splat-scan benchmark environments
// (sim/scenes/benchmark-sets.json). Every map uses the same physics.
const mapName = opt("--map", "factory");
const E = loadEnvironment(mapName);
const world = E.world;
const sets = E.sets;
pinScenarios(E);
if (!sets[opt("--set", "dev")]?.length) throw new Error(`no "${opt("--set", "dev")}" routes on map ${mapName}`);

const setName = opt("--set", "dev");
const all = sets[setName];
const limit = Number(opt("--limit", all.length));
const scenarios = all.slice(0, limit);
const nSeeds = Number(opt("--seeds", 1));
const conditions = opt("--conditions", "ripple@C1,ripple@C2,ripple@C3,ripple@C4,planner@C1,straight@C2,reactive@C3").split(",").map((c) => { const [ctl, level] = c.split("@"); return { key: c, ctl, level }; });
const outDir = path.resolve(opt("--out", path.join(root, "runs/reach", new Date().toISOString().replace(/[:.]/g, "-"))));
fs.mkdirSync(outDir, { recursive: true });
// Harness features (see reach_agents.js): comma list of rel, struct, ascii, trail.
const KNOWN_FEATURES = ["rel", "struct", "ascii", "trail", "named", "warn", "lean", "memory"];
// Decision interval in seconds (each command is held this long).
const dt = Number(opt("--dt", 1));
const sensors = opt("--sensors", "basic"); // v5 option for program@C3; must match how the program was written
if (![1, 2].includes(dt)) throw new Error("--dt must be 1 or 2");
// --wind none|light|moderate|strong and --noise none|low|medium|high|severe
// (sim/src/gym/reach_perturb.js). Both default to none, which builds the plain
// Reach environment: published runs re-fly unchanged.
const windName = opt("--wind", "none");
const noiseName = opt("--noise", "none");
const WIND = resolveLevel(WIND_LEVELS, windName, "--wind");
const NOISE = resolveLevel(NOISE_LEVELS, noiseName, "--noise");
const envOpts = { sensors, ...(WIND ? { wind: WIND } : {}), ...(NOISE ? { noise: NOISE } : {}) };
const features = (opt("--features", "") || "").split(",").filter(Boolean);
for (const f of features) if (!KNOWN_FEATURES.includes(f)) throw new Error(`unknown feature ${f}`);
if (args.some((a) => a.startsWith("--features ") || a.startsWith("--set ") || a.startsWith("--conditions "))) throw new Error("an option and its value arrived as one argument (unsplit shell variable?)");
// The harness label is derived from the features, so a run can never be
// labelled with a feature it did not use.
const notesTag = opt("--notes") ? `notes:${path.basename(opt("--notes"), ".json")}` : null;
const harness = [features.length ? `v0+${features.join("+")}` : "v0", notesTag, dt !== 1 ? `dt${dt}` : null, WIND ? `wind-${windName}` : null, NOISE ? `noise-${noiseName}` : null].filter(Boolean).join("+");
if (opt("--harness") && opt("--harness") !== harness) throw new Error(`--harness ${opt("--harness")} does not match the features actually enabled (${harness})`);
console.log(`harness ${harness}`);
const notes = opt("--notes") ? JSON.parse(fs.readFileSync(opt("--notes"))).text : null;

// --program file.js: a model-written policy (code as policy), run as condition program@C3.
const tunedParams = opt("--avoider") ? JSON.parse(fs.readFileSync(opt("--avoider"))).best.params : null;
if (conditions.some((c) => c.ctl === "tuned") && !tunedParams) throw new Error("tuned@C3 needs --avoider runs/reach/avoider-tuned/best.json");
const programFile = opt("--program");
// --random separate (default): a program's Math.random does not share the
// wind's seed. --random legacy re-flies a published program as recorded.
const RANDOM = opt("--random", "separate");
programRandomSeed(1, RANDOM);
const programCode = programFile ? fs.readFileSync(programFile, "utf8") : null;
if (conditions.some((c) => c.ctl === "program") && !programCode) throw new Error("program@C3 needs --program file.js");
if (conditions.some((c) => c.ctl === "program" && c.level !== "C3")) throw new Error("programs output velocities: use program@C3");
const usesRipple = conditions.some((c) => c.ctl === "ripple");
// --model <id>: fly a model from sim/bench/models.json instead of Ripple (the "ripple@C3" condition is then that model).
const MODEL_ID = opt("--model");
const clientOpts = { maxInFlight: Number(opt("--concurrency", 24)), logFile: path.join(outDir, "calls.jsonl") };
const client = !usesRipple ? null : MODEL_ID ? clientFor(root, modelEntry(root, MODEL_ID), { ...clientOpts, maxTokens: modelEntry(root, MODEL_ID).maxTokens ?? 400 }) : makeClient({ root, ...clientOpts });
if (client) console.log(`preflight ok on ${await preflight(client)}`);
const CTL = {
  ripple: (sc, level) => rippleReach(world, sc, level, client.chat, { notes, harness, features, dt, scene: E.scene }),
  planner: (sc) => plannerReach(world, sc),
  straight: (sc) => straightReach(world, sc),
  reactive: (sc) => reactiveReach(world, sc),
  // tuned@C3: the avoider with parameters picked on TRAIN (reach_tune_avoider.mjs).
  tuned: (sc) => reactiveReach(world, sc, tunedParams),
  program: (sc, level, seed) => programController(programCode, { seed, randomSeed: programRandomSeed(seed, RANDOM) }),
};

const jobs = [];
// Wind seeds per route: the scenario file lists 2; beyond that, extra seeds
// are derived deterministically (seed[0] + 1000 k), so seeds 1-2 stay
// identical to earlier runs and stay paired with them.
const seedsFor = (sc) => Array.from({ length: nSeeds }, (_, k) => (k < sc.seeds.length ? sc.seeds[k] : sc.seeds[0] + 1000 * k));
for (const c of conditions) for (const sc of scenarios) for (const seed of seedsFor(sc)) jobs.push({ c, sc, seed });
console.log(`${jobs.length} episodes: ${conditions.map((c) => c.key).join(", ")} × ${scenarios.length} ${setName} scenarios × ${nSeeds} seeds; harness ${harness}`);
const log = fs.createWriteStream(path.join(outDir, "episodes.jsonl"));
const t0 = Date.now();
let done = 0;
const rows = await Promise.all(
  jobs.map(async ({ c, sc, seed }) => {
    const ep = await runEpisode(makeReachEnv(world, sc, seed, c.level, envOpts), CTL[c.ctl](sc, c.level, seed), { dt });
    const re = replayEpisode(makeReachEnv(world, sc, seed, c.level, envOpts), ep.decisions, { dt });
    const replayOk = JSON.stringify(re) === JSON.stringify(ep.result);
    // Score predictions against the recorded track (10 Hz frames [t, x, y, z, heading]).
    const F = ep.frames;
    const at = (t) => F.find((f) => f[0] >= t - 1e-6) || F[F.length - 1];
    const goal = world.nodes[sc.goal];
    const posErr = [], goalErr = [];
    for (const d of ep.decisions) {
      if (!d.prediction || d.t + 1 > ep.result.time) continue;
      const f = at(d.t + 1);
      const pos = [f[1], f[2], f[3]];
      if (d.prediction.position?.every(Number.isFinite)) posErr.push(v.dist(d.prediction.position, pos));
      if (Number.isFinite(d.prediction.goalDistance)) goalErr.push(Math.abs(d.prediction.goalDistance - v.dist(pos, goal)));
    }
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const row = {
      condition: c.key, ctl: c.ctl, level: c.level, scenario: sc.id, seed, dt, straight_m: sc.straight_m, graph_m: sc.graph_m,
      result: ep.result, replayOk, decisions: ep.decisions.length,
      invalid: ep.decisions.filter((d) => d.invalid || d.error).length,
      progress: Math.max(0, 1 - ep.result.minGoalDist / sc.straight_m),
      posErr: mean(posErr), goalErr: mean(goalErr),
    };
    log.write(JSON.stringify({ ...row, decisionLog: ep.decisions.map(({ obs, ...d }) => d), frames: F }) + "\n");
    done++;
    process.stdout.write(`\r${done}/${jobs.length} episodes, ${client?.ledger.calls ?? 0} calls, ${Math.round((Date.now() - t0) / 1000)} s   `);
    return row;
  }),
).catch((err) => {
  if (!err?.transport) throw err;
  // The host or the network failed, not the model. Scoring it would count
  // against the model, so stop here; nothing is summarised.
  console.error(`\nStopped: ${err.message}. No summary written; run again with a new --out.`);
  process.exit(3);
});
console.log();

// ---------- summary (bootstrap over scenarios) ----------
function boot(rs, stat, B = 2000) {
  const by = Object.values(Object.groupBy(rs, (r) => r.scenario));
  const rand = rng(12345).next;
  const vals = [];
  for (let i = 0; i < B; i++) vals.push(stat(by.flatMap(() => by[Math.floor(rand() * by.length)])));
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * B)], vals[Math.floor(0.975 * B)]];
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const reached = (rs) => rs.filter((r) => r.result.outcome === "reached").length / rs.length;
const cells = conditions.map((c) => {
  const rs = rows.filter((r) => r.condition === c.key);
  const ok = rs.filter((r) => r.result.outcome === "reached");
  return {
    condition: c.key, ctl: c.ctl, level: c.level, episodes: rs.length,
    reached: reached(rs), reachedCI: boot(rs, reached),
    progress: mean(rs.map((r) => r.progress)), progressCI: boot(rs, (x) => mean(x.map((r) => r.progress))),
    timeReached: mean(ok.map((r) => r.result.time)),
    contactsPerEpisode: mean(rs.map((r) => r.result.contacts)),
    pathRatioReached: mean(ok.map((r) => r.result.pathLength / r.graph_m)),
    posErr: mean(rs.map((r) => r.posErr).filter((x) => x !== null)),
    goalErr: mean(rs.map((r) => r.goalErr).filter((x) => x !== null)),
    invalidRate: rs.reduce((a, r) => a + r.invalid, 0) / Math.max(1, rs.reduce((a, r) => a + r.decisions, 0)),
    replayOk: rs.filter((r) => r.replayOk).length,
  };
});
const pct = (x) => (x == null ? "  -  " : `${Math.round(x * 100)}%`.padStart(4));
const f1 = (x) => (x == null ? "  -  " : x.toFixed(1).padStart(5));
console.log("condition       n  reached [95% CI]   progress  time_s contacts pathRatio  predPos_m predGoal_m invalid replay");
for (const c of cells) console.log(`${c.condition.padEnd(13)} ${String(c.episodes).padStart(3)}  ${pct(c.reached)} [${pct(c.reachedCI[0])}-${pct(c.reachedCI[1])}]   ${pct(c.progress)}   ${f1(c.timeReached)}  ${f1(c.contactsPerEpisode)}   ${f1(c.pathRatioReached)}     ${f1(c.posErr)}     ${f1(c.goalErr)}   ${pct(c.invalidRate)}  ${c.replayOk}/${c.episodes}`);
const summary = { at: new Date().toISOString(), env: "reach", features, dt, ...(WIND ? { wind: { level: windName, ...WIND } } : {}), ...(NOISE ? { noise: { level: noiseName, ...NOISE } } : {}), program: programFile ?? null, programRandom: programFile ? RANDOM : null, map: path.basename(E.map, ".json"), set: setName, avoiderParams: tunedParams, scenarios: scenarios.map((s) => s.id), seeds: nSeeds, harness, notes: opt("--notes"), model: client?.model ?? null, provider: client?.provider ?? null, temperature: client?.temperature ?? null, wallSeconds: Math.round((Date.now() - t0) / 1000), ledger: client?.ledger ?? null, cells };
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
log.end();
client?.close();
console.log("wrote", path.relative(root, outDir));
