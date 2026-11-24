// Practice loop v2 for Reach (code as policy): an agentic round.
//
// reach_cap.mjs gives the model one written report per round and takes one
// whole revised program back. Here, within a fixed number of tool calls per
// round, the model can
//   fly_route       fly a program on one TRAIN route and wind, get the verdict
//   get_trace       read a recorded flight second by second (what its own
//                   program sensed and commanded)
//   score_on_train  fly a program on all train routes, get the v1 report
//   submit          hand in the version to be scored for the round
// Everything it can see is something its own program sensed or did on a train
// route: the lab below holds the world and the TRAIN routes only, and returns
// observations, commands and outcomes, never the map or the collision grid.
// The harness says what the tools do and how much budget is left, never what
// to change. The best submitted version on train is frozen, by the same rule
// as reach_cap.mjs (progress, then reached, then earliest).
//
//   node sim/tools/reach_cap2.mjs --runs 4 --rounds 8 --calls 10 \
//     --token-budget 60000 --out runs/reach/cap-agentic/agentic
// Outputs per run: v<round>.js, v<round>-train.json, r<round>-c<n>.js (every
// candidate), tools.jsonl (every tool call and result), transcript-r<round>.json,
// best.js, curve.json. calls.jsonl logs every model call.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { v } from "../src/world.js";
import { Reach } from "../src/gym/reach.js";
import { runEpisode } from "../src/gym/core.js";
import { programController, compilePolicy, programRandomSeed } from "../src/gym/policy_sandbox.js";
import { makeSlots } from "./ripple_client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../..");
const r1 = (p) => p.map((x) => Math.round(x * 10) / 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the lab: train-only simulator access ----------
export const MAX_WINDS = 4;
export const TRACE_MAX_ROWS = 30;
// Wind k of a route: the route's listed seeds first, then the same derived
// seeds reach_eval.mjs uses (seed[0] + 1000 k).
export const windSeed = (sc, k) => (k <= sc.seeds.length ? sc.seeds[k - 1] : sc.seeds[0] + 1000 * (k - 1));

export function makeLab(world, train, { random = "separate", sensors = "basic" } = {}) {
  const flights = new Map(); // id -> { program, route, wind, sc, ep, progress }
  let nFlights = 0;

  async function fly(code, program, route, wind = 1) {
    const sc = train[route - 1];
    const seed = windSeed(sc, wind);
    const inner = programController(code, { seed, randomSeed: programRandomSeed(seed, random) });
    const ctl = async (obs) => ({ ...(await inner(obs)), obsSnap: obs });
    const ep = await runEpisode(new Reach(world, sc, seed, "C3", { sensors }), ctl);
    const id = `f${++nFlights}`;
    const f = { id, program, route, wind, sc, ep, progress: Math.max(0, 1 - ep.result.minGoalDist / sc.straight_m) };
    flights.set(id, f);
    return f;
  }

  // The selection score: every train route with wind 1, as reach_cap.mjs flies them.
  async function scoreAll(code, program) {
    const compiled = compilePolicy(code);
    if (compiled.error) return { compileError: compiled.error, eps: [], reached: 0, progress: 0 };
    const eps = [];
    for (let i = 0; i < train.length; i++) eps.push(await fly(code, program, i + 1, 1));
    return {
      eps,
      reached: eps.filter((e) => e.ep.result.outcome === "reached").length,
      progress: eps.reduce((a, e) => a + e.progress, 0) / eps.length,
      contactsPerMin: eps.reduce((a, e) => a + e.ep.result.contacts, 0) / eps.reduce((a, e) => a + e.ep.result.time / 60, 0),
      errors: eps.reduce((a, e) => a + e.ep.decisions.filter((d) => d.error).length, 0),
    };
  }

  const verdict = (e) => {
    const r = e.ep.result;
    return `from ${JSON.stringify(r1(world.nodes[e.sc.start]))} to ${JSON.stringify(r1(world.nodes[e.sc.goal]))} (${e.sc.straight_m} m): ${r.outcome === "reached" ? `REACHED in ${r.time} s` : `failed, closest ${r.minGoalDist} m from goal`}, ${r.contacts} wall contacts`;
  };
  // Same failure detail as reach_cap.mjs: where it got stuck (moved less than
  // 1 m over 5 decisions), its sensors there, and its first runtime error.
  const detail = (e) => {
    if (e.ep.result.outcome === "reached") return null;
    const D = e.ep.decisions;
    let stuck = null;
    for (let k = 5; k < D.length && !stuck; k++) if (v.dist(D[k - 5].obsSnap.position, D[k].obsSnap.position) < 1) stuck = D[k];
    const err = D.find((d) => d.error);
    const parts = [];
    if (stuck) parts.push(`stuck from about t=${stuck.t}s at ${JSON.stringify(stuck.obsSnap.position)}; sensors there: ${JSON.stringify({ goal: stuck.obsSnap.goal, free_space_m: stuck.obsSnap.free_space_m, velocity: stuck.obsSnap.velocity })}; your program returned ${JSON.stringify(stuck.command)}`);
    if (err) parts.push(`runtime error at t=${err.t}s: ${err.error}`);
    return parts.length ? parts.join("; ") : null;
  };
  // The reach_cap.mjs report, with the flight id of each line so it can be traced.
  function report(res) {
    if (res.compileError) return `The program failed to load: ${res.compileError}`;
    const lines = res.eps.map((e, i) => `${i + 1}. [flight ${e.id}] ${verdict(e)}`);
    const details = [];
    for (const [i, e] of res.eps.entries()) {
      const d = detail(e);
      if (d && details.length < 6) details.push(`Flight ${i + 1}: ${d}`);
    }
    return `${lines.join("\n")}\n\nOverall: reached ${res.reached}/${res.eps.length}, mean progress toward the goal ${Math.round(res.progress * 100)}%, ${res.contactsPerMin.toFixed(1)} wall contacts per minute, ${res.errors} runtime errors.${details.length ? `\n\nDetails on failed flights:\n${details.join("\n")}` : ""}`;
  }
  const flightText = (f) => {
    const d = detail(f);
    const errors = f.ep.decisions.filter((x) => x.error).length;
    return `[flight ${f.id}] program ${f.program}, route ${f.route}, wind ${f.wind}: ${verdict(f)}, progress ${Math.round(f.progress * 100)}%, flight time ${f.ep.result.time} s, ${errors} runtime errors.${d ? `\n${d}` : ""}`;
  };

  // One line per decision: what the program was given (obs) and what it
  // returned. Nothing here comes from outside the drone's own senses.
  const DIRS = [["E", "east"], ["NE", "north_east"], ["N", "north"], ["NW", "north_west"], ["W", "west"], ["SW", "south_west"], ["S", "south"], ["SE", "south_east"], ["U", "up"], ["D", "down"]];
  function trace(id, from = 0, to = from + TRACE_MAX_ROWS - 1) {
    const f = flights.get(id);
    if (!f) return { error: `unknown flight "${id}" (flights so far: ${[...flights.keys()].join(", ") || "none"})` };
    const rows = f.ep.decisions.filter((d) => d.t >= from && d.t <= to);
    const shown = rows.slice(0, TRACE_MAX_ROWS);
    const lines = shown.map((d) => {
      const o = d.obsSnap;
      const free = DIRS.map(([s, k]) => `${s}${o.free_space_m[k]}`).join(" ");
      return `t=${d.t} pos=${JSON.stringify(o.position)} vel=${JSON.stringify(o.velocity)} goal_dist=${o.goal.distance_m} sight=${o.goal.in_line_of_sight ? 1 : 0} free=[${free}] contacts=${o.wall_contacts_so_far} cmd=${JSON.stringify(d.command?.velocity ?? d.command)}${d.say ? ` say=${JSON.stringify(d.say)}` : ""}${d.error ? ` error=${JSON.stringify(d.error)}` : ""}`;
    });
    const last = f.ep.decisions.at(-1)?.t ?? 0;
    const head = `Flight ${id} (program ${f.program}, route ${f.route}, wind ${f.wind}; goal at ${JSON.stringify(r1(world.nodes[f.sc.goal]))}; decisions at t=0..${last} s; ${f.ep.result.outcome === "reached" ? "reached" : "not reached"}). One line per second: obs given to policy(), then cmd = the velocity it returned. free = free_space_m by direction (E, NE, N, NW, W, SW, S, SE, Up, Down). sight = goal.in_line_of_sight.`;
    return { text: `${head}\n${lines.join("\n") || "(no decisions in that window)"}${rows.length > shown.length ? `\n(${rows.length - shown.length} more seconds in that window: at most ${TRACE_MAX_ROWS} per call)` : ""}` };
  }

  return { fly, scoreAll, report, flightText, trace, flights, routes: train.length };
}

// ---------- prompt (the task text is reach_cap.mjs's, word for word) ----------
export function taskText(E, sensors = "basic") {
  const exampleObs = new Reach(E.world, E.sets.train[0], 1, "C3", { sensors }).observe();
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
  free_space_m: { east, north_east, north, north_west, west, south_west, south, south_east, up, down } = how far (metres, 0 to 12, in 0.25 m steps) the drone can move from where it is in that direction before touching something. Horizontal directions are at the drone's current height.${sensors === "lidar" ? `\n  scan: { bearings_deg, horizontal_m, up30_m, down30_m, max_range } = a 32-ray range scan to the first surface (0 to 20 m): horizontal_m[i] at bearings_deg[i] (degrees counter-clockwise from east, so 90 = north), plus 8 rays tilted 30 degrees up and 8 tilted 30 degrees down every 45 degrees starting east. Use it to map your surroundings.` : ""}
Example obs: ${JSON.stringify(exampleObs)}

Rules: plain JavaScript (ES2020), no imports, no network, no timers, no global state outside "memory". Math.random is available (seeded, so runs are repeatable). Each call must return within 50 ms.`;
}

const SYSTEM = "You write robust, well-commented JavaScript. You work by calling the tools provided.";
const labText = (round, calls, n) => `This is practice round ${round}. You have a simulator with the ${n} training routes and ${calls} tool calls for this round (submit is not counted):
- fly_route: fly a program on one training route (1 to ${n}) with one of its winds (1 to ${MAX_WINDS}) and get the verdict.
- get_trace: read a recorded flight second by second: the obs your program was given and the velocity it returned. If your program also returns a "say" string (up to 80 characters), it appears there.
- score_on_train: fly a program on all ${n} training routes with wind 1 and get the full report.
- submit: hand in the program you want scored for this round. This ends the round.
Act only through tool calls: a program goes in a tool's "code" argument, not in the text of your reply. A program is given either by name ("best" is your best program so far; each new program you send gets a name such as c1) or as new code. The submitted program is scored on the ${n} training flights with wind 1, and the best-scoring submitted version over all rounds is the one kept.`;

export const firstPrompt = (TASK, round, calls, n) => `${TASK}\n\n${labText(round, calls, n)}\n\nWrite the program. Start it with a short comment explaining your strategy.`;
export const revisePrompt = (TASK, round, calls, n, code, rep, curve, failed) => `${TASK}\n\nYour best program so far (named "best"):\n\`\`\`js\n${code}\n\`\`\`\n${failed ? `\nYour most recent round (v${failed.version}) could not be used: ${failed.error}.\n` : ""}\nScores of your versions so far on the ${n} training flights: ${curve.map((c) => `v${c.version}: reached ${c.reached}/${n}, progress ${Math.round(c.progress * 100)}%`).join("; ")}.\n\nSimulator results for the best program on the ${n} training flights:\n${rep}\n\n${labText(round, calls, n)}\n\nRevise the program so the drone reaches more goals. Start the program with a comment that says what you changed and why.`;

const PROGRAM_PROPS = {
  program: { type: "string", description: 'Name of an existing program: "best" or a candidate name such as "c1".' },
  code: { type: "string", description: "A complete new program (JavaScript source defining function policy(obs, memory)). It is saved and given the next candidate name. Give either program or code, not both." },
};
export const toolDefs = (n) => [
  { type: "function", function: { name: "fly_route", description: `Fly a program on one training route and get the verdict and a flight id.`, parameters: { type: "object", properties: { ...PROGRAM_PROPS, route: { type: "integer", description: `Training route number, 1 to ${n}.` }, wind: { type: "integer", description: `Which wind of that route, 1 to ${MAX_WINDS}. Default 1 (the wind used for scoring).` } }, required: ["route"] } } },
  { type: "function", function: { name: "get_trace", description: `Read a recorded flight for a time window, one line per second (at most ${TRACE_MAX_ROWS} lines per call): the obs your program was given and the velocity it returned.`, parameters: { type: "object", properties: { flight: { type: "string", description: 'Flight id, such as "f3".' }, from_s: { type: "number", description: "Start of the window in seconds." }, to_s: { type: "number", description: "End of the window in seconds." } }, required: ["flight", "from_s", "to_s"] } } },
  { type: "function", function: { name: "score_on_train", description: `Fly a program on all ${n} training routes with wind 1 and get the full report with a flight id per route.`, parameters: { type: "object", properties: { ...PROGRAM_PROPS } } } },
  { type: "function", function: { name: "submit", description: "Hand in the program to be scored for this round. Ends the round.", parameters: { type: "object", properties: { ...PROGRAM_PROPS } } } },
];

// ---------- one agentic round ----------
const estTokens = (chars) => Math.ceil(chars / 3);
const msgChars = (m) => (m.content?.length || 0) + (m.tool_calls || []).reduce((a, t) => a + t.function.arguments.length + 40, 0);

// Older programs are left out of the resent history (the two most recent
// stay); every program is still available by name. The transcript on disk
// keeps everything.
export function compactHistory(messages, keep = 2) {
  const withCode = [];
  for (const m of messages) for (const t of m.tool_calls || []) if (t._code) withCode.push(t);
  const drop = new Set(withCode.slice(0, Math.max(0, withCode.length - keep)));
  return messages.map((m) => {
    if (!m.tool_calls) return m;
    return {
      ...m,
      tool_calls: m.tool_calls.map((orig) => {
        const { _code, _name, ...t } = orig;
        if (!drop.has(orig)) return t;
        return { ...t, function: { ...t.function, arguments: JSON.stringify({ ...safeParse(t.function.arguments), code: `(left out to save space: it is saved as "${_name}")` }) } };
      }),
    };
  });
}
const safeParse = (s) => { try { const o = JSON.parse(s); return o && typeof o === "object" ? o : {}; } catch { return {}; } };

// state: { used, budget } token counters shared across the rounds of a run.
// Returns { submitted: { name, code, res } | null, toolCalls, endReason, messages, candidates }.
export async function agenticRound({ chat, lab, prompt, round, calls, maxTokens, state, baseCode = null, baseRes = null, log = () => {}, meta = {} }) {
  const tools = toolDefs(lab.routes);
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }];
  const programs = new Map(); // name -> code
  const scores = new Map(); // name -> scoreAll result (wind 1, all routes: deterministic)
  if (baseCode) { programs.set("best", baseCode); if (baseRes) scores.set("best", baseRes); }
  let nCand = 0, callsLeft = calls, toolCalls = 0, submitted = null, endReason = null;
  let lastPrompt = null, lastCompletion = 0, sentChars = 0, requireTool = false;

  // Resolve { program | code } to a named program; new code is saved as c<n>.
  const resolve = (a) => {
    if (typeof a.code === "string" && a.code.trim()) {
      const name = `c${++nCand}`;
      programs.set(name, a.code);
      const c = compilePolicy(a.code);
      return { name, code: a.code, isNew: true, compileError: c.error || null };
    }
    const name = typeof a.program === "string" ? a.program.trim() : "";
    if (!programs.has(name)) return { error: name ? `unknown program "${name}" (known: ${[...programs.keys()].join(", ") || "none yet: send code"})` : `give "program" (a name) or "code" (a new program)${programs.size ? `; known programs: ${[...programs.keys()].join(", ")}` : ""}` };
    return { name, code: programs.get(name), isNew: false, compileError: null };
  };
  const scoreOf = async (p) => {
    if (!scores.has(p.name)) scores.set(p.name, await lab.scoreAll(p.code, p.name));
    return scores.get(p.name);
  };

  async function runTool(name, a) {
    if (name === "get_trace") {
      const from = Number(a.from_s), to = Number(a.to_s);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return { text: "from_s and to_s must be numbers with to_s >= from_s" };
      const t = lab.trace(String(a.flight), from, to);
      return { text: t.error || t.text };
    }
    if (!["fly_route", "score_on_train", "submit"].includes(name)) return { text: `unknown tool "${name}"` };
    const p = resolve(a);
    if (p.error) return { text: p.error };
    const saved = p.isNew ? `Saved as ${p.name}. ` : "";
    if (p.compileError) return { text: `${saved}The program failed to load: ${p.compileError}`, program: p };
    if (name === "fly_route") {
      const route = Number(a.route), wind = a.wind == null ? 1 : Number(a.wind);
      if (!Number.isInteger(route) || route < 1 || route > lab.routes) return { text: `${saved}route must be a whole number from 1 to ${lab.routes} (the training routes)`, program: p };
      if (!Number.isInteger(wind) || wind < 1 || wind > MAX_WINDS) return { text: `${saved}wind must be a whole number from 1 to ${MAX_WINDS}`, program: p };
      return { text: saved + lab.flightText(await lab.fly(p.code, p.name, route, wind)), program: p };
    }
    const res = await scoreOf(p);
    if (name === "score_on_train") return { text: `${saved}Program ${p.name} on the ${lab.routes} training flights:\n${lab.report(res)}`, program: p };
    return { text: `${saved}Submitted ${p.name}: reached ${res.reached}/${lab.routes}, mean progress ${Math.round(res.progress * 100)}%.`, program: p, submit: { name: p.name, code: p.code, res } };
  }

  for (;;) {
    const added = messages.reduce((a, m) => a + msgChars(m), 0) - sentChars;
    const est = lastPrompt == null ? estTokens(messages.reduce((a, m) => a + msgChars(m), 0)) + 700 : lastPrompt + lastCompletion + estTokens(added);
    const room = state.budget - state.used - est;
    // Keep enough back for one last call that submits by name.
    const finalCost = est + 2100;
    const ordinaryMax = Math.min(maxTokens, room - finalCost);
    let force = false;
    if (callsLeft <= 0 || ordinaryMax < 1500) {
      if (room < 300) { endReason = "token budget spent before a submit"; break; }
      force = true;
      messages.push({ role: "user", content: callsLeft <= 0 ? "The tool calls for this round are used up. Call submit now with the program you want scored." : "The token budget for this run is nearly spent. Call submit now with the program you want scored, by name if you can." });
    }
    sentChars = messages.reduce((a, m) => a + msgChars(m), 0);
    const reply = await chat({ messages: compactHistory(messages), tools, tool_choice: force ? { type: "function", function: { name: "submit" } } : requireTool ? "required" : "auto", max_tokens: Math.max(300, force ? Math.min(maxTokens, room) : ordinaryMax) }, { ...meta, round, forced: force });
    const pt = reply.usage?.prompt_tokens || 0, ct = reply.usage?.completion_tokens || 0;
    state.used += pt + ct; state.prompt += pt; state.completion += ct;
    lastPrompt = pt; lastCompletion = ct;
    const tcs = (reply.message.tool_calls || []).filter((t) => t?.function?.name);
    const amsg = { role: "assistant", content: reply.message.content || "" };
    if (tcs.length) amsg.tool_calls = tcs.map((t, i) => ({ id: t.id || `call_${round}_${toolCalls + i}`, type: "function", function: { name: t.function.name, arguments: typeof t.function.arguments === "string" ? t.function.arguments : JSON.stringify(t.function.arguments ?? {}) } }));
    messages.push(amsg);
    const left = () => `[tool calls left this round: ${Math.max(0, callsLeft)}${Number.isFinite(state.budget) ? `; tokens left this run: about ${Math.max(0, Math.round((state.budget - state.used) / 1000))}k` : ""}]`;

    if (!tcs.length) {
      // A reply in plain text is free once (thinking aloud); the next reply
      // must call a tool, and a plain reply to that counts as a call.
      if (requireTool) callsLeft--;
      requireTool = true;
      log({ round, n: null, tool: null, note: "reply without a tool call", finish: reply.finish, content: (reply.message.content || "").slice(0, 2000) });
      if (force) { endReason = "no submit when asked"; break; }
      messages.push({ role: "user", content: `Now call one of the tools (a program goes in the "code" argument). ${left()}` });
      continue;
    }
    requireTool = false;
    for (const t of amsg.tool_calls) {
      let args = null;
      try { args = JSON.parse(t.function.arguments); } catch {}
      const name = t.function.name;
      let out;
      if (submitted) out = { text: "Not run: the round has already been submitted." };
      else if (!args || typeof args !== "object") out = { text: `The arguments could not be read as JSON${reply.finish === "length" ? ` (the reply was cut off at the output limit)` : ""}.` };
      else if (name !== "submit" && callsLeft <= 0) out = { text: "Not run: no tool calls left this round." };
      else out = await runTool(name, args);
      if (!submitted && (name !== "submit" || !out.submit)) callsLeft--; // a failed submit counts as a call
      toolCalls++;
      if (out.program?.isNew) { t._code = true; t._name = out.program.name; }
      if (out.submit) submitted = out.submit;
      const text = out.submit ? out.text : `${out.text}\n${left()}`;
      messages.push({ role: "tool", tool_call_id: t.id, content: text });
      const { code, ...rest } = args && typeof args === "object" ? args : {};
      log({ round, n: toolCalls, tool: name, args: { ...rest, ...(typeof code === "string" ? { code: `(${code.length} chars${out.program?.isNew ? `, saved as ${out.program.name}` : ""})` } : {}) }, program: out.program?.name ?? null, forced: force, result: text });
    }
    if (submitted) { endReason = "submitted"; break; }
    if (force) { endReason = "submit failed when asked"; break; }
  }
  return { submitted, toolCalls, endReason, messages, candidates: [...programs].filter(([k]) => k !== "best").map(([name, code]) => ({ name, code })) };
}

