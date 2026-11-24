// Program mode for bench.mjs: the practice loop. The model writes a navigation
// program, the simulator flies it on TRAIN routes, the model reads the results
// and revises. The best version on train is frozen and then flown on the
// evaluation routes (dev by default). Evaluation routes never reach the model.
//
// The task text is the one sim/tools/reach_cap.mjs sends (the published
// practice loop), built from the environment's scene sentence and route text;
// sim/test/arena_bench.test.mjs checks that it matches reach_cap.mjs
// --print-prompt for the factory. reach_cap.mjs stays the tool for the
// published studies (several parallel runs, lidar, rich feedback); this is the
// small single-run version for scoring a new model.
import { v } from "../../src/world.js";
import { Reach } from "../../src/gym/reach.js";
import { runEpisode } from "../../src/gym/core.js";
import { extractCode, programController, compilePolicy, programRandomSeed } from "../../src/gym/policy_sandbox.js";

const r1 = (p) => p.map((x) => Math.round(x * 10) / 10);

export function programTask(E, exampleObs) {
  return `You are writing the flight controller for a small drone in a physics simulator. ${E.scene} There is no map: your program only sees the drone's own sensors.

Write a JavaScript function:

  function policy(obs, memory) {
    // ...
    return { velocity: [vx, vy, vz] };
  }

It is called once per second of simulated time; the drone holds the returned velocity (m/s, vector length at most 5.5) for that second. "memory" is an object that persists across calls within one flight and starts empty: keep any state you want in it (modes, visited places, a sketch of walls you have seen).

Axes: +x is east, +z is north, +y is up (height), in metres. The drone is a sphere of radius 0.25 m, accelerates at up to 7 m/s^2, and is pushed by random wind gusts. Touching anything slows it (it slides along the surface) and counts as a wall contact. The goal is reached within 1 m; each flight has 90 s. ${E.routeText} and a straight line to the goal is always blocked, so the drone must find a way around obstacles.

obs fields:
  time_s, time_left_s, wall_contacts_so_far
  position [x, y, z], velocity [vx, vy, vz]
  goal: { position [x, y, z], distance_m, in_line_of_sight (true if a straight line to it is clear) }
  free_space_m: { east, north_east, north, north_west, west, south_west, south, south_east, up, down } = how far (metres, 0 to 12, in 0.25 m steps) the drone can move from where it is in that direction before touching something. Horizontal directions are at the drone's current height.
Example obs: ${JSON.stringify(exampleObs)}

Rules: plain JavaScript (ES2020), no imports, no network, no timers, no global state outside "memory". Math.random is available (seeded, so runs are repeatable). Each call must return within 50 ms.`;
}

const SYSTEM = "You write robust, well-commented JavaScript. Reply with exactly one ```js code block.";

// Fly one program on a list of routes (one wind seed each unless given).
export async function flyProgram(world, code, routes, { seedsPer = 1, budget = "arena", random = "separate" } = {}) {
  const compiled = compilePolicy(code);
  if (compiled.error) return { compileError: compiled.error, eps: [], reached: 0, progress: 0 };
  const eps = [];
  for (const sc of routes) for (const seed of sc.seeds.slice(0, seedsPer)) {
    const inner = programController(code, { seed, randomSeed: programRandomSeed(seed, random), budget });
    const ctl = async (obs) => ({ ...(await inner(obs)), obsSnap: obs });
    const ep = await runEpisode(new Reach(world, sc, seed, "C3"), ctl);
    eps.push({ sc, seed, ep, progress: Math.max(0, 1 - ep.result.minGoalDist / sc.straight_m) });
  }
  const time = eps.reduce((a, e) => a + e.ep.result.time / 60, 0);
  return {
    eps,
    reached: eps.filter((e) => e.ep.result.outcome === "reached").length,
    progress: eps.reduce((a, e) => a + e.progress, 0) / eps.length,
    contactsPerMin: time ? eps.reduce((a, e) => a + e.ep.result.contacts, 0) / time : 0,
    errors: eps.reduce((a, e) => a + e.ep.decisions.filter((d) => d.error).length, 0),
  };
}

