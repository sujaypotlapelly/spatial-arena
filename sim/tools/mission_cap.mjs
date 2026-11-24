#!/usr/bin/env node
// Code as policy for the search and delivery missions: the mission
// counterpart of reach_cap.mjs. Ripple writes a controller, the simulator
// flies it on the 12 TRAIN missions (wind seed 1), Ripple reads the verified
// results and revises. The best version on train is frozen per run. Dev and
// test missions never reach the model.
//   node sim/tools/mission_cap.mjs --map residential --task delivery --runs 24 --iters 8 \
//     --out runs/missions/cap/residential-delivery
// The prompt is identical across maps except for the one-sentence scene
// description (sim/scenes/benchmark-sets.json), so programs can be compared
// and transferred between environments.
// Outputs per run: v<k>.js, v<k>-train.json, best.js, curve.json; ledger.json, calls.jsonl.
import fs from "node:fs";
import path from "node:path";
import { RescueMission } from "../src/gym/rescue_tasks.js";
import { extractCode } from "../src/gym/policy_sandbox.js";
import { makeTrainer } from "../src/gym/mission_train.js";
import { better, pickFrozen, checkSelectMode } from "../src/gym/mission_select.js";
import { makeClient, preflight, modelEntry, clientFor } from "./ripple_client.mjs";
import { loadEnvironment, root } from "./benchmark_env.mjs";

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const E = loadEnvironment(opt("--map", "factory"));
const task = opt("--task", "search");
if (!["search", "delivery"].includes(task)) throw new Error("--task must be search or delivery");
// --sets v2: the missions v2 sets (sim/scenarios/mission-v2-<map>-<task>.json,
// built by sim/tools/mission_sets_v2.mjs). Default: the v4/v5 sets.
const SETS = opt("--sets", "");
const sets = JSON.parse(fs.readFileSync(path.join(root, `sim/scenarios/mission-${SETS ? `${SETS}-` : ""}${E.name}-${task}.json`), "utf8"));
const train = sets.train;
const RUNS = Number(opt("--runs", 3));
const ITERS = Number(opt("--iters", 8));
const DT = Number(opt("--dt", 1));
const MAX_TOKENS = Number(opt("--max-tokens", 8000));
// v5 harness options (defaults reproduce v4 exactly):
//   --sensors lidar   adds obs.scan (32 rays to 20 m)
//   --sensors map     lidar plus an onboard map built only from the drone's own
//                     scans (raw cells; missions v2). --sensors map-v5pilot is
//                     the v5 pilot's map, kept to re-fly those runs.
//   --feedback rich   adds, per failed flight, a top-down sketch of the drone's
//                     own path and coverage counts (own trajectory only)
const SENSORS = opt("--sensors", "basic");
const FEEDBACK = opt("--feedback", "basic");
//   --train-seeds 2   fly every train mission with its first N wind seeds (default 1)
//   --population-from K   from version K on, a run whose own best trails the best
//                     program any run has found revises from that program instead
const TRAIN_SEEDS = Number(opt("--train-seeds", 1));
const POP_FROM = opt("--population-from") ? Number(opt("--population-from")) : null;
// Missions v2 options. Defaults are for new runs; to re-derive a v4 or v5 pilot
// run pass --random legacy --select legacy.
//   --random separate|legacy  a program's Math.random seed: its own (separate)
//                     or the wind's (legacy, as the v4 and v5 pilot runs did)
//   --select earned|legacy    tie-break after success count: for search, ground
//                     the drone's own detector covered (earned) or closest
//                     approach to the hidden hiker (legacy); see mission_select.js
const RANDOM = opt("--random", "separate");
const SELECT = checkSelectMode(opt("--select", "earned"));
const global = { best: null }; // { run, version, code, res }
const outDir = path.resolve(opt("--out", path.join(root, "runs/missions/cap", `${E.name}-${task}`)));
if (fs.existsSync(path.join(outDir, "ledger.json")) && !args.includes("--overwrite")) throw new Error(`${path.relative(root, outDir)} already has a finished loop`);
fs.mkdirSync(outDir, { recursive: true });
const W = E.world;
const SUCCESS = task === "search" ? "found" : "delivered";

