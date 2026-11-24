// Multi-model Reach benchmark runner (docs/BENCHMARK.md). Runs the current
// harness for several models at control levels C1-C4, with K samples
// per scenario and wind seed, one pinned host per model, every episode
// re-flown from its recorded commands. Resumable: re-running the same
// command skips episodes already written.
//
//   node sim/tools/bench.mjs --demo                             (no key: a stand-in model and three scripted pilots on four routes)
//   node sim/tools/bench.mjs --fake --models fake --set dev --limit 4 --samples 2 --out runs/bench/smoke
//   node sim/tools/bench.mjs --models ripple-65b,qwen3.6-27b --set dev --seeds 2 --samples 5 --out runs/bench/dev-v1
//   node sim/tools/bench.mjs --baselines --set dev --seeds 2 --out runs/bench/dev-v1
//   node sim/tools/bench.mjs --endpoints qwen/qwen3.6-27b       (list hosts and precisions; public API, no key)
//
// One model, one command (docs/ADD_YOUR_MODEL.md): preflight the endpoint, fly
// a small dev sample, write a scorecard (scorecard.json and SCORECARD.md):
//   node sim/tools/bench.mjs --model <id> --map <environment>                  (live steering at C3)
//   node sim/tools/bench.mjs --model <id> --map <environment> --mode program   (the practice loop)
// --map takes any admitted environment in sim/environments/. Prompts are
// rewritten for the environment (sim/src/gym/arena_prompt.js); the factory
// prompt is byte-identical to the published one.
//
// Output per model: <out>/<id>/episodes.jsonl, calls.jsonl, retries.jsonl,
// ledger.jsonl (one line per invocation), config.json. Scripted baselines go
// to <out>/baselines/. Report: node sim/tools/bench_report.mjs <out>.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { v } from "../src/world.js";
import { Reach, makeReachSets, LEVELS } from "../src/gym/reach.js";
import { runEpisode, replayEpisode } from "../src/gym/core.js";
import { rippleReach, plannerReach, straightReach, reactiveReach } from "../src/gym/reach_agents.js";
import { clientFor, preflight } from "./ripple_client.mjs";
import { makeCliClient } from "./cli_chat.mjs";
import { loadEnvironment, pinScenarios } from "./benchmark_env.mjs";
import { harnessHash, sameHarness, HARNESS_VERSION, ROOT } from "./reach_metrics.mjs";
import crypto from "node:crypto";
import { parseJson } from "../src/gym/core.js";
import { programController, programRandomSeed, BUDGETS } from "../src/gym/policy_sandbox.js";
import { promptProfile, localizeChat } from "../src/gym/arena_prompt.js";
import { resolveSettings, instrumentChat, summarizeStats } from "./arena/model_settings.mjs";
import { buildScorecard, scorecardMarkdown, decisionCounts } from "./arena/scorecard.mjs";
import { practice } from "./arena/program_mode.mjs";
import { openHiddenSplit } from "./arena/hidden_split.mjs";

const args = process.argv.slice(2);
// --demo: the no-key first run from the README, then a short results table.
const demo = args.includes("--demo");
if (demo) args.splice(0, args.length, "--fake", "--models", "fake", "--baselines", "--set", "dev", "--limit", "4", "--seeds", "1", "--samples", "1", "--levels", "C3", "--out", "runs/bench/demo");
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const flag = (k) => args.includes(k);
if (args.some((a) => /^--\w+ /.test(a))) throw new Error("an option and its value arrived as one argument (unsplit shell variable?)");
// --model <id>: the one-command scorecard. A small dev sample unless told
// otherwise: 4 routes, one wind seed, one sample, live steering at C3.
const single = opt("--model");
if (single) {
  if (flag("--models")) throw new Error("pass --model (one model, with a scorecard) or --models (a list), not both");
  const dflt = { "--set": "dev", "--limit": "4", "--seeds": "1", "--samples": "1", "--levels": "C3" };
  for (const [k, val] of Object.entries(dflt)) if (!flag(k)) args.push(k, val);
  args.push("--models", single);
}
const MODE = opt("--mode", "live");
if (!["live", "program"].includes(MODE)) throw new Error("--mode must be live or program");

