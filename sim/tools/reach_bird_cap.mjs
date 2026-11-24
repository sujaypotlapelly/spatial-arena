// Code as policy for Reach with a bird (sim/src/gym/reach_bird.js), modelled on
// reach_cap.mjs. Ripple writes policy(obs, memory) with obs.bird described in
// the task; the simulator flies it on the bird TRAIN scenarios and returns
// verified per-flight results (where it was caught and what its sensors read
// there); Ripple revises. The best version on train is frozen and flown on the
// bird DEV scenarios. Dev results never reach the model and play no part in
// selection. There is no bird test set.
//   node sim/tools/reach_bird_cap.mjs --runs 3 --iters 6 --out <dir>
// Outputs per run: v<k>.js, v<k>-train.json, best.js, curve.json; then
// dev/episodes.jsonl and dev/summary.json for the frozen best of each run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v } from "../src/world.js";
import { runEpisode, replayEpisode } from "../src/gym/core.js";
import { ReachBird, BIRD_SENSE_RANGE } from "../src/gym/reach_bird.js";
import { extractCode, programController, compilePolicy, programRandomSeed } from "../src/gym/policy_sandbox.js";
import { makeClient, preflight } from "./ripple_client.mjs";
import { loadFactory, loadBirdSets } from "./reach_bird_scenarios.mjs";
import { tally, flightScore } from "./reach_bird_eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../..");
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const RUNS = Number(opt("--runs", 3));
const ITERS = Number(opt("--iters", 6));
const TRAIN_SEEDS = Number(opt("--train-seeds", 2));
const RANDOM = opt("--random", "separate");
programRandomSeed(1, RANDOM);
const MAX_TOKENS = Number(opt("--max-tokens", 8000));
const outDir = path.resolve(opt("--out", path.join(root, "runs/reach-bird/cap")));
fs.mkdirSync(outDir, { recursive: true });

const { world } = loadFactory();
const S = loadBirdSets();
// --train train (practice set v2, default) | train_v1 (the set cap1 used).
const TRAIN_SET = opt("--train", "train");
if (!["train", "train_v1"].includes(TRAIN_SET)) throw new Error("--train must be train or train_v1");
const train = S[TRAIN_SET];
const HAS_ABSENT = train.some((s) => s.bird.strategy === "absent");
const dev = S.dev;
const r1 = (p) => p.map((x) => Math.round(x * 10) / 10);
const NF = train.length * TRAIN_SEEDS;

// ---------- evaluation (local, no API) ----------
async function evaluate(code, scenarios, nSeeds) {
  const compiled = compilePolicy(code);
  if (compiled.error) return { compileError: compiled.error, eps: [], reached: 0, caught: 0, progress: 0, score: 0 };
  const eps = [];
  for (const sc of scenarios)
    for (const seed of sc.seeds.slice(0, nSeeds)) {
      const inner = programController(code, { seed, randomSeed: programRandomSeed(seed, RANDOM) });
      const ctl = async (obs) => ({ ...(await inner(obs)), obsSnap: obs });
      const ep = await runEpisode(new ReachBird(world, sc, seed), ctl);
      const re = replayEpisode(new ReachBird(world, sc, seed), ep.decisions);
      eps.push({ sc, seed, ep, exact: JSON.stringify(re) === JSON.stringify(ep.result), progress: Math.max(0, 1 - ep.result.minGoalDist / sc.straight_m) });
    }
  const c = (o) => eps.filter((e) => e.ep.result.outcome === o).length;
  return {
    eps,
    reached: c("reached"),
    caught: c("caught"),
    timeout: c("timeout"),
    progress: eps.reduce((a, e) => a + e.progress, 0) / eps.length,
    score: Math.round(eps.reduce((a, e) => a + flightScore(e.ep.result.outcome, e.progress), 0) * 1000) / 1000,
    errors: eps.reduce((a, e) => a + e.ep.decisions.filter((d) => d.error).length, 0),
    exact: eps.filter((e) => e.exact).length,
  };
}
// Practice score per flight: reached 1; timed out 0.5 x progress; caught
// 0.25 x progress (progress = 1 - closest distance to goal / straight-line
// distance). So a flight that is not caught scores at least as much as a
// caught one that got no closer, and moving toward the goal always helps.
// (flightScore lives in reach_bird_eval.mjs so baselines report the same score.)
// Selection (--select score, default): most goals reached, then highest total
// score. --select v1 is the rule cap1 ran with: reached, then fewest caught,
// then most mean progress.
const SELECT = opt("--select", "score");
if (!["score", "v1"].includes(SELECT)) throw new Error("--select must be score or v1");
const better = (a, b) => !b || a.reached > b.reached || (a.reached === b.reached && (SELECT === "score" ? a.score > b.score : a.caught < b.caught || (a.caught === b.caught && a.progress > b.progress)));