// ---------- evaluation on train (local, no API) ----------
// Shared with sim/tools/mission_replay_check.mjs: sim/src/gym/mission_train.js.
const trainer = makeTrainer({ world: W, task, dt: DT, sensors: SENSORS, feedback: FEEDBACK, trainSeeds: TRAIN_SEEDS, random: RANDOM, select: SELECT });
export const evaluate = trainer.evaluate;
const report = trainer.report;

// ---------- prompts ----------
const exampleObs = new RescueMission(W, train[0], 1, { sensors: SENSORS }).observe();
const m0 = train[0];
const AREA = m0.searchArea, DROP = m0.kind === "package-drop";
const OBJECTIVE = task === "search" && AREA
  ? `The job is search and rescue: find ONE lost hiker, represented by a beacon lying on open floor somewhere inside an assigned search area (a rectangle given as obs.search.area, about ${Math.round(AREA.max[0] - AREA.min[0])} x ${Math.round(AREA.max[1] - AREA.min[1])} m). Its exact position is unknown, and every open floor spot in the area is about equally likely. The hiker counts as found as soon as the drone is within ${m0.detectionRange} m of the beacon with a clear straight line of sight to it; the flight then ends. There is no goal position: the drone has to search the area. Each flight has ${m0.timeLimitSeconds} s. The drone launches inside the area, and the hiker is never visible from the launch point.`
  : DROP
  ? `The job is package delivery: carry a parcel to a marked landing pad (its position is given), descend over it, and release the parcel by returning { velocity: [...], release: true }. The parcel falls under gravity and keeps the drone's velocity at the moment of release, so release while nearly still. It counts as delivered when it lands on the pad surface within ${m0.padRadius} m of the pad centre, released from no more than ${m0.maxReleaseHeight} m above the pad. You get one release per flight. Each flight has ${m0.timeLimitSeconds} s. Pads are 15-35 m from the launch point and a straight line to them is always blocked.`
  : task === "search"
  ? `The job is search and rescue: find ONE lost hiker, represented by a beacon lying on the ground somewhere in the area. Its position is unknown. The hiker counts as found as soon as the drone is within ${m0.detectionRange} m of the beacon with a clear straight line of sight to it; the flight then ends. There is no goal position: the drone has to explore. Each flight has ${m0.timeLimitSeconds} s. The hiker is never visible from the launch point and is usually 15-35 m away.`
  : `The job is package delivery: fly to a marked landing pad (its position is given), hover ${m0.releaseHeight} m above its centre, and hold steady. When the drone has stayed within ${m0.padRadius} m of that hover point, moving slower than ${m0.maxHoldSpeed} m/s and touching nothing, for ${m0.requiredHoldSeconds} continuous seconds, the parcel releases automatically and falls. It must land inside the pad (radius ${m0.padRadius} m); any sideways velocity at release carries it sideways. Each flight has ${m0.timeLimitSeconds} s. Pads are 15-35 m from the launch point and a straight line to them is always blocked.`;
const MAP_FIELD = SENSORS === "map" ? `\n  map: { cell_m, x0, z0, rows, seen_cells, searched_cells, known_clear_m } = an onboard map built only from your own scans this flight, in ${1} m cells. rows[k] is a string covering z from z0+k to z0+k+1 (south to north); its character i covers x from x0+i to x0+i+1 (west to east). Characters: ? unknown, . seen open but not yet searched, s searched (one of your rays passed within detection range), # an obstacle seen at some flying height. known_clear_m gives, for 8 compass directions, how far you can go through cells known to be open before the first unknown or obstacle cell (stops_at says which). The map does not plan for you: deciding where to go is up to your program.`
  : SENSORS === "map-v5pilot" ? `\n  map: { cell_m, seen_cells, searched_cells, nearest_unsearched: [{ position, distance_m, direction, straight_line_clear }] } = an onboard map built only from your own scans this flight. A 2.5 m cell is "searched" once you have seen it within detection range. nearest_unsearched lists up to 6 open places you have seen but not yet searched, nearest first; straight_line_clear says whether you can fly straight there.` : "";
