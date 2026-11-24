// Code as policy for Reach: Ripple writes the
// navigation program, the simulator tests it on TRAIN routes, Ripple reads the
// verified results and revises. The best version on train is frozen. Dev and
// held-out routes never reach the model; scoring every version on dev
// afterwards is analysis only and plays no part in selection.
//   node sim/tools/reach_cap.mjs --runs 3 --iters 6 --out runs/reach/cap
// Outputs per run: v<k>.js, v<k>-train.json, best.js, curve.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v } from "../src/world.js";
import { Reach } from "../src/gym/reach.js";
import { runEpisode } from "../src/gym/core.js";
import { extractCode, programController, compilePolicy, programRandomSeed } from "../src/gym/policy_sandbox.js";
import { makeClient, preflight, modelEntry, clientFor } from "./ripple_client.mjs";
import { loadEnvironment, pinScenarios } from "./benchmark_env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../..");
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const RUNS = Number(opt("--runs", 3));
const ITERS = Number(opt("--iters", 6));
const outDir = path.resolve(opt("--out", path.join(root, "runs/reach/cap")));
// v5 harness options (defaults reproduce v3/v4 exactly): --sensors lidar, --feedback rich.
const SENSORS = opt("--sensors", "basic");
// --random separate (default) | legacy: see reach_eval.mjs. Recorded in plan.json.
const RANDOM = opt("--random", "separate");
programRandomSeed(1, RANDOM);
const FEEDBACK = opt("--feedback", "basic");
// --train-seeds N (fly each train route with its first N wind seeds; default 1)
// --population-from K (from version K, revise from the best program any run found when it beats this run's own)
const TRAIN_SEEDS = Number(opt("--train-seeds", 1));
const POP_FROM = opt("--population-from") ? Number(opt("--population-from")) : null;
const global = { best: null };
fs.mkdirSync(outDir, { recursive: true });
// --map: which benchmark environment (sim/scenes/benchmark-sets.json). Only the
// scene description and route-length sentence of the prompt change with it.
// --mix a,b (transfer study; off by default): practise
// on the TRAIN routes of several environments at once. Every version is flown on
// all of them, the feedback lists results per place, and selection uses the pooled
// score. The prompt only states the places (their scene sentences, the same text
// as single-environment practice); it says nothing about how to handle them.
const MIX = opt("--mix") ? opt("--mix").split(",") : null;
if (MIX && opt("--map")) throw new Error("use --mix or --map, not both");
if (MIX && (MIX.length < 2 || new Set(MIX).size !== MIX.length)) throw new Error("--mix needs two or more different environments");
const ENVS = (MIX ?? [opt("--map", "factory")]).map(loadEnvironment);
for (const e of ENVS) pinScenarios(e);
const E = ENVS[0];
const world = E.world;
const train = ENVS.flatMap((e) => e.sets.train);
for (const e of ENVS) if (!e.sets.train.length) throw new Error(`map ${e.name} has no training routes`);
// Which environment each train route belongs to (route ids are unique across environments).
const envOf = new Map(ENVS.flatMap((e, i) => e.sets.train.map((sc) => [sc, { e, place: i + 1 }])));
if (new Set(train.map((sc) => sc.id)).size !== train.length) throw new Error("train route ids collide across environments");
const worldOf = (sc) => envOf.get(sc).e.world;
const r1 = (p) => p.map((x) => Math.round(x * 10) / 10);

// ---------- evaluation on train (local, no API) ----------
async function evaluate(code, scenarios) {
  const compiled = compilePolicy(code);
  if (compiled.error) return { compileError: compiled.error, eps: [], reached: 0, progress: 0 };
  const eps = [];
  for (const sc of scenarios) for (const seed of sc.seeds.slice(0, TRAIN_SEEDS)) {
    const inner = programController(code, { seed, randomSeed: programRandomSeed(seed, RANDOM) });
    const ctl = async (obs) => ({ ...(await inner(obs)), obsSnap: obs });
    const ep = await runEpisode(new Reach(worldOf(sc), sc, seed, "C3", { sensors: SENSORS }), ctl);
    eps.push({ sc, ep, progress: Math.max(0, 1 - ep.result.minGoalDist / sc.straight_m) });
  }
  return {
    eps,
    reached: eps.filter((e) => e.ep.result.outcome === "reached").length,
    progress: eps.reduce((a, e) => a + e.progress, 0) / eps.length,
    contactsPerMin: eps.reduce((a, e) => a + e.ep.result.contacts, 0) / eps.reduce((a, e) => a + e.ep.result.time / 60, 0),
    errors: eps.reduce((a, e) => a + e.ep.decisions.filter((d) => d.error).length, 0),
  };
}