// What the model gets back.
function report(res) {
  if (res.compileError) return `The program failed to load: ${res.compileError}`;
  const lines = res.eps.map((e, i) => {
    const r = e.ep.result;
    const verdict = r.outcome === "reached" ? `REACHED in ${r.time} s` : r.outcome === "caught" ? `CAUGHT by the bird at t=${r.time} s at ${JSON.stringify(r1(r.caughtAt))}, closest ${r.minGoalDist} m from goal` : `timed out, closest ${r.minGoalDist} m from goal`;
    return `${i + 1}. from ${JSON.stringify(r1(world.nodes[e.sc.start]))} to ${JSON.stringify(r1(world.nodes[e.sc.goal]))} (${e.sc.straight_m} m): ${verdict}; ${r.contacts} wall contacts; ${r.minBirdDist === null ? "no bird on this flight" : `bird came within ${r.minBirdDist} m`}`;
  });
  const details = [];
  for (const [i, e] of res.eps.entries()) {
    const r = e.ep.result;
    if (r.outcome === "reached" || details.length >= 6) continue;
    const D = e.ep.decisions;
    const parts = [];
    if (r.outcome === "caught") {
      // The last three decisions before the catch: what it sensed and what it did.
      const tail = D.slice(-3).map((d) => `t=${d.t}s position ${JSON.stringify(d.obsSnap.position)} velocity ${JSON.stringify(d.obsSnap.velocity)} bird ${JSON.stringify(d.obsSnap.bird)} free_space_m ${JSON.stringify(d.obsSnap.free_space_m)} -> you returned ${JSON.stringify(d.command)}`);
      const firstSeen = D.find((d) => d.obsSnap.bird?.visible);
      parts.push(`caught at t=${r.time}s at ${JSON.stringify(r1(r.caughtAt))}. ${firstSeen ? `Your sensor first reported the bird at t=${firstSeen.t}s, ${firstSeen.obsSnap.bird.distance_m} m away.` : "Your sensor never reported the bird before the catch."} Last decisions:\n    ${tail.join("\n    ")}`);
    } else {
      let stuck = null;
      for (let k = 5; k < D.length && !stuck; k++) if (v.dist(D[k - 5].obsSnap.position, D[k].obsSnap.position) < 1) stuck = D[k];
      if (stuck) parts.push(`stuck from about t=${stuck.t}s at ${JSON.stringify(stuck.obsSnap.position)}; sensors there: ${JSON.stringify({ goal: stuck.obsSnap.goal, free_space_m: stuck.obsSnap.free_space_m, velocity: stuck.obsSnap.velocity, bird: stuck.obsSnap.bird })}; your program returned ${JSON.stringify(stuck.command)}`);
    }
    const err = D.find((d) => d.error);
    if (err) parts.push(`runtime error at t=${err.t}s: ${err.error}`);
    if (parts.length) details.push(`Flight ${i + 1}: ${parts.join("; ")}`);
  }
  return `${lines.join("\n")}\n\nOverall: reached ${res.reached}/${res.eps.length}, caught by the bird ${res.caught}/${res.eps.length}, timed out ${res.timeout}/${res.eps.length}, mean progress toward the goal ${Math.round(res.progress * 100)}%, ${res.errors} runtime errors.${details.length ? `\n\nDetails on failed flights:\n${details.join("\n")}` : ""}`;
}

