// Transfer matrix on DEV routes (local, no model calls): every frozen program
// flown unchanged in every environment, with the hand-written baselines as
// references, and each failed flight classified from its own recording.
//   node sim/tools/transfer_matrix.mjs --maps factory,canyon,residential,building \
//     --programs factory=runs/reach/cap2/run3/best.js,canyon=... --seeds 2 \
//     --out runs/transfer-v2/matrix
// Writes episodes.jsonl (one row per flight, with its diagnostics) and
// summary.json (counts, rates, 95% intervals from a bootstrap over routes,
// and failure classes per cell).
// Only dev routes are flown. The building has no pinned dev set, so its dev
// routes come from devRoutes() in benchmark_env.mjs, disjoint from its test set.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { v } from "../src/world.js";
import { Reach } from "../src/gym/reach.js";
import { runEpisode } from "../src/gym/core.js";
import { straightReach, reactiveReach } from "../src/gym/reach_agents.js";
import { programController, programRandomSeed } from "../src/gym/policy_sandbox.js";
import { rng } from "../src/engine.js";
import { loadEnvironment, devRoutes, root } from "./benchmark_env.mjs";

const self = fileURLToPath(import.meta.url);

// ---------- failure classification (pure; tested in sim/test/transfer.test.mjs) ----------
// d: per-decision samples { t, pos, down, up, cmd } ; goal [x,y,z]; result from Reach.
// Classes, first match wins:
//   reached        the goal was reached
//   error          the program threw or returned nothing usable on at least a quarter of decisions
//   altitude       a height problem, any of: (a) for at least half the flight the drone sat
//                  within 0.25 m of a surface below (or above) while commanding further down
//                  (or up); (b) it ended within 3 m of the goal horizontally but more than 1 m
//                  away vertically; (c) its median height was more than 2 m outside the band
//                  between the start and goal heights
//   stuck          it moved less than 3 m (net) over its last 30 s
//   timeout        it kept moving but did not arrive in 90 s
export function classifyFlight(d, goal, result, errors = 0) {
  if (result.outcome === "reached") return "reached";
  if (d.length && errors / d.length >= 0.25) return "error";
  const pinned = d.filter((s) => (s.down <= 0.25 && s.cmd[1] < -0.1) || (s.up <= 0.25 && s.cmd[1] > 0.1)).length;
  const end = d.at(-1)?.pos ?? result.endPos;
  const horiz = Math.hypot(end[0] - goal[0], end[2] - goal[2]);
  const ys = d.map((s) => s.pos[1]).sort((a, b) => a - b);
  const med = ys.length ? ys[ys.length >> 1] : end[1];
  const start = d[0]?.pos ?? end;
  const off = med < Math.min(start[1], goal[1]) - 2 || med > Math.max(start[1], goal[1]) + 2;
  if ((d.length && pinned / d.length >= 0.5) || (horiz < 3 && Math.abs(end[1] - goal[1]) > 1) || off) return "altitude";
  const last = d.filter((s) => s.t >= (d.at(-1)?.t ?? 0) - 30);
  if (last.length >= 2 && v.dist(last[0].pos, last.at(-1).pos) < 3) return "stuck";
  return "timeout";
}

// Bootstrap over routes (both seeds of a route move together).
export function clusterCI(rows, stat, B = 2000, seed = 12345) {
  const g = Object.groupBy(rows, (r) => r.scenario);
  const by = Object.keys(g).sort().map((k) => g[k].slice().sort((a, b) => a.seed - b.seed));
  if (!by.length) return [null, null];
  const rand = rng(seed).next;
  const vals = [];
  for (let i = 0; i < B; i++) vals.push(stat(by.flatMap(() => by[Math.floor(rand() * by.length)])));
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * B)], vals[Math.floor(0.975 * B)]];
}

// ---------- one flight ----------
async function fly({ map, scenario, seed, agent }) {
  const E = cache[map] ?? (cache[map] = loadEnvironment(map));
  const world = E.world;
  let inner;
  if (agent.kind === "program") inner = programController(agent.code, { seed, randomSeed: programRandomSeed(seed, "separate") });
  else if (agent.kind === "reactive") inner = reactiveReach(world, scenario, agent.params ?? undefined);
  else if (agent.kind === "straight") inner = straightReach(world, scenario);
  const level = agent.kind === "straight" ? "C2" : "C3";
  const samples = [];
  const ctl = async (obs) => {
    const out = await inner(obs);
    samples.push({ t: obs.time_s, pos: obs.position, down: obs.free_space_m?.down ?? 12, up: obs.free_space_m?.up ?? 12, cmd: Array.isArray(out?.command?.velocity) ? out.command.velocity.map(Number) : [0, 0, 0] });
    return out;
  };
  const ep = await runEpisode(new Reach(world, scenario, seed, level), ctl);
  const goal = world.nodes[scenario.goal];
  const errors = ep.decisions.filter((x) => x.error || x.invalid).length;
  const r = ep.result;
  const ys = samples.map((s) => s.pos[1]);
  return {
    map, agent: agent.name, scenario: scenario.id, seed, straight_m: scenario.straight_m,
    startY: world.nodes[scenario.start][1], goalY: goal[1],
    result: r, progress: Math.max(0, 1 - r.minGoalDist / scenario.straight_m), errors,
    cls: classifyFlight(samples, goal, r, errors),
    meanY: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null,
    floorShare: samples.length ? samples.filter((s) => s.down <= 0.25).length / samples.length : null,
  };
}
const cache = {};

