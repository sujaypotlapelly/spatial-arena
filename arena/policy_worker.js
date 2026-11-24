// Runs one controller program off the page's thread. The page sends the
// program once, then one observation (as JSON text) per second of flight,
// and terminates this worker if a call runs past its time limit.
// Only strings cross in either direction.
import { compileProgram, HIDDEN } from "./policy_core.js";

const send = self.postMessage.bind(self);
// Remove network and messaging globals before any program code runs. The
// program is also compiled with these names shadowed (policy_core.js).
// They live on the global object and on its prototypes (fetch and
// importScripts are WorkerGlobalScope.prototype methods), so scrub the chain.
const SCRUB = [...HIDDEN, "WebTransport", "WebSocketStream"].filter((k) => k !== "self" && k !== "globalThis");
for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
  for (const k of SCRUB) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
    try { delete o[k]; } catch {}
    try { Object.defineProperty(o, k, { value: undefined, writable: false, configurable: false }); } catch {}
  }
}

let program = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "compile") {
    program = compileProgram(String(m.code), m.randomSeed >>> 0);
    send({ type: "compiled", error: program.error ?? null });
  } else if (m.type === "call") {
    send({ type: "result", id: m.id, text: program && !program.error ? program.call(String(m.obsText)) : JSON.stringify({ command: { velocity: [0, 0, 0] }, error: "no program", say: "" }) });
  }
};