// ---------- one run: rounds until the round limit or the token budget ----------
export const pickBest = (curve) => [...curve].filter((c) => c.submitted && !c.compileError).sort((a, b) => b.progress - a.progress || b.reached - a.reached || a.version - b.version)[0] ?? null;

export async function agenticRun({ chat, E, dir, run = 0, rounds = 8, calls = 10, maxTokens = 8000, tokenBudget = Infinity, random = "separate", sensors = "basic", say = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const train = E.sets.train;
  const lab = makeLab(E.world, train, { random, sensors });
  const TASK = taskText(E, sensors);
  const n = train.length;
  const state = { used: 0, prompt: 0, completion: 0, budget: tokenBudget };
  const toolLog = fs.openSync(path.join(dir, "tools.jsonl"), "a");
  const curve = [];
  let base = null, failed = null, endReason = "round limit";
  const t0 = Date.now();
  for (let k = 1; k <= rounds; k++) {
    const prompt = !base ? firstPrompt(TASK, k, calls, n) : revisePrompt(TASK, k, calls, n, base.code, lab.report(base.res), curve.filter((c) => c.submitted), failed);
    // A round needs room for its prompt, one working call and a final submit.
    if (state.budget - state.used < 2 * estTokens(prompt.length) + 6000) { endReason = "token budget"; break; }
    const before = { ...state };
    const r = await agenticRound({ chat, lab, prompt, round: k, calls, maxTokens, state, baseCode: base?.code ?? null, baseRes: base?.res ?? null, meta: { role: "programmer", run }, log: (row) => fs.writeSync(toolLog, JSON.stringify({ run, ...row }) + "\n") });
    for (const c of r.candidates) fs.writeFileSync(path.join(dir, `r${k}-${c.name}.js`), c.code);
    fs.writeFileSync(path.join(dir, `transcript-r${k}.json`), JSON.stringify(r.messages.map(({ tool_calls, ...m }) => (tool_calls ? { ...m, tool_calls: tool_calls.map(({ _code, _name, ...t }) => t) } : m)), null, 1));
    const sub = r.submitted;
    const res = sub?.res ?? null;
    if (sub) fs.writeFileSync(path.join(dir, `v${k}.js`), sub.code);
    if (!sub) failed = { version: k, error: `no program was submitted (${r.endReason})` };
    else {
      failed = null;
      if (!base || res.progress > base.res.progress || (res.progress === base.res.progress && res.reached > base.res.reached)) base = { version: k, code: sub.code, res };
    }
    const row = { version: k, base: base?.version ?? null, submitted: sub?.name ?? null, reached: res?.reached ?? 0, progress: res?.progress ?? 0, contactsPerMin: res?.contactsPerMin ?? null, errors: res?.errors ?? null, compileError: null, codeChars: sub?.code.length ?? 0, toolCalls: r.toolCalls, candidates: r.candidates.length, endReason: r.endReason, promptTokens: state.prompt - before.prompt, completionTokens: state.completion - before.completion, wallSeconds: Math.round((Date.now() - t0) / 1000) };
    curve.push(row);
    fs.writeFileSync(path.join(dir, `v${k}-train.json`), JSON.stringify({ ...row, report: res ? lab.report(res) : null }, null, 1));
    say(`run ${run} v${k}: ${sub ? `train reached ${res.reached}/${n}, progress ${Math.round(res.progress * 100)}%` : `no submit (${r.endReason})`}, ${r.toolCalls} tool calls, ${Math.round(state.used / 1000)}k tokens so far [${Math.round((Date.now() - t0) / 1000)} s]`);
  }
  fs.closeSync(toolLog);
  // Freeze the best submitted version on TRAIN (progress, then reached, then earliest).
  const best = pickBest(curve);
  if (best) fs.copyFileSync(path.join(dir, `v${best.version}.js`), path.join(dir, "best.js"));
  const out = { curve, best: best?.version ?? null, endReason, tokens: { prompt: state.prompt, completion: state.completion, total: state.used, budget: Number.isFinite(tokenBudget) ? tokenBudget : null }, wallSeconds: Math.round((Date.now() - t0) / 1000), flights: lab.flights.size };
  fs.writeFileSync(path.join(dir, "curve.json"), JSON.stringify(out, null, 1));
  say(`run ${run}: best on train = ${best ? `v${best.version}` : "none"} (${endReason})`);
  return out;
}

// ---------- transport: the pinned host with native tool calling ----------
// ripple_client.mjs returns the reply text only, so tool calls need their own
// request. Same host pin, temperature, machine-wide slots (shared with every
// other client on this machine) and retry rules: 429, 5xx and network errors
// are waited out and retried and never reach the model; account and request
// errors stop the run.
export function makeToolClient({ root: envRoot = root, model = null, provider = "PrimeIntellect", temperature = 0.7, maxInFlight = 4, logFile = null, backoffBaseMs = 500, fetchImpl = fetch } = {}) {
  const envFile = path.join(envRoot, ".env");
  const env = !fs.existsSync(envFile) ? {} : Object.fromEntries(fs.readFileSync(envFile, "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
  const KEY = env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
  const MODEL = model || env.RIPPLE_MODEL || "ricursiveai/ripple-65b-preview";
  const slotKey = crypto.createHash("sha256").update(`${KEY}|${provider}|${MODEL}`).digest("hex").slice(0, 12);
  const slots = makeSlots(path.join(os.tmpdir(), `ripple-slots-${slotKey}`), Number(process.env.RIPPLE_GLOBAL_SLOTS ?? 24));
  const ledger = { calls: 0, transportRetries: 0, promptTokens: 0, completionTokens: 0, providers: {}, retryReasons: {} };
  const log = logFile ? fs.createWriteStream(logFile, { flags: "a" }) : null;
  const retryLog = logFile ? fs.createWriteStream(path.join(path.dirname(logFile), "retries.jsonl"), { flags: "a" }) : null;
  let inFlight = 0;
  const queue = [];
  const acquire = () => (inFlight < maxInFlight ? (inFlight++, Promise.resolve()) : new Promise((r) => queue.push(r)));
  const release = () => { inFlight--; if (queue.length) { inFlight++; queue.shift()(); } };

  async function chat({ messages, tools, tool_choice = "auto", max_tokens = 8000 }, meta = {}) {
    if (!KEY) throw Object.assign(new Error("OPENROUTER_API_KEY missing (.env or environment)"), { fatal: true });
    await acquire();
    try {
      // Rate limits are waited out (up to about 2 hours); other transport errors get 7 tries.
      let hard = 0;
      for (let attempt = 0; hard < 7 && attempt < 240; attempt++) {
        const releaseSlot = await slots.acquire();
        const t0 = Date.now();
        let status = null, retryAfterMs = 0;
        try {
          let res;
          try {
            res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: MODEL, messages, ...(tools ? { tools, tool_choice } : {}), temperature, max_tokens, provider: { only: [provider], allow_fallbacks: false } }) });
          } finally { releaseSlot(); }
          status = res.status;
          const ra = Number(res.headers?.get?.("retry-after"));
          if (ra > 0) retryAfterMs = ra * 1000;
          const body = await res.json().catch(() => ({}));
          if (!res.ok || !body.choices) {
            const msg = body.error?.message || `HTTP ${res.status}`;
            if ([400, 401, 402, 403].includes(res.status)) throw Object.assign(new Error(msg), { fatal: true, status });
            if (res.ok && Number(body.error?.code)) status = Number(body.error.code);
            throw Object.assign(new Error(msg), { status });
          }
          const ch = body.choices[0];
          const out = { message: { content: ch.message?.content || "", tool_calls: ch.message?.tool_calls || [] }, usage: body.usage, finish: ch.finish_reason, provider: body.provider, latencyMs: Date.now() - t0 };
          ledger.calls++;
          ledger.promptTokens += body.usage?.prompt_tokens || 0;
          ledger.completionTokens += body.usage?.completion_tokens || 0;
          ledger.providers[out.provider] = (ledger.providers[out.provider] || 0) + 1;
          log?.write(JSON.stringify({ ...meta, provider: out.provider, latencyMs: out.latencyMs, finish: out.finish, usage: body.usage, content: out.message.content, tool_calls: out.message.tool_calls }) + "\n");
          return out;
        } catch (err) {
          if (err.fatal) throw err;
          const code = err.status ?? status ?? (err.cause?.code || "network");
          ledger.transportRetries++;
          ledger.retryReasons[code] = (ledger.retryReasons[code] || 0) + 1;
          const rate = Number(code) === 429 || /rate.?limit|too many requests/i.test(err.message || "");
          if (!rate) hard++;
          const backoff = Math.min(30000, Math.max(retryAfterMs, backoffBaseMs * 2 ** attempt * (0.5 + Math.random())));
          retryLog?.write(JSON.stringify({ ts: new Date().toISOString(), reason: String(code), error: String(err.message).slice(0, 300), attempt, backoffMs: Math.round(backoff), meta }) + "\n");
          await sleep(backoff);
        }
      }
      throw Object.assign(new Error(`transport failed (${hard} errors that were not rate limits)`), { transport: true });
    } finally { release(); }
  }
  return { chat, ledger, model: MODEL, provider, temperature, close: () => { log?.end(); retryLog?.end(); } };
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const { loadEnvironment, pinScenarios } = await import("./benchmark_env.mjs");
  const E = loadEnvironment(opt("--map", "factory"));
  pinScenarios(E);
  if (!E.sets.train.length) throw new Error(`map ${E.name} has no training routes`);
  const SENSORS = opt("--sensors", "basic");
  if (args.includes("--print-prompt")) { console.log(taskText(E, SENSORS)); process.exit(0); }
  const RUNS = Number(opt("--runs", 3));
  const ROUNDS = Number(opt("--rounds", 8));
  const CALLS = Number(opt("--calls", 10));
  const MAX_TOKENS = Number(opt("--max-tokens", 8000));
  // --token-budget N: prompt + completion tokens one run may spend (default: no limit, --rounds decides).
  const BUDGET = opt("--token-budget") ? Number(opt("--token-budget")) : Infinity;
  const RANDOM = opt("--random", "separate");
  programRandomSeed(1, RANDOM);
  const outDir = path.resolve(opt("--out", path.join(root, "runs/reach/cap-agentic/agentic")));
  fs.mkdirSync(outDir, { recursive: true });
  const client = makeToolClient({ maxInFlight: RUNS, logFile: path.join(outDir, "calls.jsonl") });
  fs.writeFileSync(path.join(outDir, "plan.json"), JSON.stringify({ at: new Date().toISOString(), tool: "reach_cap2", map: E.name, programRandom: RANDOM, runs: RUNS, rounds: ROUNDS, callsPerRound: CALLS, tokenBudget: Number.isFinite(BUDGET) ? BUDGET : null, maxTokens: MAX_TOKENS, sensors: SENSORS, model: client.model, provider: client.provider, temperature: client.temperature, protocol: "native tool calling", system: SYSTEM, tools: toolDefs(E.sets.train.length), prompt: firstPrompt(taskText(E, SENSORS), 1, CALLS, E.sets.train.length) }, null, 1));
  const t0 = Date.now();
  try {
    const pre = await client.chat({ messages: [{ role: "user", content: 'Reply with {"ok": true}' }], max_tokens: 10 }, { role: "preflight" });
    console.log(`preflight ok on ${pre.provider}`);
    const outs = await Promise.all(Array.from({ length: RUNS }, (_, run) => agenticRun({ chat: client.chat, E, dir: path.join(outDir, `run${run}`), run, rounds: ROUNDS, calls: CALLS, maxTokens: MAX_TOKENS, tokenBudget: BUDGET, random: RANDOM, sensors: SENSORS, say: (s) => console.log(s) })));
    fs.writeFileSync(path.join(outDir, "ledger.json"), JSON.stringify({ ...client.ledger, wallSeconds: Math.round((Date.now() - t0) / 1000), runs: outs.map((o, run) => ({ run, ...o.tokens, wallSeconds: o.wallSeconds, best: o.best })) }, null, 1));
  } catch (err) {
    if (!err.fatal && !err.transport) throw err;
    console.error(`\nStopped: ${err.message}. This is the host or the account, not the model.`);
    process.exit(err.fatal ? 2 : 3);
  } finally { client.close(); }
  console.log("done", outDir);
}