// What the model gets back: per-route verdicts, plus for failures where it
// got stuck (and what its sensors read there) and its first runtime error.
function report(res) {
  if (res.compileError) return `The program failed to load: ${res.compileError}`;
  const lines = res.eps.map((e, i) => {
    const r = e.ep.result;
    const W = worldOf(e.sc);
    return `${i + 1}. ${MIX ? `place ${envOf.get(e.sc).place}, ` : ""}from ${JSON.stringify(r1(W.nodes[e.sc.start]))} to ${JSON.stringify(r1(W.nodes[e.sc.goal]))} (${e.sc.straight_m} m): ${r.outcome === "reached" ? `REACHED in ${r.time} s` : `failed, closest ${r.minGoalDist} m from goal`}, ${r.contacts} wall contacts`;
  });
  const details = [];
  for (const [i, e] of res.eps.entries()) {
    if (e.ep.result.outcome === "reached") continue;
    const D = e.ep.decisions;
    // stuck: moved less than 1 m over 5 decisions
    let stuck = null;
    for (let k = 5; k < D.length && !stuck; k++) {
      const a = D[k - 5].obsSnap.position, b = D[k].obsSnap.position;
      if (v.dist(a, b) < 1) stuck = D[k];
    }
    const err = D.find((d) => d.error);
    const parts = [];
    if (stuck) parts.push(`stuck from about t=${stuck.t}s at ${JSON.stringify(stuck.obsSnap.position)}; sensors there: ${JSON.stringify({ goal: stuck.obsSnap.goal, free_space_m: stuck.obsSnap.free_space_m, velocity: stuck.obsSnap.velocity })}; your program returned ${JSON.stringify(stuck.command)}`);
    if (err) parts.push(`runtime error at t=${err.t}s: ${err.error}`);
    if (FEEDBACK === "rich" && details.length < 3) parts.push(`\n${sketch(e)}`);
    if (parts.length && details.length < 6) details.push(`Flight ${i + 1}: ${parts.join("; ")}`);
  }
  // Per-place totals (mixed practice only).
  const places = !MIX ? "" : "\n" + ENVS.map((_, i) => {
    const pe = res.eps.filter((e) => envOf.get(e.sc).place === i + 1);
    return `Place ${i + 1}: reached ${pe.filter((e) => e.ep.result.outcome === "reached").length}/${pe.length}, mean progress toward the goal ${Math.round((pe.reduce((a, e) => a + e.progress, 0) / pe.length) * 100)}%, ${pe.reduce((a, e) => a + e.ep.result.contacts, 0)} wall contacts.`;
  }).join("\n");
  return `${lines.join("\n")}${places}\n\nOverall: reached ${res.reached}/${res.eps.length}, mean progress toward the goal ${Math.round(res.progress * 100)}%, ${res.contactsPerMin.toFixed(1)} wall contacts per minute, ${res.errors} runtime errors.${details.length ? `\n\nDetails on failed flights:\n${details.join("\n")}` : ""}`;
}

// Top-down sketch of the drone's OWN path plus its known goal (reach gives the
// goal position): 2 m cells, north up. S launch, G goal, E end, o visited, x contact.
function sketch(e) {
  const f = e.ep.frames, c = 2, s0 = f[0], g = worldOf(e.sc).nodes[e.sc.goal];
  const cell = (x, z) => [Math.floor((x - s0[1]) / c), Math.floor((z - s0[3]) / c)];
  const pts = f.map((p) => cell(p[1], p[3])), gc = cell(g[0], g[2]);
  const xs = [...pts.map((p) => p[0]), gc[0]], zs = [...pts.map((p) => p[1]), gc[1]];
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  if (x1 - x0 > 60 || z1 - z0 > 40) return "(path too large to sketch)";
  const grid = Array.from({ length: z1 - z0 + 1 }, () => Array(x1 - x0 + 1).fill(" "));
  for (const [x, z] of pts) grid[z - z0][x - x0] = "o";
  let prev = 0;
  for (const d of e.ep.decisions) { const k = d.obsSnap?.wall_contacts_so_far ?? 0; if (k > prev) { const [x, z] = cell(d.obsSnap.position[0], d.obsSnap.position[2]); grid[z - z0][x - x0] = "x"; } prev = k; }
  grid[pts.at(-1)[1] - z0][pts.at(-1)[0] - x0] = "E"; grid[pts[0][1] - z0][pts[0][0] - x0] = "S"; grid[gc[1] - z0][gc[0] - x0] = "G";
  return `  Own path, top-down, north up, 2 m cells (S launch, G goal, E end, o visited, x contact began):\n${grid.slice().reverse().map((r) => "  |" + r.join("")).join("\n")}`;
}

