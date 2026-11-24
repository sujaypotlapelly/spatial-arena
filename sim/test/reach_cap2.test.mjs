import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "../tools/benchmark_env.mjs";
import { heightLock } from "../tools/study/height_lock.mjs";
import { makeLab, agenticRound, agenticRun, compactHistory, pickBest, toolDefs, taskText, firstPrompt, makeToolClient, windSeed, TRACE_MAX_ROWS, MAX_WINDS } from "../tools/reach_cap2.mjs";

const tools = path.join(path.dirname(fileURLToPath(import.meta.url)), "../tools");
const E = loadEnvironment("factory");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cap2-"));
const STRAIGHT = `function policy(obs, memory) {
  const d = [obs.goal.position[0] - obs.position[0], obs.goal.position[1] - obs.position[1], obs.goal.position[2] - obs.position[2]];
  const L = Math.hypot(...d) || 1;
  return { velocity: d.map((x) => 3 * x / L), say: "straight" };
}`;
const HOVER = `function policy(obs, memory) { return { velocity: [0, 0, 0] }; }`;

// A scripted model: each step is a list of [tool, args] calls (or a string for a plain reply).
function scripted(steps, usage = { prompt_tokens: 100, completion_tokens: 50 }) {
  const seen = [];
  let i = 0;
  const chat = async (req, meta) => {
    seen.push({ req: structuredClone(req), meta });
    const step = steps[Math.min(i++, steps.length - 1)];
    if (typeof step === "string") return { message: { content: step, tool_calls: [] }, usage, finish: "stop" };
    return { message: { content: "", tool_calls: step.map(([name, args], k) => ({ id: `t${i}_${k}`, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } })) }, usage, finish: "tool_calls" };
  };
  return { chat, seen };
}
const newState = (budget = Infinity) => ({ used: 0, prompt: 0, completion: 0, budget });
const toolTexts = (messages) => messages.filter((m) => m.role === "tool").map((m) => m.content);

test("the task text is reach_cap.mjs's, word for word", () => {
  const v1 = spawnSync("node", [path.join(tools, "reach_cap.mjs"), "--print-prompt", "--out", tmp()], { encoding: "utf8" });
  assert.equal(v1.status, 0, v1.stderr);
  assert.equal(taskText(E), v1.stdout.replace(/\n$/, ""));
});

test("the lab flies train routes only and shows only what the program sensed and did", async () => {
  const lab = makeLab(E.world, E.sets.train);
  assert.deepEqual(Object.keys(lab).sort(), ["flightText", "flights", "fly", "report", "routes", "scoreAll", "trace"]);
  assert.equal(lab.routes, E.sets.train.length);
  const f = await lab.fly(STRAIGHT, "c1", 1, 1);
  assert.equal(f.sc.id, E.sets.train[0].id);
  const t = lab.trace(f.id, 0, 4).text;
  const rows = t.split("\n").slice(1);
  assert.equal(rows.length, 5);
  // every row is exactly the obs fields plus the command, the program's own say and error
  for (const row of rows) assert.match(row, /^t=\d+ pos=\[[^\]]+\] vel=\[[^\]]+\] goal_dist=[\d.]+ sight=[01] free=\[E[\d.]+ NE[\d.]+ N[\d.]+ NW[\d.]+ W[\d.]+ SW[\d.]+ S[\d.]+ SE[\d.]+ U[\d.]+ D[\d.]+\] contacts=\d+ cmd=\[[^\]]+\] say="straight"$/);
  const d0 = f.ep.decisions[0];
  assert.ok(rows[0].includes(`pos=${JSON.stringify(d0.obsSnap.position)}`) && rows[0].includes(`goal_dist=${d0.obsSnap.goal.distance_m}`));
  // nothing from the map: no waypoint names, no route ids, no graph distances
  const everything = [t, lab.flightText(f), lab.report(await lab.scoreAll(STRAIGHT, "c1"))].join("\n");
  for (const sc of [...E.sets.train, ...E.sets.dev]) for (const word of [sc.start, sc.goal]) assert.ok(!everything.includes(word), `leaked ${word}`);
  assert.ok(!/\b[TDH]\d+\b/.test(everything.replace(/free=\[[^\]]*\]/g, "")), "leaked a route id");
  assert.ok(!/graph|node|voxel|grid/i.test(everything));
  // windows are capped, unknown flights are refused
  assert.ok(lab.trace(f.id, 0, 89).text.split("\n").length <= TRACE_MAX_ROWS + 2);
  assert.match(lab.trace("f999", 0, 5).error, /unknown flight/);
});