const SCAN_FIELD = SENSORS !== "basic" ? `\n  scan: { bearings_deg, horizontal_m, up30_m, down30_m, max_range } = a 32-ray range scan to the first surface (0 to 20 m): horizontal_m[i] at bearings_deg[i] (degrees counter-clockwise from east, so 90 = north), plus 8 rays tilted 30 degrees up and 8 tilted 30 degrees down every 45 degrees starting east. Use it to map your surroundings.` : "";
const OBS_FIELDS = task === "search"
  ? `  search: { objective, target_location_known (false until found), detection_range, detection_rule, target (null until found)${AREA ? ", area: { min: [x, z], max: [x, z] }" : ""} }`
  : DROP
  ? `  goal: { position [x, y, z] of the pad centre, distance_m, in_line_of_sight }
  delivery: { pad_position, pad_radius, max_release_height, height_above_pad, horizontal_offset [dx, dz] from the pad centre, parcel_status ("carried", then "falling") }`
  : `  goal: { position [x, y, z] of the hover point, distance_m, in_line_of_sight }
  delivery: { pad_position, pad_radius, release_height, maximum_hold_speed, required_hold_s, continuous_hold_s (how long the current stable hold has lasted), parcel_status ("carried", then "falling") }`;
const NO_MAP = SENSORS === "map" ? "There is no prior map: your program only sees the drone's own sensors, plus the map it builds from them." : "There is no map: your program only sees the drone's own sensors.";
const RETURNS = DROP ? "return { velocity: [vx, vy, vz] };   // add release: true once, to drop the parcel" : "return { velocity: [vx, vy, vz] };";
const TASK = `You are writing the flight controller for a small drone in a physics simulator. ${E.scene} ${NO_MAP}

${OBJECTIVE}

Write a JavaScript function:

  function policy(obs, memory) {
    // ...
    ${RETURNS}
  }

It is called once every ${DT === 1 ? "second" : `${DT} s`} of simulated time; the drone holds the returned velocity (m/s, vector length at most 5.5) until the next call. "memory" is an object that persists across calls within one flight and starts empty: keep any state you want in it (modes, visited places, a sketch of what you have seen).

Axes: +x is east, +z is north, +y is up (height), in metres. Ground height varies from place to place, so do not assume the floor is at any particular y. The drone is a sphere of radius 0.25 m, accelerates at up to 7 m/s^2, and is pushed by random wind gusts. Touching anything slows it (it slides along the surface) and counts as a contact.

obs fields:
  time_s, time_left_s, wall_contacts_so_far
  position [x, y, z], velocity [vx, vy, vz]
  free_space_m: { east, north_east, north, north_west, west, south_west, south, south_east, up, down } = how far (metres, 0 to 12, in 0.25 m steps) the drone can move from where it is in that direction before touching something. Horizontal directions are at the drone's current height.
${OBS_FIELDS}${SCAN_FIELD}${MAP_FIELD}
Example obs: ${JSON.stringify(exampleObs)}

Rules: plain JavaScript (ES2020), no imports, no network, no timers, no global state outside "memory". Math.random is available (seeded, so runs are repeatable). Each call must return within 50 ms.`;

const SYSTEM = "You write robust, well-commented JavaScript. Reply with exactly one ```js code block.";
const firstMessages = () => [{ role: "system", content: SYSTEM }, { role: "user", content: `${TASK}\n\nWrite the program. Start it with a short comment explaining your strategy.` }];
const NF = () => train.length * TRAIN_SEEDS;
const reviseMessages = (code, rep, curve, failed, shared = false) => [
  { role: "system", content: SYSTEM },
  { role: "user", content: `${TASK}\n\n${shared ? "The best program found so far (by any of several parallel attempts)" : "Your best program so far"}:\n\`\`\`js\n${code}\n\`\`\`\n${failed ? `\nYour most recent revision (v${failed.version}) could not be used: ${failed.error}. Start again from the best program above.\n` : ""}\nScores of your versions so far on the ${NF()} training flights: ${curve.map((c) => `v${c.version}: ${SUCCESS} ${c.success}/${NF()}`).join("; ")}.\n\nSimulator results for the best program on the ${NF()} training flights:\n${rep}\n\nRevise the program so the drone succeeds on more flights. Reply with the complete new program in one \`\`\`js block, starting with a comment that says what you changed and why.` },
];

if (args.includes("--print-prompt")) { console.log(TASK); process.exit(0); }