// What the model gets back (reach_cap.mjs "basic" feedback).
function report(world, res) {
  if (res.compileError) return `The program failed to load: ${res.compileError}`;
  const lines = res.eps.map((e, i) => {
    const r = e.ep.result;
    return `${i + 1}. from ${JSON.stringify(r1(world.nodes[e.sc.start]))} to ${JSON.stringify(r1(world.nodes[e.sc.goal]))} (${e.sc.straight_m} m): ${r.outcome === "reached" ? `REACHED in ${r.time} s` : `failed, closest ${r.minGoalDist} m from goal`}, ${r.contacts} wall contacts`;
  });
  const details = [];
  for (const [i, e] of res.eps.entries()) {
    if (e.ep.result.outcome === "reached") continue;
    const D = e.ep.decisions;
    let stuck = null;
    for (let k = 5; k < D.length && !stuck; k++) if (v.dist(D[k - 5].obsSnap.position, D[k].obsSnap.position) < 1) stuck = D[k];
    const err = D.find((d) => d.error);
    const parts = [];
    if (stuck) parts.push(`stuck from about t=${stuck.t}s at ${JSON.stringify(stuck.obsSnap.position)}; sensors there: ${JSON.stringify({ goal: stuck.obsSnap.goal, free_space_m: stuck.obsSnap.free_space_m, velocity: stuck.obsSnap.velocity })}; your program returned ${JSON.stringify(stuck.command)}`);
    if (err) parts.push(`runtime error at t=${err.t}s: ${err.error}`);
    if (parts.length && details.length < 6) details.push(`Flight ${i + 1}: ${parts.join("; ")}`);
  }
  return `${lines.join("\n")}\n\nOverall: reached ${res.reached}/${res.eps.length}, mean progress toward the goal ${Math.round(res.progress * 100)}%, ${res.contactsPerMin.toFixed(1)} wall contacts per minute, ${res.errors} runtime errors.${details.length ? `\n\nDetails on failed flights:\n${details.join("\n")}` : ""}`;
}

// The loop. chat is the instrumented model chat; returns the frozen best
// program and one row per version.
export async function practice({ E, chat, iters = 3, maxTokens = 8000, log = () => {} }) {
  const world = E.world, train = E.sets.train;
  if (!train.length) throw new Error(`${E.name} has no training routes, so program mode can't practise there`);
  const TASK = programTask(E, new Reach(world, train[0], 1, "C3").observe());
  const NF = train.length;
  const versions = [];
  let base = null, failed = null;
  for (let k = 1; k <= iters; k++) {
    const msgs = !base
      ? [{ role: "system", content: SYSTEM }, { role: "user", content: `${TASK}\n\nWrite the program. Start it with a short comment explaining your strategy.` }]
      : [{ role: "system", content: SYSTEM }, {
        role: "user",
        content: `${TASK}\n\nYour best program so far:\n\`\`\`js\n${base.code}\n\`\`\`\n${failed ? `\nYour most recent revision (v${failed.version}) could not be used: ${failed.error}. Start again from the best program above.\n` : ""}\nScores of your versions so far on the ${NF} training flights: ${versions.map((c) => `v${c.version}: reached ${c.reached}/${NF}, progress ${Math.round(c.progress * 100)}%`).join("; ")}.\n\nSimulator results for the best program on the ${NF} training flights:\n${report(world, base.res)}\n\nRevise the program so the drone reaches more goals. Reply with the complete new program in one \`\`\`js block, starting with a comment that says what you changed and why.`,
      }];
    const reply = await chat(msgs, { role: "programmer", version: k }, { max_tokens: maxTokens });
    const code = extractCode(reply.content) || "";
    const res = await flyProgram(world, code, train);
    const cut = reply.finish === "length";
    if (res.compileError || cut) failed = { version: k, error: cut ? `the reply was cut off at the output limit (${maxTokens} tokens), so the program was incomplete${res.compileError ? ` (${res.compileError})` : ""}` : res.compileError };
    else {
      failed = null;
      if (!base || res.progress > base.res.progress || (res.progress === base.res.progress && res.reached > base.res.reached)) base = { version: k, code, res };
    }
    versions.push({ version: k, reached: res.reached, of: NF, progress: res.progress, compileError: res.compileError ?? null, truncated: cut, finish: reply.finish ?? null, codeChars: code.length });
    log(`  v${k}: train reached ${res.reached}/${NF}, progress ${Math.round(res.progress * 100)}%${cut ? " (reply cut off)" : res.compileError ? ` (${res.compileError.slice(0, 60)})` : ""}`);
    versions.at(-1).code = code;
  }
  return { best: base, versions, task: TASK };
}