test("winds are the route's own seeds first, then derived, and never a dev seed", () => {
  const devSeeds = new Set(E.sets.dev.flatMap((s) => s.seeds));
  for (const sc of E.sets.train) {
    assert.equal(windSeed(sc, 1), sc.seeds[0]);
    assert.equal(windSeed(sc, 2), sc.seeds[1]);
    for (let k = 1; k <= MAX_WINDS; k++) assert.ok(!devSeeds.has(windSeed(sc, k)));
  }
});

test("a round: fly, trace, score, submit; the submitted score is the train score", async () => {
  const lab = makeLab(E.world, E.sets.train);
  const m = scripted([[["fly_route", { code: STRAIGHT, route: 2 }]], [["get_trace", { flight: "f1", from_s: 0, to_s: 3 }]], [["score_on_train", { program: "c1" }]], [["submit", { program: "c1" }]]]);
  const log = [];
  const r = await agenticRound({ chat: m.chat, lab, prompt: "p", round: 1, calls: 5, maxTokens: 8000, state: newState(), log: (x) => log.push(x) });
  assert.equal(r.endReason, "submitted");
  assert.equal(r.submitted.name, "c1");
  assert.equal(r.submitted.code, STRAIGHT);
  const ref = await makeLab(E.world, E.sets.train).scoreAll(STRAIGHT, "x");
  assert.equal(r.submitted.res.reached, ref.reached);
  assert.equal(r.submitted.res.progress, ref.progress);
  const texts = toolTexts(r.messages);
  assert.match(texts[0], /^Saved as c1\. \[flight f1\] program c1, route 2, wind 1:/);
  assert.match(texts[0], /\[tool calls left this round: 4\]$/);
  assert.match(texts[1], /^Flight f1 /);
  assert.match(texts[2], /Overall: reached \d+\/12/);
  // every tool call is logged, with the code replaced by its size and name
  assert.deepEqual(log.map((x) => x.tool), ["fly_route", "get_trace", "score_on_train", "submit"]);
  assert.match(log[0].args.code, /chars, saved as c1/);
  assert.equal(m.seen[0].req.tools.length, 4);
  assert.deepEqual(m.seen[0].req.tools.map((t) => t.function.name), toolDefs(12).map((t) => t.function.name));
});

test("bad requests are refused: routes outside train, unknown programs, broken code, unread arguments", async () => {
  const lab = makeLab(E.world, E.sets.train);
  const m = scripted([[["fly_route", { code: HOVER, route: 13 }], ["fly_route", { program: "c1", route: 0 }], ["fly_route", { program: "c1", route: "D1" }], ["fly_route", { program: "c1", route: 1, wind: 9 }]], [["fly_route", { program: "nope", route: 1 }], ["score_on_train", { code: "function nope( {" }], ["fly_route", "{not json"], ["dump_map", {}]], [["submit", { program: "c1" }]]]);
  const r = await agenticRound({ chat: m.chat, lab, prompt: "p", round: 1, calls: 20, maxTokens: 8000, state: newState() });
  const t = toolTexts(r.messages);
  assert.match(t[0], /route must be a whole number from 1 to 12/);
  assert.match(t[1], /route must be/);
  assert.match(t[2], /route must be/);
  assert.match(t[3], /wind must be/);
  assert.match(t[4], /unknown program "nope"/);
  assert.match(t[5], /Saved as c2\. The program failed to load/);
  assert.match(t[6], /could not be read as JSON/);
  assert.match(t[7], /unknown tool/);
  assert.equal(lab.flights.size, 12); // only the submit scoring flew
  assert.equal(r.submitted.name, "c1");
});