// ---------- prompt ----------
const P = world.physics;
const exampleObs = new ReachBird(world, train[0], 1).observe();
const TASK = `You are writing the flight controller for a small drone in a physics simulator. The building is a 3D scan of a real factory: halls, rooms, pillars, machinery and clutter. There is no map: your program only sees the drone's own sensors. A bird lives in the building and attacks drones: if it gets within ${P.catchDistance} m of the drone, the flight ends as CAUGHT.

Write a JavaScript function:

  function policy(obs, memory) {
    // ...
    return { velocity: [vx, vy, vz] };
  }

It is called once per second of simulated time; the drone holds the returned velocity (m/s, vector length at most 5.5) for that second. "memory" is an object that persists across calls within one flight and starts empty: keep any state you want in it (modes, visited places, where the bird was).

Axes: +x is east, +z is north, +y is up (height), in metres. The drone is a sphere of radius 0.25 m, top speed 5.5 m/s, accelerates at up to 7 m/s^2, and is pushed by random wind gusts. Touching anything slows it (it slides along the surface) and counts as a wall contact. The goal is reached within 1 m; each flight has 90 s. Routes are 15-35 m long and a straight line to the goal is always blocked, so the drone must find a way around obstacles.

The bird: a sphere of radius ${P.birdRadius} m, top speed ${P.birdMaxSpeed} m/s (slower than the drone), accelerates at up to ${P.birdMaxAccel} m/s^2, and flies around walls. Different birds behave differently: some chase the drone from the start, some aim where the drone is heading, some wait in one place and attack when the drone comes into view, some patrol back and forth. A chasing bird tires after about ${P.birdStamina} s, flies back to its home and rests for about ${P.birdRest} s before hunting again.

obs fields:
  time_s, time_left_s, wall_contacts_so_far
  position [x, y, z], velocity [vx, vy, vz]
  goal: { position [x, y, z], distance_m, in_line_of_sight (true if a straight line to it is clear) }
  free_space_m: { east, north_east, north, north_west, west, south_west, south, south_east, up, down } = how far (metres, 0 to 12, in 0.25 m steps) the drone can move from where it is in that direction before touching something. Horizontal directions are at the drone's current height.
  bird: while the bird is in direct line of sight and within ${BIRD_SENSE_RANGE} m: { visible: true, position [x, y, z], velocity [vx, vy, vz], distance_m }. Otherwise: { visible: false, last_seen_s_ago } (null if never seen). Nothing tells you where a hidden bird is.${HAS_ABSENT ? " On some practice flights there is no bird at all; the sensor then always reads { visible: false }." : ""}
Example obs: ${JSON.stringify(exampleObs)}
Example obs.bird while visible: {"visible":true,"position":[-3.2,1.1,-7.5],"velocity":[2.9,0,1.4],"distance_m":6.3}

Rules: plain JavaScript (ES2020), no imports, no network, no timers, no global state outside "memory". Math.random is available (seeded, so runs are repeatable). Each call must return within 50 ms.`;

const SYS = "You write robust, well-commented JavaScript. Reply with exactly one ```js code block.";
const firstMessages = () => [
  { role: "system", content: SYS },
  { role: "user", content: `${TASK}\n\nWrite the program. Start it with a short comment explaining your strategy.` },
];
const reviseMessages = (code, rep, curve, failed) => [
  { role: "system", content: SYS },
  {
    role: "user",
    content: `${TASK}\n\nYour best program so far:\n\`\`\`js\n${code}\n\`\`\`\n${failed ? `\nYour most recent revision (v${failed.version}) could not be used: ${failed.error}. Start again from the best program above.\n` : ""}\nScores of your versions so far on the ${NF} training flights: ${curve.map((c) => `v${c.version}: reached ${c.reached}/${NF}, caught ${c.caught}/${NF}${SELECT === "score" ? `, score ${c.score}` : ""}`).join("; ")}.${SELECT === "score" ? ` (Versions are ranked by goals reached, then by score: each flight scores 1 if it reaches the goal, half its progress toward the goal if it times out, and a quarter of its progress if it is caught.)` : ""}\n\nSimulator results for the best program on the ${NF} training flights:\n${rep}\n\nRevise the program so the drone reaches more goals without being caught. Reply with the complete new program in one \`\`\`js block, starting with a comment that says what you changed and why.`,
  },
];

if (args.includes("--print-prompt")) { console.log(TASK); process.exit(0); }