// ---------- endpoint lookup (helps choose a host pin) ----------
if (opt("--endpoints")) {
  const id = opt("--endpoints");
  const r = await fetch(`https://openrouter.ai/api/v1/models/${id}/endpoints`);
  const body = await r.json();
  const eps = body.data?.endpoints || [];
  if (!eps.length) console.log(`no endpoints for ${id} (HTTP ${r.status})`);
  for (const e of eps) console.log(`${String(e.provider_name).padEnd(18)} quant=${String(e.quantization ?? "?").padEnd(8)} ctx=${e.context_length} in=$${(Number(e.pricing?.prompt) * 1e6).toFixed(2)}/M out=$${(Number(e.pricing?.completion) * 1e6).toFixed(2)}/M status=${e.status ?? "?"}`);
  process.exit(0);
}

// ---------- configuration ----------
// --map: any place in sim/scenes/benchmark-sets.json (default: the factory).
const mapName = opt("--map", "factory");
// Admitted = has a manifest in sim/environments/ with a recorded admission
// stage, and is not a film-only map. Its stage goes on the scorecard.
const manifestFile = path.join(ROOT, "sim/environments", `${mapName}.json`);
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null;
const stage = manifest?.admission?.stage ?? null;
const admitted = manifest && !manifest.videoOnly && manifest.harness?.videoOnly !== true && stage !== null;
if (!admitted && !flag("--allow-unadmitted")) throw new Error(`${mapName} is not an admitted environment (${!manifest ? "no manifest in sim/environments/" : manifest.videoOnly ? "film only" : "no admission stage recorded"}). Admit it (sim/tools/env/admit.mjs) or pass --allow-unadmitted.`);
const E = loadEnvironment(mapName);
const world = E.world;
const sets = E.sets;
pinScenarios(E); // the route sets must match the pinned file
const profile = promptProfile(E);
// --features memory: live steering with the model's own memory and a trail of
// where it has been (sim/src/gym/reach_agents.js). Runs with different
// features are different prompts; the report refuses to mix them.
const features = (opt("--features", "") || "").split(",").filter(Boolean);
for (const f of features) if (f !== "memory") throw new Error(`bench.mjs supports --features memory only (got ${f})`);

const setName = opt("--set", "dev");
if (!["dev", "heldout", "train", "hidden"].includes(setName)) throw new Error("--set must be dev, heldout, train or hidden (the test set is flown only under a pre-registration)");
if (setName === "hidden") {
  // The committed held-back split (sim/tools/arena/hidden_split.mjs): the seed
  // must match the published hash before anything flies.
  const seedFile = opt("--hidden-seed-file");
  if (!seedFile) throw new Error("--set hidden needs --hidden-seed-file <file> (the private seed)");
  const { routes, commitment } = openHiddenSplit(E, fs.readFileSync(seedFile, "utf8").trim(), opt("--hidden-commitments") ? path.resolve(opt("--hidden-commitments")) : undefined);
  if (!flag("--confirm-hidden")) throw new Error(`each look at the hidden split (${commitment.n} routes, committed ${commitment.committedAt}) uses it up a little; pass --confirm-hidden to fly it`);
  sets.hidden = routes;
}
if (!sets[setName]?.length) throw new Error(`${mapName} has no ${setName} routes`);
if (setName === "heldout" && !flag("--confirm-heldout")) throw new Error("held-out looks are limited (docs/BENCHMARK.md); pass --confirm-heldout to run one");
if (MODE === "program" && !sets.train?.length) throw new Error(`${mapName} has no train routes, so program mode can't practise there`);
const scenarios = sets[setName].slice(0, Number(opt("--limit", sets[setName].length)));
const nSeeds = Number(opt("--seeds", 2));
const K = Number(opt("--samples", 5));
const levels = opt("--levels", "C1,C2,C3,C4").split(",");
for (const l of levels) if (!LEVELS.includes(l)) throw new Error(`unknown level ${l}`);
const outDir = path.resolve(opt("--out", path.join(ROOT, "runs/bench", new Date().toISOString().slice(0, 10))));
fs.mkdirSync(outDir, { recursive: true });
const seedsFor = (sc) => Array.from({ length: nSeeds }, (_, k) => (k < sc.seeds.length ? sc.seeds[k] : sc.seeds[0] + 1000 * k));
const hash = harnessHash();
// harnessHash covers the factory files only. arenaHash adds this environment's
// map and route file and the arena code that shapes prompts, retries and
// program timing, so runs on other places can be told apart too.
const ARENA_FILES = [E.map, E.scenarioFile, "sim/src/gym/arena_prompt.js", "sim/src/gym/policy_sandbox.js", "sim/tools/arena/model_settings.mjs", "sim/tools/arena/program_mode.mjs"].filter(Boolean);
const arenaHash = (() => { const h = crypto.createHash("sha256").update(hash); for (const f of ARENA_FILES) h.update(f + "\0" + fs.readFileSync(path.join(ROOT, f)) + "\0"); return h.digest("hex").slice(0, 16); })();
const TEMPERATURE = 0.7; // one temperature for every model (Miller 2024: don't lower it to cut noise)