test("the tool call budget is enforced and ends in a forced submit", async () => {
  const lab = makeLab(E.world, E.sets.train);
  const m = scripted([[["fly_route", { code: HOVER, route: 1 }], ["fly_route", { program: "c1", route: 2 }], ["fly_route", { program: "c1", route: 3 }]], [["submit", { program: "c1" }]]]);
  const r = await agenticRound({ chat: m.chat, lab, prompt: "p", round: 1, calls: 2, maxTokens: 8000, state: newState() });
  const t = toolTexts(r.messages);
  assert.match(t[2], /Not run: no tool calls left/);
  assert.equal(m.seen[0].req.tool_choice, "auto");
  assert.deepEqual(m.seen[1].req.tool_choice, { type: "function", function: { name: "submit" } });
  assert.match(m.seen[1].req.messages.at(-1).content, /tool calls for this round are used up/);
  assert.equal(r.endReason, "submitted");
  assert.equal(lab.flights.size, 2 + 12);
});

test("a round with no submit when asked has no version", async () => {
  const lab = makeLab(E.world, E.sets.train);
  const m = scripted(["I think the program is fine."]);
  const r = await agenticRound({ chat: m.chat, lab, prompt: "p", round: 1, calls: 2, maxTokens: 8000, state: newState() });
  assert.equal(r.submitted, null);
  assert.equal(r.endReason, "no submit when asked");
  // the first plain reply is free, the next must call a tool; two more plain replies use the two calls, then one forced ask
  assert.equal(m.seen.length, 4);
  assert.deepEqual(m.seen.map((s) => (typeof s.req.tool_choice === "string" ? s.req.tool_choice : "submit")), ["auto", "required", "required", "submit"]);
});

test("the token budget is kept: working calls stop while a submit is still affordable", async () => {
  const lab = makeLab(E.world, E.sets.train);
  const steps = [[["fly_route", { code: HOVER, route: 1 }]], ...Array(50).fill([["fly_route", { program: "c1", route: 1 }]])];
  const m = scripted(steps, { prompt_tokens: 3000, completion_tokens: 500 });
  const state = newState(30000);
  const r = await agenticRound({ chat: m.chat, lab, prompt: "p", round: 1, calls: 100, maxTokens: 8000, state });
  assert.ok(state.used <= 30000, `used ${state.used}`);
  assert.ok(m.seen.at(-1).meta.forced);
  assert.match(m.seen.at(-1).req.messages.at(-1).content, /token budget for this run is nearly spent/);
  for (const s of m.seen) assert.ok(s.req.max_tokens <= 8000);
});

test("older programs are left out of the resent history, never the newest two", () => {
  const call = (id, code, name) => ({ id, type: "function", function: { name: "fly_route", arguments: JSON.stringify({ code, route: 1 }) }, _code: true, _name: name });
  const msgs = [{ role: "user", content: "p" }, { role: "assistant", content: "", tool_calls: [call("a", "AAA", "c1")] }, { role: "assistant", content: "", tool_calls: [call("b", "BBB", "c2")] }, { role: "assistant", content: "", tool_calls: [call("c", "CCC", "c3")] }];
  const out = compactHistory(msgs);
  const codes = out.slice(1).map((m) => JSON.parse(m.tool_calls[0].function.arguments).code);
  assert.match(codes[0], /saved as "c1"/);
  assert.deepEqual(codes.slice(1), ["BBB", "CCC"]);
  assert.ok(out.every((m) => (m.tool_calls || []).every((t) => !("_code" in t) && !("_name" in t))));
  assert.equal(JSON.parse(msgs[1].tool_calls[0].function.arguments).code, "AAA"); // the original is untouched
});

test("freezing rule: best progress, then reached, then earliest; rounds without a submit never win", () => {
  const row = (version, progress, reached, submitted = "c1") => ({ version, progress, reached, submitted, compileError: null });
  assert.equal(pickBest([row(1, 0.5, 3), row(2, 0.7, 2), row(3, 0.7, 4), row(4, 0.7, 4)]).version, 3);
  assert.equal(pickBest([row(1, 0, 0, null), row(2, 0, 0)]).version, 2);
  assert.equal(pickBest([row(1, 0, 0, null)]), null);
});

