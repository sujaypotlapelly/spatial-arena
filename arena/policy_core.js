// The browser's stand-in for sim/src/gym/policy_sandbox.js (which needs
// node:vm). Same contract: a program defines `function policy(obs, memory)`
// and returns { velocity: [vx, vy, vz] }; the observation goes in as JSON
// text and the result comes back as JSON text; Math.random is the seeded
// generator from engine.js rng(seed); a thrown error or a bad return hovers
// for that second and is recorded. This module holds only the pure part, so
// Node tests run the exact code the Web Worker runs. Isolation (a separate
// thread, no DOM, network globals removed, a time limit enforced by the page
// terminating the worker) is the worker's job: see policy_worker.js.

// Same algorithm as engine.js rng(seed).next.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// policy_sandbox.js separateRandomSeed, with Web Crypto (available in
// browsers and in Node 19+): sha256("program-random:<seed>"), first 4 bytes
// big-endian.
export async function separateRandomSeed(seed) {
  const bytes = new TextEncoder().encode(`program-random:${seed >>> 0}`);
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
}

// Names a program must not see. They are shadowed as parameters of the
// function the program is compiled into (and the worker also removes them
// from its own global object).
export const HIDDEN = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "postMessage", "close", "indexedDB", "caches", "BroadcastChannel", "Worker", "SharedWorker", "navigator", "location", "self", "globalThis", "window", "WebAssembly", "SharedArrayBuffer", "Atomics", "FinalizationRegistry", "WeakRef", "process", "require"];

const errMsg = (e) => String(e && typeof e === "object" && "message" in e ? e.message : e).slice(0, 300);

// compile(code, randomSeed) -> { error } or { call(obsText) -> resultText }
// resultText is JSON of { command, say, error } in the shape
// policy_sandbox.js programController returns.
export function compileProgram(code, randomSeed) {
  const M = {};
  for (const k of Object.getOwnPropertyNames(Math)) M[k] = Math[k];
  M.random = seededRandom(randomSeed);
  Object.freeze(M);
  let policy;
  try {
    // Sloppy-mode function body: top-level function and var declarations
    // become locals, as they become realm globals in the Node sandbox.
    const factory = new Function("Math", ...HIDDEN, `${code}\n;return typeof policy === "function" ? policy : undefined;`);
    policy = factory(M, ...HIDDEN.map(() => undefined));
  } catch (e) {
    return { error: `compile error: ${errMsg(e)}` };
  }
  if (typeof policy !== "function") return { error: "the program does not define function policy(obs, memory)" };
  const memory = {};
  const hover = (error) => ({ command: { velocity: [0, 0, 0] }, error: String(error).slice(0, 200), say: "" });
  return {
    call(obsText) {
      let out;
      try {
        const text = JSON.stringify(policy(JSON.parse(obsText), memory));
        out = text === undefined ? undefined : JSON.parse(text);
      } catch (e) {
        return JSON.stringify(hover(errMsg(e)));
      }
      const v = out?.velocity;
      if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => Number.isFinite(Number(x)))) return JSON.stringify(hover(`policy returned ${JSON.stringify(out)?.slice(0, 120)} (expected { velocity: [vx, vy, vz] })`));
      return JSON.stringify({ command: { velocity: v.map(Number) }, say: typeof out.say === "string" ? out.say.slice(0, 80) : "" });
    },
  };
}