// ---------- loop ----------
// --env-root: the checkout whose .env holds the key (a worktree has none).
const client = makeClient({ root: path.resolve(opt("--env-root", root)), maxInFlight: RUNS, logFile: path.join(outDir, "calls.jsonl"), maxTokens: MAX_TOKENS });
fs.writeFileSync(path.join(outDir, "plan.json"), JSON.stringify({ at: new Date().toISOString(), map: "factory", scenarioFile: "sim/scenarios/reach-bird-factory.json", train: train.map((s) => s.id), dev: dev.map((s) => s.id), programRandom: RANDOM, runs: RUNS, iters: ITERS, trainSeeds: TRAIN_SEEDS, trainSet: TRAIN_SET, select: SELECT, selection: SELECT === "score" ? "reached, then total practice score (train only)" : "reached, then fewest caught, then progress (train only)", prompt: TASK }, null, 1));
console.log(`preflight ok on ${await preflight(client)}`);
const t0 = Date.now();
const bests = [];
await Promise.all(
  Array.from({ length: RUNS }, async (_, run) => {
    const dir = path.join(outDir, `run${run}`);
    fs.mkdirSync(dir, { recursive: true });
    const curve = [];
    let base = null, failed = null;
    for (let k = 1; k <= ITERS; k++) {
      const msgs = !base ? firstMessages() : reviseMessages(base.code, report(base.res), curve, failed);
      const reply = await client.chat(msgs, { role: "programmer", run, version: k }, { max_tokens: MAX_TOKENS });
      const code = extractCode(reply.content) || "";
      fs.writeFileSync(path.join(dir, `v${k}.js`), code);
      const res = await evaluate(code, train, TRAIN_SEEDS);
      if (res.compileError || reply.finish === "length") failed = { version: k, error: reply.finish === "length" ? `the reply was cut off at the output limit (${MAX_TOKENS} tokens), so the program was incomplete${res.compileError ? ` (${res.compileError})` : ""}` : res.compileError };
      else {
        failed = null;
        if (better(res, base?.res)) base = { version: k, code, res };
      }
      const row = { version: k, base: base?.version ?? null, reached: res.reached, caught: res.caught, score: res.score ?? 0, timeout: res.timeout ?? null, progress: res.progress, errors: res.errors ?? null, exact: res.exact ?? null, compileError: res.compileError ?? null, codeChars: code.length, finish: reply.finish };
      curve.push(row);
      fs.writeFileSync(path.join(dir, `v${k}-train.json`), JSON.stringify({ ...row, report: report(res) }, null, 1));
      console.log(`run ${run} v${k}: train reached ${res.reached}/${NF}, caught ${res.caught}/${NF}, score ${res.score}${res.compileError ? ` (${res.compileError.slice(0, 60)})` : ""} [${Math.round((Date.now() - t0) / 1000)} s]`);
    }
    const usable = curve.filter((c) => !c.compileError && c.finish !== "length");
    const best = usable.length ? usable.reduce((a, c) => (better(c, a) ? c : a), null) : null;
    if (best) fs.copyFileSync(path.join(dir, `v${best.version}.js`), path.join(dir, "best.js"));
    fs.writeFileSync(path.join(dir, "curve.json"), JSON.stringify({ curve, best: best?.version ?? null }, null, 1));
    bests[run] = best?.version ?? null;
    console.log(`run ${run}: best on train = ${best ? `v${best.version}` : "none usable"}`);
  }),
);
fs.writeFileSync(path.join(outDir, "ledger.json"), JSON.stringify(client.ledger, null, 1));
client.close();

// ---------- frozen best of each run, flown once on dev ----------
const devDir = path.join(outDir, "dev");
fs.mkdirSync(devDir, { recursive: true });
const out = fs.createWriteStream(path.join(devDir, "episodes.jsonl"));
const summary = { at: new Date().toISOString(), set: "dev", noBird: false, map: "factory", programRandom: RANDOM, conditions: {} };
for (let run = 0; run < RUNS; run++) {
  if (bests[run] == null) continue;
  const file = path.join(outDir, `run${run}`, "best.js");
  const code = fs.readFileSync(file, "utf8");
  const res = await evaluate(code, dev, 2);
  const cond = `ripple-cap-run${run}-v${bests[run]}`;
  for (const e of res.eps) out.write(JSON.stringify({ condition: cond, scenario: e.sc.id, seed: e.seed, strategy: e.sc.bird.strategy, noBird: false, result: e.ep.result, exact: e.exact, score: Math.round(flightScore(e.ep.result.outcome, e.progress) * 1000) / 1000, decisionLog: e.ep.decisions.map((d) => ({ t: d.t, command: d.command, ...(d.say ? { say: d.say } : {}), ...(d.error ? { error: d.error } : {}) })), frames: e.ep.frames }) + "\n");
  summary.conditions[cond] = tally(res.eps.map((e) => ({ result: e.ep.result, exact: e.exact, score: flightScore(e.ep.result.outcome, e.progress) })));
  console.log(`dev ${cond}: ${JSON.stringify(summary.conditions[cond])}`);
}
out.end();
fs.writeFileSync(path.join(devDir, "summary.json"), JSON.stringify(summary, null, 1));
console.log("done", outDir);