test("a run writes versions, candidates, the tool log and the curve, and stops at the token budget", async () => {
  const dir = tmp();
  const m = scripted([[["score_on_train", { code: HOVER }]], [["submit", { program: "c1" }]], [["fly_route", { code: STRAIGHT, route: 1 }]], [["submit", { program: "c1" }]], [["submit", { program: "best" }]]], { prompt_tokens: 4000, completion_tokens: 1000 });
  const out = await agenticRun({ chat: m.chat, E, dir, rounds: 8, calls: 4, tokenBudget: 40000 });
  assert.equal(out.endReason, "token budget");
  assert.ok(out.tokens.total <= 40000);
  assert.ok(out.curve.length >= 2);
  assert.equal(fs.readFileSync(path.join(dir, "v1.js"), "utf8"), HOVER);
  assert.equal(fs.readFileSync(path.join(dir, "r2-c1.js"), "utf8"), STRAIGHT);
  const best = pickBest(out.curve);
  assert.equal(out.best, best.version);
  assert.equal(fs.readFileSync(path.join(dir, "best.js"), "utf8"), fs.readFileSync(path.join(dir, `v${best.version}.js`), "utf8"));
  const logged = fs.readFileSync(path.join(dir, "tools.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(logged.length, out.curve.reduce((a, c) => a + c.toolCalls, 0));
  // round 2 starts from the best program and its report, and the prompt never names a dev route
  const p2 = m.seen.find((s) => s.meta.round === 2).req.messages[1].content;
  assert.ok(p2.includes(HOVER) && p2.includes("Simulator results for the best program"));
  for (const sc of E.sets.dev) assert.ok(!p2.includes(JSON.stringify(E.world.nodes[sc.goal].map((x) => Math.round(x * 10) / 10))) || E.sets.train.some((t) => t.goal === sc.goal || t.start === sc.goal));
  assert.ok(firstPrompt("T", 1, 4, 12).includes("4 tool calls"));
});

test("the tool client waits out HTTP 429 and returns the tool calls", async () => {
  const dir = tmp();
  process.env.OPENROUTER_API_KEY ??= "test-key";
  process.env.RIPPLE_GLOBAL_SLOTS = "0";
  let n = 0;
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    if (n++ < 2) return { ok: false, status: 429, headers: new Map(), json: async () => ({ error: { message: "rate limited" } }) };
    return { ok: true, status: 200, headers: new Map(), json: async () => ({ provider: "PrimeIntellect", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "submit", arguments: "{}" } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) };
  };
  const c = makeToolClient({ root: dir, logFile: path.join(dir, "calls.jsonl"), backoffBaseMs: 1, fetchImpl });
  const out = await c.chat({ messages: [{ role: "user", content: "hi" }], tools: toolDefs(12) }, { run: 0 });
  c.close();
  assert.equal(out.message.tool_calls[0].function.name, "submit");
  assert.equal(c.ledger.calls, 1);
  assert.equal(c.ledger.transportRetries, 2);
  assert.equal(c.ledger.retryReasons[429], 2);
  assert.deepEqual(bodies[0].provider, { only: ["PrimeIntellect"], allow_fallbacks: false });
  delete process.env.RIPPLE_GLOBAL_SLOTS;
});

test("height-lock probe: a program that holds a fixed height is flagged, one that follows the goal is not", () => {
  const LOCKED = `function policy(obs) { const H = 1.0; return { velocity: [3, Math.max(-2, Math.min(2, H - obs.position[1])), 0] }; }`;
  assert.equal(heightLock(LOCKED).locked, true);
  assert.equal(heightLock(STRAIGHT).locked, false);
  assert.deepEqual(heightLock(STRAIGHT).drifts, [0, 0, 0]);
  assert.equal(heightLock("function nope( {").locked, null);
});