// ---------- loop ----------
// --model <id>: let a model from sim/bench/models.json write the programs instead of Ripple.
const MODEL_ID = opt("--model");
const clientOpts = { maxInFlight: RUNS, logFile: path.join(outDir, "calls.jsonl"), maxTokens: MAX_TOKENS };
const client = MODEL_ID ? clientFor(root, modelEntry(root, MODEL_ID), clientOpts) : makeClient({ root, ...clientOpts });
fs.writeFileSync(path.join(outDir, "plan.json"), JSON.stringify({ at: new Date().toISOString(), map: E.name, task, runs: RUNS, iters: ITERS, dt: DT, sensors: SENSORS, feedback: FEEDBACK, trainSeeds: TRAIN_SEEDS, populationFrom: POP_FROM, maxTokens: MAX_TOKENS, sets: SETS || "v4", random: RANDOM, select: SELECT, train: train.map((m) => m.id), model: client.model, provider: client.provider, temperature: client.temperature, selection: `best on TRAIN: ${SUCCESS} count, then ${SELECT === "earned" && task === "search" ? "ground covered by the drone's own detector" : "progress"}, then earliest version (--select ${SELECT})`, prompt: TASK }, null, 1));
console.log(`preflight ok on ${await preflight(client)}`);
const t0 = Date.now();
await Promise.all(Array.from({ length: RUNS }, async (_, run) => {
  const dir = path.join(outDir, `run${run}`);
  fs.mkdirSync(dir, { recursive: true });
  const curve = [];
  let base = null, failed = null;
  for (let k = 1; k <= ITERS; k++) {
    // Population: from POP_FROM on, revise from the best program across runs when it beats this run's own.
    const useGlobal = POP_FROM != null && k >= POP_FROM && global.best && global.best.run !== run && better(global.best.res, base?.res, SELECT, task);
    const from = useGlobal ? global.best : base;
    const msgs = !from ? firstMessages() : reviseMessages(from.code, report(from.res), curve, failed, useGlobal);
    const reply = await client.chat(msgs, { role: "programmer", map: E.name, task, run, version: k }, { max_tokens: MAX_TOKENS });
    const code = extractCode(reply.content) || "";
    fs.writeFileSync(path.join(dir, `v${k}.js`), code);
    const res = await evaluate(code, train);
    if (res.compileError || reply.finish === "length") failed = { version: k, error: reply.finish === "length" ? `the reply was cut off at the output limit (${MAX_TOKENS} tokens), so the program was incomplete${res.compileError ? ` (${res.compileError})` : ""}` : res.compileError };
    else {
      failed = null;
      if (better(res, base?.res, SELECT, task)) base = { version: k, code, res };
      if (better(res, global.best?.res, SELECT, task)) global.best = { run, version: k, code, res };
    }
    const row = { version: k, base: base?.version ?? null, revisedFrom: useGlobal ? `run${from.run}/v${from.version}` : null, success: res.success, progress: res.progress, coverage: res.coverage ?? null, contactsPerMin: res.contactsPerMin ?? null, errors: res.errors ?? null, compileError: res.compileError ?? null, codeChars: code.length, finish: reply.finish };
    curve.push(row);
    fs.writeFileSync(path.join(dir, `v${k}-train.json`), JSON.stringify({ ...row, report: report(res) }, null, 1));
    console.log(`run ${run} v${k}: train ${SUCCESS} ${res.success}/${NF()}, progress ${Math.round(res.progress * 100)}%${res.coverage != null ? `, covered ${Math.round(res.coverage)} m2` : ""}${res.compileError ? ` (${res.compileError.slice(0, 60)})` : ""} [${Math.round((Date.now() - t0) / 1000)} s]`);
  }
  const best = pickFrozen(curve, SELECT, task);
  fs.copyFileSync(path.join(dir, `v${best.version}.js`), path.join(dir, "best.js"));
  fs.writeFileSync(path.join(dir, "curve.json"), JSON.stringify({ curve, best: best.version }, null, 1));
  console.log(`run ${run}: best on train = v${best.version}`);
}));
fs.writeFileSync(path.join(outDir, "ledger.json"), JSON.stringify(client.ledger, null, 1));
client.close();
console.log("done", path.relative(root, outDir));