const registry = JSON.parse(fs.readFileSync(path.resolve(opt("--registry", path.join(ROOT, "sim/bench/models.json")))));
const fake = flag("--fake");
const iters = Number(opt("--iters", 3));

// ---------- fake model (dry runs: no network, no key) ----------
// Reads the observation out of the prompt and answers like a naive
// goal-seeker, with an occasional malformed reply to exercise the repair path.
function fakeChat(seed = 1) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const ledger = { calls: 0, transportRetries: 0, promptTokens: 0, completionTokens: 0, providers: { fake: 0 }, retryReasons: {} };
  const chat = async (messages) => {
    ledger.calls++;
    ledger.providers.fake++;
    const text = messages[messages.length - 1].content;
    ledger.promptTokens += Math.round(text.length / 4);
    if (messages[0].content.includes("```js code block")) return { content: FAKE_PROGRAM, provider: "fake", finish: "stop" };
    if (rand() < 0.03) return { content: "I think we should go north", provider: "fake", finish: "stop" };
    const m = text.match(/What the drone senses now:\n(\{.*\})/);
    const obs = m ? JSON.parse(m[1]) : {};
    let cmd;
    if (obs.goal?.waypoint) cmd = { waypoint: obs.goal.waypoint, speed: 4 };
    else if (obs.goal?.bearing_deg !== undefined) cmd = { turn_deg: Math.max(-60, Math.min(60, obs.goal.bearing_deg)), forward_mps: 3, climb_mps: 0 };
    else if (obs.goal?.position && obs.position) {
      const to = v.sub(obs.goal.position, obs.position);
      const u = v.scale(v.norm(to), 3);
      cmd = text.includes('"target"') ? { target: obs.goal.position, speed: 3 } : { velocity: u.map((x) => Math.round(x * 10) / 10) };
    } else cmd = {};
    return { content: JSON.stringify({ ...cmd, say: "toward the goal" }), provider: "fake", finish: "stop" };
  };
  return { chat, ledger, model: "fake", provider: "fake", temperature: TEMPERATURE, close() {} };
}

// ---------- one model ----------
// The program a stand-in model writes in program mode (dry runs only).
const FAKE_PROGRAM = "```js\n// Fly at the goal; slide sideways when the way ahead is short.\nfunction policy(obs, memory) {\n  const p = obs.position, g = obs.goal.position;\n  const dx = g[0] - p[0], dy = g[1] - p[1], dz = g[2] - p[2];\n  const d = Math.hypot(dx, dz) || 1;\n  return { velocity: [3 * dx / d, Math.max(-1, Math.min(1, dy)), 3 * dz / d] };\n}\n```";

// Ask once before flying: the endpoint answers, the key works, and a short
// reply fits the token budget (a model that thinks first runs out here).
async function arenaPreflight(client, settings) {
  const r = await client.chat([{ role: "user", content: 'Reply with {"ok": true} and nothing else.' }], { role: "preflight" }, { max_tokens: settings.maxTokens });
  const parsed = parseJson(r.content);
  const out = { provider: r.provider ?? null, finish: r.finish ?? null, parsed: Boolean(parsed), reasoningTokens: r.usage?.completion_tokens_details?.reasoning_tokens ?? null, completionTokens: r.usage?.completion_tokens ?? null, latencyMs: r.latencyMs ?? null };
  const problems = [];
  if (r.finish === "length") problems.push(`a one-line reply used all ${settings.maxTokens} tokens (finish=length): the model is probably thinking before it answers. Set "thinking": false or raise maxTokens in models.json.`);
  else if (!parsed) problems.push(`the reply was not JSON: ${JSON.stringify(String(r.content).slice(0, 120))}`);
  return { ...out, problems };
}

