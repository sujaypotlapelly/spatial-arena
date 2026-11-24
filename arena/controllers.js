// The flight programs a visitor can fly. Each says who wrote it, so nobody
// takes a frozen program or a hand-written rule for live steering by Ripple.
import { compileProgram, separateRandomSeed } from "./policy_core.js";

export const CONTROLLERS = [
  {
    id: "straight",
    name: "Straight-line program",
    kind: "hand-written",
    level: "C2",
    blurb: "Written by hand as a baseline. Each second it sends the goal's position as a target point and flies straight at it, so it steers around nothing. The benchmark's straight@C2 code."
  },
  {
    id: "reactive",
    name: "Hand-written program",
    kind: "hand-written",
    level: "C3",
    blurb: "Written by hand as the comparison for Ripple. Each second it picks the compass direction that best trades heading to the goal against free space. The benchmark's reactive@C3 code."
  },
  {
    id: "ripple-v7",
    name: "Ripple's flight program",
    kind: "written by Ripple, frozen",
    level: "C3",
    program: "programs/ripple-cap2-run3-v7.js",
    blurb: "JavaScript that Ripple wrote, then rewrote after reading the logs of its practice flights on 12 practice routes (practice run 3, version 7). Ripple is not running here: this page runs the saved program once per second, with no model calls."
  },
  {
    id: "custom",
    name: "Your flight program",
    kind: "yours",
    level: "C3",
    blurb: "Write or paste a policy(obs, memory) function. It runs in a Web Worker on this device with a time limit on each call, and nothing leaves the page."
  },
];

export const CALL_LIMIT_MS = 200;
export const COMPILE_LIMIT_MS = 1500;
export const MAX_TIMEOUTS = 3; // then the drone hovers for the rest of the flight

// Synchronous controller around policy_core, used by the Node tests to run the
// browser's code path without a Worker.
export function coreProgramController(code, randomSeed) {
  const p = compileProgram(code, randomSeed);
  if (p.error) return { compileError: p.error, controller: async () => ({ command: { velocity: [0, 0, 0] }, error: p.error, say: "" }) };
  return { compileError: null, controller: async (obs) => JSON.parse(p.call(JSON.stringify(obs))) };
}

// Browser: the program runs in a Web Worker. A call that does not answer in
// CALL_LIMIT_MS hovers for that second; the worker is then replaced and the
// program recompiled, so its memory starts empty again. After MAX_TIMEOUTS
// the program is not called again and the drone hovers.
export async function workerProgramController(code, windSeed, workerUrl) {
  const randomSeed = await separateRandomSeed(windSeed);
  let worker = null;
  let nextId = 1;
  const start = () =>
    new Promise((resolve) => {
      worker = new Worker(workerUrl, { type: "module" });
      const timer = setTimeout(() => { worker.terminate(); resolve(`compile timed out after ${COMPILE_LIMIT_MS} ms`); }, COMPILE_LIMIT_MS);
      worker.onmessage = (e) => { if (e.data.type === "compiled") { clearTimeout(timer); resolve(e.data.error); } };
      worker.onerror = (e) => { clearTimeout(timer); resolve(`worker failed: ${e.message || "unknown error"}`); };
      worker.postMessage({ type: "compile", code, randomSeed });
    });
  const compileError = await start();
  const hover = (error) => ({ command: { velocity: [0, 0, 0] }, error, say: "" });
  let timeouts = 0;
  const controller = async (obs) => {
    if (compileError) return hover(compileError);
    if (timeouts >= MAX_TIMEOUTS) return hover(`stopped calling the program after ${MAX_TIMEOUTS} time-outs`);
    const id = nextId++;
    const text = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), CALL_LIMIT_MS);
      worker.onmessage = (e) => { if (e.data.type === "result" && e.data.id === id) { clearTimeout(timer); resolve(e.data.text); } };
      worker.postMessage({ type: "call", id, obsText: JSON.stringify(obs) });
    });
    if (text !== null) return JSON.parse(text);
    worker.terminate();
    if (++timeouts < MAX_TIMEOUTS) await start();
    return hover(`timed out after ${CALL_LIMIT_MS} ms (program restarted, memory cleared)`);
  };
  return { compileError, controller, dispose: () => worker?.terminate() };
}

export const EXAMPLE_POLICY = `// Your flight program. Called once per second of flight.
// obs: the same instrument readings every C3 program gets (see the panel).
// memory: an object that persists between calls.
// Return { velocity: [vx, vy, vz] } in m/s (+x east, +y up, +z north).
// Length is capped at 5.5. Optional: say: "a short note".
function policy(obs, memory) {
  const p = obs.position, g = obs.goal.position, free = obs.free_space_m;
  const dirs = {
    east: [1, 0], north_east: [0.71, 0.71], north: [0, 1], north_west: [-0.71, 0.71],
    west: [-1, 0], south_west: [-0.71, -0.71], south: [0, -1], south_east: [0.71, -0.71],
  };
  const dx = g[0] - p[0], dz = g[2] - p[2];
  const len = Math.hypot(dx, dz) || 1;
  let best = null;
  for (const [name, d] of Object.entries(dirs)) {
    if (free[name] < 1) continue;
    const score = (d[0] * dx + d[1] * dz) / len + 0.4 * Math.min(free[name], 5) / 5
      + (name === memory.last ? 0.2 : 0);
    if (!best || score > best.score) best = { name, d, score };
  }
  if (!best) return { velocity: [0, 1, 0], say: "boxed in, climbing" };
  memory.last = best.name;
  const speed = Math.min(3.5, free[best.name] - 0.5);
  const vy = Math.max(-1, Math.min(1, g[1] - p[1]));
  return { velocity: [best.d[0] * speed, vy, best.d[1] * speed], say: "go " + best.name };
}
`;
