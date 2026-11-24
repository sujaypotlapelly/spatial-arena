// Runs a model-written navigation policy (code as policy). The program is
// plain JavaScript defining `function policy(obs, memory)` that returns
// { velocity: [vx, vy, vz] }.
//
// Isolation: the program runs in its own V8 realm that holds no host objects.
// - The realm is created with DONT_CONTEXTIFY, so its global object and every
//   built-in (Object, Function, JSON, Math, ...) belong to that realm. Nothing
//   from the host is passed in, so there is no host `Function` constructor to
//   reach `process`, `require` or the network from.
// - eval, new Function and WebAssembly compilation from strings are disabled.
// - Promise jobs run inside the same time limit (microtaskMode afterEvaluate).
// - Only strings cross the boundary: the observation goes in as JSON text and
//   the result, or the error message, comes back as JSON text, both produced
//   inside the timed call. No program-defined getter or toJSON ever runs on
//   the host's stack.
// - Math.random is a seeded generator defined inside the realm, the same
//   sequence as engine.js rng(seed), so runs stay deterministic.
//
// node:vm is still not a substitute for an OS sandbox. To run programs you did
// not generate yourself, prefer a container or VM as well.

import crypto from "node:crypto";
import vm from "node:vm";

export function extractCode(reply) {
  if (typeof reply !== "string") return "";
  const fenced = [...reply.matchAll(/```(?:js|javascript)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const code = fenced.length ? fenced.sort((a, b) => b.length - a.length)[0] : reply;
  return code.trim();
}

// Same algorithm as engine.js rng(seed).next, written as source so the
// generator lives inside the program's realm.
const PRELUDE = (seed) => `"use strict";
(() => {
  let a = ${seed >>> 0};
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const M = {};
  for (const k of Object.getOwnPropertyNames(Math)) M[k] = Math[k];
  M.random = next;
  Object.defineProperty(globalThis, "Math", { value: Object.freeze(M), writable: false, configurable: false });
  const hide = (k) => Object.defineProperty(globalThis, k, { value: undefined, writable: false, configurable: false });
  for (const k of ["WebAssembly", "SharedArrayBuffer", "Atomics", "FinalizationRegistry", "WeakRef"]) hide(k);
})();`;

const errText = (where) => `(e) => "${where}" + String(e && typeof e === "object" && "message" in e ? e.message : e).slice(0, 300)`;

// The seed for a program's Math.random, kept apart from the wind's. The
// published runs gave both the same seed, so a program could in principle
// reproduce the gusts from its own random numbers. New runs pass this as
// randomSeed; leaving randomSeed out keeps the old behaviour, so a published
// program re-flies exactly as it was recorded.
export const separateRandomSeed = (seed) => crypto.createHash("sha256").update(`program-random:${seed >>> 0}`).digest().readUInt32BE(0);
export const programRandomSeed = (seed, mode = "legacy") => {
  if (mode !== "legacy" && mode !== "separate") throw new Error(`--random must be legacy or separate, not ${mode}`);
  return mode === "separate" ? separateRandomSeed(seed) : seed;
};

export function compilePolicy(code, { seed = 1, randomSeed = seed, callTimeoutMs = 50 } = {}) {
  const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  try {
    new vm.Script(PRELUDE(randomSeed)).runInContext(context);
  } catch (err) {
    return { error: `sandbox setup failed: ${String(err.message || err).slice(0, 300)}` };
  }
  // The program is loaded as a classic script, as before, so top-level
  // function and var declarations become globals of the realm.
  let status;
  try {
    new vm.Script(code, { filename: "policy.js" }).runInContext(context, { timeout: 500 });
    status = vm.runInContext(`typeof policy === "function" ? "ok" : "missing"`, context, { timeout: 50 });
  } catch (err) {
    // Compile and runtime errors thrown by the program are realm objects:
    // read their message inside the realm, under a time limit.
    let msg;
    try {
      if (err instanceof Error) msg = String(err.message); // host error (timeout, SyntaxError)
      else {
        context.__e = err;
        msg = vm.runInContext(`(${errText("")})(globalThis.__e)`, context, { timeout: 50 });
      }
    } catch {
      msg = "the program threw a value that could not be read";
    }
    return { error: `compile error: ${String(msg).slice(0, 300)}` };
  }
  if (status !== "ok") return { error: "the program does not define function policy(obs, memory)" };

  // One timed call: parse the observation, run the policy, serialize the
  // result. Returns JSON text for a result, or a string starting with "\u0000"
  // for an error message.
  const callScript = new vm.Script(`(() => {
    try {
      const out = policy(JSON.parse(globalThis.__obsText), globalThis.__mem);
      const text = JSON.stringify(out);
      return text === undefined ? "\\u0001" : text;
    } catch (e) {
      return (${errText("\\u0000")})(e);
    }
  })()`);
  return {
    newMemory() {
      vm.runInContext("globalThis.__mem = {};", context);
    },
    call(obs) {
      context.__obsText = JSON.stringify(obs);
      const text = callScript.runInContext(context, { timeout: callTimeoutMs });
      if (typeof text !== "string") throw new Error("policy sandbox returned a non-string");
      if (text[0] === "\u0000") throw new Error(text.slice(1));
      if (text === "\u0001") return undefined;
      return JSON.parse(text);
    },
  };
}

// Per-call time budgets.
// - legacy (the default, every published run): 50 ms of wall clock. A call
//   that runs over hovers for that step. On a slower machine the same program
//   can time out where it did not before, so results can differ by machine.
// - arena: a generous 1000 ms limit, with every call timed and every timeout
//   recorded. A run is reported as machine-independent only when no call timed
//   out and the slowest call used under a tenth of the limit
//   (timingVerdict below), so a 10x slower machine would still have given the
//   same flights. V8 offers no instruction counter, so an exact step budget
//   would need the program rewritten with counters; this is the honest
//   alternative.
export const BUDGETS = {
  legacy: { callTimeoutMs: 50, record: false },
  arena: { callTimeoutMs: 1000, record: true },
};
export const SAFETY_FACTOR = 10;

const isTimeout = (err) => err?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /Script execution timed out/.test(String(err?.message));

// Controller for runEpisode: calls the program once per decision. A thrown
// error, a timeout or an invalid return hovers for that step and is recorded.
// budget: "legacy" (default, unchanged records) or "arena" (or an object like
// BUDGETS.arena); with record: true each decision also carries callMs and, on
// a timeout, timeout: true.
export function programController(code, { seed = 1, randomSeed = seed, budget = "legacy" } = {}) {
  const B = typeof budget === "string" ? BUDGETS[budget] : budget;
  if (!B) throw new Error(`unknown policy budget ${budget} (legacy or arena)`);
  const p = compilePolicy(code, { seed, randomSeed, callTimeoutMs: B.callTimeoutMs });
  if (p.error) return async () => ({ command: { velocity: [0, 0, 0] }, error: p.error, say: "" });
  p.newMemory();
  return async (obs) => {
    const t0 = B.record ? performance.now() : 0;
    const timing = (extra = {}) => (B.record ? { callMs: Math.round((performance.now() - t0) * 100) / 100, ...extra } : {});
    try {
      const out = p.call(obs);
      const v = out?.velocity;
      if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => Number.isFinite(Number(x)))) throw new Error(`policy returned ${JSON.stringify(out)?.slice(0, 120)} (expected { velocity: [vx, vy, vz] })`);
      return { command: { velocity: v.map(Number) }, say: typeof out.say === "string" ? out.say.slice(0, 80) : "", ...timing() };
    } catch (err) {
      return { command: { velocity: [0, 0, 0] }, error: String(err.message || err).slice(0, 200), say: "", ...timing(isTimeout(err) ? { timeout: true } : {}) };
    }
  };
}

// Summary of the recorded timings of one or more flights (decisions from
// programController with a recording budget).
export function timingVerdict(decisions, callTimeoutMs = BUDGETS.arena.callTimeoutMs) {
  const timed = decisions.filter((d) => typeof d.callMs === "number");
  const timeouts = decisions.filter((d) => d.timeout).length;
  const slowestMs = timed.length ? Math.max(...timed.map((d) => d.callMs)) : null;
  const sorted = timed.map((d) => d.callMs).sort((a, b) => a - b);
  const p99Ms = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))] : null;
  const machineIndependent = timed.length > 0 && timeouts === 0 && slowestMs < callTimeoutMs / SAFETY_FACTOR;
  return { calls: timed.length, timeouts, slowestMs, p99Ms, callTimeoutMs, machineIndependent };
}