if (!isMainThread) {
  parentPort.on("message", async (job) => {
    if (job === "exit") process.exit(0);
    try { parentPort.postMessage({ ok: await fly(job) }); } catch (e) { parentPort.postMessage({ err: String(e?.stack ?? e) }); }
  });
} else if (process.argv[1] === self) {
  const args = process.argv.slice(2);
  const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const maps = opt("--maps", "factory,canyon,residential,building").split(",");
  const nSeeds = Number(opt("--seeds", 2));
  // --set dev (default) | train. Test sets are never available here.
  const SET = opt("--set", "dev");
  if (!["dev", "train"].includes(SET)) throw new Error("--set must be dev or train");
  const outDir = path.resolve(opt("--out", path.join(root, "runs/transfer-v2/matrix")));
  const progs = (opt("--programs", "") || "").split(",").filter(Boolean).map((s) => { const [name, file] = s.split("="); return { name, kind: "program", file: path.resolve(file), code: fs.readFileSync(path.resolve(file), "utf8") }; });
  const refs = (opt("--refs", "straight,reactive") || "").split(",").filter(Boolean).map((s) => {
    const [name, file] = s.split("=");
    if (name === "straight") return { name, kind: "straight" };
    if (name === "reactive") return { name, kind: "reactive" };
    return { name, kind: "reactive", file, params: JSON.parse(fs.readFileSync(path.resolve(file), "utf8")).best.params };
  });
  const agents = [...progs, ...refs];
  fs.mkdirSync(outDir, { recursive: true });
  const jobs = [];
  const routes = {};
  for (const m of maps) {
    const E = loadEnvironment(m);
    routes[m] = SET === "dev" ? devRoutes(E) : E.sets.train;
    if (!routes[m].length) throw new Error(`${m} has no ${SET} routes`);
    const seedsFor = (sc) => Array.from({ length: nSeeds }, (_, k) => (k < sc.seeds.length ? sc.seeds[k] : sc.seeds[0] + 1000 * k));
    for (const a of agents) for (const sc of routes[m]) for (const seed of seedsFor(sc)) jobs.push({ map: m, scenario: sc, seed, agent: { name: a.name, kind: a.kind, code: a.code, params: a.params } });
  }
  console.log(`${jobs.length} flights: ${agents.length} agents x ${maps.join("/")} ${SET} x ${nSeeds} seeds`);
  const N = Math.max(1, Math.min(Number(opt("--workers", os.cpus().length - 1)), jobs.length));
  const rows = [];
  const log = fs.createWriteStream(path.join(outDir, "episodes.jsonl"));
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    let next = 0, live = N;
    for (let w = 0; w < N; w++) {
      const W = new Worker(self);
      const feed = () => { if (next < jobs.length) W.postMessage(jobs[next++]); else { W.postMessage("exit"); if (--live === 0) resolve(); } };
      W.on("message", (m) => {
        if (m.err) return reject(new Error(m.err));
        rows.push(m.ok); log.write(JSON.stringify(m.ok) + "\n");
        if (rows.length % 50 === 0) process.stdout.write(`\r${rows.length}/${jobs.length} [${Math.round((Date.now() - t0) / 1000)} s]  `);
        feed();
      });
      W.on("error", reject);
      feed();
    }
  });
  log.end();
  console.log();
  const reachedRate = (rs) => rs.filter((r) => r.result.outcome === "reached").length / rs.length;
  const cells = [];
  for (const a of agents) for (const m of maps) {
    const rs = rows.filter((r) => r.agent === a.name && r.map === m);
    const classes = Object.fromEntries(["reached", "altitude", "stuck", "timeout", "error"].map((c) => [c, rs.filter((r) => r.cls === c).length]));
    cells.push({ agent: a.name, file: a.file ?? null, map: m, flights: rs.length, routes: routes[m].length, reached: classes.reached, rate: reachedRate(rs), ci: clusterCI(rs, reachedRate), progress: rs.reduce((x, r) => x + r.progress, 0) / rs.length, classes });
  }
  const pct = (x) => (x == null ? " - " : `${Math.round(x * 100)}%`);
  for (const c of cells) console.log(`${c.agent.padEnd(18)} ${c.map.padEnd(12)} ${String(c.reached).padStart(3)}/${c.flights} ${pct(c.rate).padStart(4)} [${pct(c.ci[0])}-${pct(c.ci[1])}]  alt ${c.classes.altitude} stuck ${c.classes.stuck} timeout ${c.classes.timeout} err ${c.classes.error}`);
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ at: new Date().toISOString(), set: SET, programRandom: "separate", seeds: nSeeds, maps, routes: Object.fromEntries(Object.entries(routes).map(([m, rs]) => [m, rs.map((s) => s.id)])), buildingDevRoutes: routes.building ?? null, wallSeconds: Math.round((Date.now() - t0) / 1000), cells }, null, 1));
  console.log("wrote", path.relative(root, outDir));
}