// ---------- prompts ----------
const exampleObs = new Reach(world, train[0], 1, "C3", { sensors: SENSORS }).observe();
const SCENE = !MIX ? E.scene : `The program is flown in ${ENVS.length} different places. ${ENVS.map((e, i) => `Place ${i + 1}: ${e.scene}`).join(" ")}`;
const ROUTE_TEXT = !MIX ? E.routeText : [...new Set(ENVS.map((e) => e.routeText))].join("; ");
const TASK = `You are writing the flight controller for a small drone in a physics simulator. ${SCENE} There is no map: your program only sees the drone's own sensors.

Write a JavaScript function:

  function policy(obs, memory) {
    // ...
    return { velocity: [vx, vy, vz] };
  }

It is called once per second of simulated time; the drone holds the returned velocity (m/s, vector length at most 5.5) for that second. "memory" is an object that persists across calls within one flight and starts empty: keep any state you want in it (modes, visited places, a sketch of walls you have seen).

Axes: +x is east, +z is north, +y is up (height), in metres. The drone is a sphere of radius 0.25 m, accelerates at up to 7 m/s^2, and is pushed by random wind gusts. Touching anything slows it (it slides along the surface) and counts as a wall contact. The goal is reached within 1 m; each flight has 90 s. ${ROUTE_TEXT} and a straight line to the goal is always blocked, so the drone must find a way around obstacles.

obs fields:
  time_s, time_left_s, wall_contacts_so_far
  position [x, y, z], velocity [vx, vy, vz]
  goal: { position [x, y, z], distance_m, in_line_of_sight (true if a straight line to it is clear) }
  free_space_m: { east, north_east, north, north_west, west, south_west, south, south_east, up, down } = how far (metres, 0 to 12, in 0.25 m steps) the drone can move from where it is in that direction before touching something. Horizontal directions are at the drone's current height.${SENSORS === "lidar" ? `\n  scan: { bearings_deg, horizontal_m, up30_m, down30_m, max_range } = a 32-ray range scan to the first surface (0 to 20 m): horizontal_m[i] at bearings_deg[i] (degrees counter-clockwise from east, so 90 = north), plus 8 rays tilted 30 degrees up and 8 tilted 30 degrees down every 45 degrees starting east. Use it to map your surroundings.` : ""}
Example obs: ${JSON.stringify(exampleObs)}

Rules: plain JavaScript (ES2020), no imports, no network, no timers, no global state outside "memory". Math.random is available (seeded, so runs are repeatable). Each call must return within 50 ms.`;

const firstMessages = () => [
  { role: "system", content: "You write robust, well-commented JavaScript. Reply with exactly one ```js code block." },
  { role: "user", content: `${TASK}\n\nWrite the program. Start it with a short comment explaining your strategy.` },
];
const NF = () => train.length * TRAIN_SEEDS;
const reviseMessages = (code, rep, curve, failed, shared = false) => [
  { role: "system", content: "You write robust, well-commented JavaScript. Reply with exactly one ```js code block." },
  {
    role: "user",
    content: `${TASK}\n\n${shared ? "The best program found so far (by any of several parallel attempts)" : "Your best program so far"}:\n\`\`\`js\n${code}\n\`\`\`\n${failed ? `\nYour most recent revision (v${failed.version}) could not be used: ${failed.error}. Start again from the best program above.\n` : ""}\nScores of your versions so far on the ${NF()} training flights: ${curve.map((c) => `v${c.version}: reached ${c.reached}/${NF()}, progress ${Math.round(c.progress * 100)}%`).join("; ")}.\n\nSimulator results for the best program on the ${NF()} training flights:\n${rep}\n\nRevise the program so the drone reaches more goals. Reply with the complete new program in one \`\`\`js block, starting with a comment that says what you changed and why.`,
  },
];