async function runModel(entry) {
  const isBaseline = entry.id === "baselines";
  const program = MODE === "program" && !isBaseline;
  const dirId = program ? `${entry.id}-program` : entry.id;
  const dir = path.join(outDir, dirId);
  fs.mkdirSync(dir, { recursive: true });
  const epFile = path.join(dir, "episodes.jsonl");
  const key = (r) => `${r.level}|${r.scenario}|${r.seed}|${r.sample}`;
  const existing = fs.existsSync(epFile) ? fs.readFileSync(epFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const prevHash = existing.find((e) => e.harnessHash)?.harnessHash;
  if (prevHash && !sameHarness(prevHash, hash)) throw new Error(`${entry.id}: existing episodes use harness ${prevHash}, current code is ${hash}. Use a new --out.`);
  const setup = (e) => `${e.map ?? "factory"}|${(e.features ?? []).join("+")}`;
  if (existing.length && setup(existing[0]) !== setup({ map: mapName, features })) throw new Error(`${entry.id}: existing episodes were flown on ${setup(existing[0])}, this run is ${setup({ map: mapName, features })}. Use a new --out.`);
  const done = new Set(existing.map(key));
  const jobs = [];
  if (isBaseline) {
    for (const [ctl, level] of [["planner", "C1"], ["straight", "C2"], ["reactive", "C3"]])
      for (const sc of scenarios) for (const seed of seedsFor(sc)) jobs.push({ ctl, level, sc, seed, sample: 0 });
  } else if (program) {
    // One frozen program flies each route and wind once (it is deterministic).
    for (const sc of scenarios) for (const seed of seedsFor(sc)) jobs.push({ ctl: "program", level: "C3", sc, seed, sample: 0 });
  } else {
    for (const level of levels) for (const sc of scenarios) for (const seed of seedsFor(sc)) for (let sample = 0; sample < K; sample++) jobs.push({ ctl: "model", level, sc, seed, sample });
  }
  const todo = jobs.filter((j) => !done.has(key({ level: j.level, scenario: j.sc.id, seed: j.seed, sample: j.sample })));
  console.log(`\n${dirId}: ${jobs.length} episodes planned, ${jobs.length - todo.length} already done, ${todo.length} to run`);
  if (program && existing.length && todo.length) throw new Error(`${dirId}: a program run can't be resumed (the program would be written again). Use a new --out.`);

  let client = null;
  const settings = isBaseline || entry.backend ? null : resolveSettings(entry, registry.defaults ?? {});
  for (const w of settings?.warnings ?? []) console.log(`  note: ${w}`);
  let preflightResult = null;
  if (!isBaseline && todo.length) {
    if (fake) client = fakeChat(7);
    else if (entry.backend) {
      // Local Claude Code / Codex CLI (frontier models on the user's own login).
      client = makeCliClient({ backend: entry.backend, model: entry.model, effort: entry.effort ?? null, maxInFlight: Number(opt("--concurrency", entry.concurrency ?? 4)), logFile: path.join(dir, "calls.jsonl") });
    } else {
      if (!entry.baseUrl && (entry.provider === undefined || (entry.provider === null && !flag("--allow-unpinned")))) throw new Error(`${entry.id}: no host pin in the registry. Pick one with --endpoints ${entry.model}, or pass --allow-unpinned (host is then logged but not fixed).`);
      client = clientFor(ROOT, entry, { temperature: settings.temperature, maxTokens: settings.maxTokens, extraBody: settings.extraBody, maxInFlight: Number(opt("--concurrency", entry.concurrency ?? 24)), logFile: path.join(dir, "calls.jsonl") });
      preflightResult = await arenaPreflight(client, settings);
      console.log(`  preflight: ${preflightResult.provider ?? "endpoint"} answered (finish=${preflightResult.finish}, ${preflightResult.completionTokens ?? "?"} tokens${preflightResult.reasoningTokens ? `, ${preflightResult.reasoningTokens} reasoning` : ""}, ${preflightResult.latencyMs ?? "?"} ms)`);
      for (const p of preflightResult.problems) console.log(`  preflight problem: ${p}`);
      if (preflightResult.problems.length && single && !flag("--ignore-preflight")) {
        console.error(`\n${entry.id}: preflight failed, nothing flown. Fix models.json, or pass --ignore-preflight to fly anyway.`);
        process.exit(4);
      }
    }
  }
  const config = { id: entry.id, backend: entry.backend ?? "openrouter", model: entry.model ?? null, baseUrl: entry.baseUrl ?? null, provider: entry.provider ?? null, quantizations: entry.quantizations ?? null, extraBody: settings?.extraBody ?? entry.extraBody ?? null, effort: entry.effort ?? null, maxTokens: settings?.maxTokens ?? null, temperature: settings?.temperature ?? null, thinking: settings?.thinking ?? null, retry: settings?.retry ?? null, harness: "v0", harnessVersion: HARNESS_VERSION, harnessHash: hash, arenaHash, mode: MODE, policyBudget: program ? BUDGETS.arena : null, map: mapName, stage, prompt: profile, features, set: setName, fake: fake && !isBaseline, preflight: preflightResult };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 1));
  if (!todo.length) return { dir, config, settings, stats: null, practiced: null };

  // Every model call goes through the same two wrappers: the prompt is
  // rewritten for this environment, and each reply's finish is recorded (with
  // extra attempts on a cut-off reply only if models.json asks for them).
  const inst = client ? instrumentChat(localizeChat(client.chat, profile), { retryTruncated: settings?.retry.truncated ?? 0 }) : null;
  let practiced = null;
  if (program) {
    console.log(`  practising on ${sets.train.length} train routes, ${iters} versions`);
    practiced = await practice({ E, chat: inst.chat, iters, maxTokens: settings?.programMaxTokens ?? entry.programMaxTokens ?? 8000, log: (m) => console.log(m) });
    for (const v of practiced.versions) fs.writeFileSync(path.join(dir, `v${v.version}.js`), v.code);
    fs.writeFileSync(path.join(dir, "practice.json"), JSON.stringify({ task: practiced.task, best: practiced.best?.version ?? null, versions: practiced.versions.map(({ code, ...v }) => v) }, null, 1));
    if (practiced.best) fs.writeFileSync(path.join(dir, "best.js"), practiced.best.code);
    else console.log("  no version loaded and finished in time; the evaluation flies an empty program (it hovers)");
  }
  const bestCode = practiced?.best?.code ?? "";
  const CTL = {
    model: (sc, level) => rippleReach(world, sc, level, inst.chat, { harness: "v0", features, dt: 1, scene: E.scene }),
    program: (sc, level, seed) => programController(bestCode, { seed, randomSeed: programRandomSeed(seed, "separate"), budget: "arena" }),
    planner: (sc) => plannerReach(world, sc),
    straight: (sc) => straightReach(world, sc),
    reactive: (sc) => reactiveReach(world, sc),
  };
  const log = fs.createWriteStream(epFile, { flags: "a" });
  const t0 = Date.now();
  let n = 0, bad = 0, dropped = 0;
  await Promise.all(
    todo.map(async ({ ctl, level, sc, seed, sample }) => {
      let ep;
      try {
        ep = await runEpisode(new Reach(world, sc, seed, level), CTL[ctl](sc, level, seed));
      } catch (err) {
        // The host or the network failed, not the model: don't record the flight.
        if (!err?.transport) throw err;
        dropped++;
        return;
      }
      const re = replayEpisode(new Reach(world, sc, seed, level), ep.decisions);
      const replayOk = JSON.stringify(re) === JSON.stringify(ep.result);
      if (!replayOk) bad++;
      const counts = decisionCounts(ep.decisions);
      const row = {
        model: entry.id, condition: `${isBaseline ? ctl : dirId}@${level}`, ctl: isBaseline ? ctl : ctl === "program" ? "program" : "model", level, scenario: sc.id, seed, sample, dt: 1,
        straight_m: sc.straight_m, graph_m: sc.graph_m, harnessHash: hash, arenaHash, map: mapName, features, mode: isBaseline ? "baseline" : MODE,
        result: ep.result, replayOk, decisions: ep.decisions.length,
        invalid: ep.decisions.filter((d) => d.invalid || d.error).length,
        invalidTruncated: counts.truncatedInvalid, truncatedUsable: counts.truncatedUsable, timeouts: counts.timeouts,
        progress: Math.max(0, 1 - ep.result.minGoalDist / sc.straight_m),
      };
      log.write(JSON.stringify({ ...row, decisionLog: ep.decisions.map(({ obs, ...d }) => d), frames: ep.frames }) + "\n");
      n++;
      const msg = `${n}/${todo.length} episodes, ${inst?.stats.calls ?? 0} calls, ${Math.round((Date.now() - t0) / 1000)} s`;
      if (process.stdout.isTTY) process.stdout.write(`\r  ${msg}   `);
      else if (n === todo.length || n % Math.max(1, Math.round(todo.length / 10)) === 0) console.log(`  ${msg}`);
    }),
  );
  await new Promise((r) => log.end(r));
  console.log();
  if (bad) console.log(`  WARNING: ${bad} episodes did not replay exactly`);
  if (dropped) {
    console.log(`  ${dropped} flights were dropped because the host or network failed. They are not scored. Run the same command again to fly them.`);
    process.exitCode = 3;
  }
  const stats = inst ? summarizeStats(inst.stats, entry.price ?? null) : null;
  fs.appendFileSync(path.join(dir, "ledger.jsonl"), JSON.stringify({ at: new Date().toISOString(), episodes: n, wallSeconds: Math.round((Date.now() - t0) / 1000), ledger: client?.ledger ?? null, arena: stats }) + "\n");
  client?.close();
  return { dir, config, settings, stats, practiced };
}