// ---------- loop ----------
const MAX_TOKENS = Number(opt("--max-tokens", 8000));
if (args.includes("--print-prompt")) { console.log(TASK); process.exit(0); }
// --model <id>: let a model from sim/bench/models.json write the programs instead of Ripple.
const MODEL_ID = opt("--model");
const clientOpts = { maxInFlight: RUNS, logFile: path.join(outDir, "calls.jsonl"), maxTokens: MAX_TOKENS };
const client = MODEL_ID ? clientFor(root, modelEntry(root, MODEL_ID), clientOpts) : makeClient({ root, ...clientOpts });
fs.writeFileSync(path.join(outDir, "plan.json"), JSON.stringify({ at: new Date().toISOString(), map: E.name, ...(MIX ? { mix: MIX, trainRoutes: Object.fromEntries(ENVS.map((e) => [e.name, e.sets.train.map((sc) => sc.id)])) } : {}), programRandom: RANDOM, runs: RUNS, iters: ITERS, sensors: SENSORS, feedback: FEEDBACK, trainSeeds: TRAIN_SEEDS, populationFrom: POP_FROM, prompt: TASK }, null, 1));
console.log(`preflight ok on ${await preflight(client)}`);
const t0 = Date.now();
await Promise.all(
  Array.from({ length: RUNS }, async (_, run) => {
    const dir = path.join(outDir, `run${run}`);
    fs.mkdirSync(dir, { recursive: true });
    const curve = [];
    let code = null, res = null;
    // Loop v2: always revise from the best WORKING version so far (a broken or
    // truncated attempt is reported back but never becomes the base).
    let base = null; // { version, code, res }
    let failed = null;
    for (let k = 1; k <= ITERS; k++) {
      const better = (a, b) => !b || a.res.progress > b.res.progress || (a.res.progress === b.res.progress && a.res.reached > b.res.reached);
      const useGlobal = POP_FROM != null && k >= POP_FROM && global.best && global.best.run !== run && better(global.best, base);
      const from = useGlobal ? global.best : base;
      const msgs = !from ? firstMessages() : reviseMessages(from.code, report(from.res), curve, failed, useGlobal);
      const reply = await client.chat(msgs, { role: "programmer", run, version: k }, { max_tokens: MAX_TOKENS });
      code = extractCode(reply.content) || "";
      fs.writeFileSync(path.join(dir, `v${k}.js`), code);
      res = await evaluate(code, train);
      if (res.compileError || reply.finish === "length") failed = { version: k, error: reply.finish === "length" ? `the reply was cut off at the output limit (${MAX_TOKENS} tokens), so the program was incomplete${res.compileError ? ` (${res.compileError})` : ""}` : res.compileError };
      else {
        failed = null;
        if (!base || res.progress > base.res.progress || (res.progress === base.res.progress && res.reached > base.res.reached)) base = { version: k, code, res };
        if (!global.best || res.progress > global.best.res.progress || (res.progress === global.best.res.progress && res.reached > global.best.res.reached)) global.best = { run, version: k, code, res };
      }
      const row = { version: k, base: base?.version ?? null, reached: res.reached, progress: res.progress, contactsPerMin: res.contactsPerMin ?? null, errors: res.errors ?? null, compileError: res.compileError ?? null, codeChars: code.length, finish: reply.finish };
      curve.push(row);
      fs.writeFileSync(path.join(dir, `v${k}-train.json`), JSON.stringify({ ...row, report: report(res) }, null, 1));
      console.log(`run ${run} v${k}: train reached ${res.reached}/${NF()}, progress ${Math.round(res.progress * 100)}%${res.compileError ? ` (${res.compileError.slice(0, 60)})` : ""} [${Math.round((Date.now() - t0) / 1000)} s]`);
    }
    // Freeze the best version on TRAIN (progress, then reached, then earliest).
    const best = [...curve].sort((a, b) => b.progress - a.progress || b.reached - a.reached || a.version - b.version)[0];
    fs.copyFileSync(path.join(dir, `v${best.version}.js`), path.join(dir, "best.js"));
    fs.writeFileSync(path.join(dir, "curve.json"), JSON.stringify({ curve, best: best.version }, null, 1));
    console.log(`run ${run}: best on train = v${best.version}`);
  }),
);
fs.writeFileSync(path.join(outDir, "ledger.json"), JSON.stringify(client.ledger, null, 1));
client.close();
console.log("done", path.relative(root, outDir));