// The scorecard for one model's folder (all flights in it, this invocation's call stats).
function writeScorecard(entry, ran) {
  const rows = fs.readFileSync(path.join(ran.dir, "episodes.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const practiceFile = path.join(ran.dir, "practice.json");
  const prog = ran.practiced ?? (fs.existsSync(practiceFile) ? (() => { const p = JSON.parse(fs.readFileSync(practiceFile, "utf8")); return { versions: p.versions, best: p.best ? { version: p.best } : null }; })() : null);
  const S = buildScorecard({
    config: {
      model: { id: entry.id, model: entry.model ?? null, baseUrl: entry.baseUrl ?? null, provider: entry.provider ?? null, fake: fake },
      environment: { name: mapName, stage, scene: E.scene },
      mode: MODE, level: MODE === "program" ? "C3" : levels.join(","), set: setName,
      settings: { ...(ran.settings ?? {}), programMaxTokens: ran.settings?.programMaxTokens ?? entry.programMaxTokens ?? 8000, warnings: undefined },
      harness: { version: HARNESS_VERSION, hash, arenaHash },
      policyBudget: MODE === "program" ? BUDGETS.arena : null,
    },
    rows, stats: ran.stats, program: MODE === "program" ? prog : null,
  });
  fs.writeFileSync(path.join(ran.dir, "scorecard.json"), JSON.stringify(S, null, 1));
  const md = scorecardMarkdown(S);
  fs.writeFileSync(path.join(ran.dir, "SCORECARD.md"), md);
  console.log("\n" + md);
  console.log(`scorecard: ${path.relative(process.cwd(), path.join(ran.dir, "scorecard.json"))}`);
  return S;
}

if (flag("--baselines")) await runModel({ id: "baselines" });
const ids = (opt("--models", "") || "").split(",").filter(Boolean);
for (const id of ids) {
  const entry = id === "fake" ? { id: "fake", model: "fake", provider: "fake" } : registry.models.find((m) => m.id === id);
  if (!entry) throw new Error(`unknown model id ${id} (see sim/bench/models.json)`);
  if (id === "fake" && !fake) throw new Error("model 'fake' needs --fake");
  const ran = await runModel(entry);
  if (single || flag("--scorecard")) writeScorecard(entry, ran);
}
if (!ids.length && !flag("--baselines")) console.log("nothing to run: pass --models and/or --baselines");
console.log(`\nharness ${HARNESS_VERSION} (${hash}); report: node sim/tools/bench_report.mjs ${path.relative(ROOT, outDir)}`);
if (demo) {
  const report = execFileSync(process.execPath, [path.join(ROOT, "sim/tools/bench_report.mjs"), outDir], { encoding: "utf8" });
  const who = { fake: "stand-in model (flies straight at the goal)", planner: "planner with the full map", straight: "scripted: straight at the goal", reactive: "scripted: hand-written wall avoider" };
  const cells = report.split("## All cells")[1].split("##")[0].split("\n").filter((l) => l.startsWith("| ")).slice(1).map((l) => l.split("|").map((c) => c.trim()));
  console.log("\nRoutes finished, out of four in the factory:\n");
  for (const c of cells) console.log(`  ${String(c[5].split(" ")[0]).padStart(4)}  ${who[c[1]] ?? c[1]}`);
  console.log("");
  console.log("Next: put your own model in place of the stand-in (README, \"Add your model\").");
}
