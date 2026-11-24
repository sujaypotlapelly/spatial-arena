// Closed-loop evaluation (methodology v2): every drone controller against
// every bird controller on held-out scenarios, matches in parallel, Ripple
// on one pinned host. Every match is re-flown from its recorded commands and
// must reproduce exactly.
//
//   node sim/tools/legacy/duel_eval.mjs --limit 12 --seeds 2 --drones ripple,evader,shortest \
//     --birds script,greedy,ripple --out runs/duel/pilot
//
// Options: --map, --heldout, --limit (scenarios, spread across the file),
// --seeds (per scenario), --temp (default 0.7), --provider (default
// PrimeIntellect), --concurrency (in-flight API calls, default 24),
// --drone-notes / --bird-notes (JSON {text} from league.mjs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../../src/world.js";
import { playMatch, replayMatch } from "../../src/duel.js";
import { rippleDrone, rippleBird, shortestDrone, evaderDrone, greedyBird } from "../../src/duel_agents.js";
import { makeClient, preflight } from "../ripple_client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);

const mapFile = opt("--map", path.join(here, "../../maps/building.json"));
const heldoutFile = opt("--heldout", path.join(here, "../../scenarios/heldout-36.json"));
const world = new World(JSON.parse(fs.readFileSync(mapFile)));
const all = JSON.parse(fs.readFileSync(heldoutFile)).scenarios;
const limit = Number(opt("--limit", all.length));
const scenarios = all.filter((_, i) => i % Math.max(1, Math.floor(all.length / limit)) === 0).slice(0, limit);
const nSeeds = Number(opt("--seeds", 2));
// --variants file.json: {"drone": {"name": "notes.json" | null, ...}, "bird": {...}}
// adds Ripple controllers that carry notes (league generations, controls).
const variants = opt("--variants") ? JSON.parse(fs.readFileSync(opt("--variants"))) : { drone: {}, bird: {} };
const drones = [...(opt("--drones", "ripple,evader,shortest") ? opt("--drones", "ripple,evader,shortest").split(",").filter(Boolean) : []), ...Object.keys(variants.drone || {})];
const birds = [...(opt("--birds", "script,greedy,ripple") ? opt("--birds", "script,greedy,ripple").split(",").filter(Boolean) : []), ...Object.keys(variants.bird || {})];
const temperature = Number(opt("--temp", 0.7));
const provider = opt("--provider", "PrimeIntellect");
const outDir = opt("--out", path.join(root, "runs/duel", new Date().toISOString().replace(/[:.]/g, "-")));
fs.mkdirSync(outDir, { recursive: true });

// ---------- Ripple client (shared, pinned host) ----------
const usesRipple = drones.some((d) => d === "ripple" || variants.drone?.[d] !== undefined) || birds.some((b) => b === "ripple" || variants.bird?.[b] !== undefined);
const client = makeClient({ root, provider, temperature, maxInFlight: Number(opt("--concurrency", 24)), logFile: path.join(outDir, "calls.jsonl") });
const chat = client.chat;
const ledger = client.ledger;
const readNotes = (f) => (f ? JSON.parse(fs.readFileSync(f)).text : null);
const droneNotes = readNotes(opt("--drone-notes"));
const birdNotes = readNotes(opt("--bird-notes"));
if (usesRipple) console.log(`preflight ok on ${await preflight(client)}`);

const DRONES = { ripple: (w, s) => rippleDrone(w, s, chat, droneNotes), evader: evaderDrone, shortest: shortestDrone };
const BIRDS = { script: null, greedy: greedyBird, ripple: (w, s) => rippleBird(w, s, chat, birdNotes) };
for (const [name, f] of Object.entries(variants.drone || {})) { const n = readNotes(f); DRONES[name] = (w, s) => rippleDrone(w, s, chat, n); }
for (const [name, f] of Object.entries(variants.bird || {})) { const n = readNotes(f); BIRDS[name] = (w, s) => rippleBird(w, s, chat, n); }
const FAMILY = { pursue: "chasing me", intercept: "chasing me", ambush: "waiting in ambush", patrol: "patrolling" };

// ---------- run ----------
const jobs = [];
for (const d of drones) for (const b of birds) for (const sc of scenarios) for (const seed of sc.seeds.slice(0, nSeeds)) jobs.push({ d, b, sc, seed });
console.log(`${jobs.length} matches: drones ${drones} × birds ${birds} × ${scenarios.length} scenarios × ${nSeeds} seeds; host ${provider}, T=${temperature}`);
const matchLog = fs.createWriteStream(path.join(outDir, "matches.jsonl"));
const t0 = Date.now();
let done = 0;
const rows = await Promise.all(
  jobs.map(async ({ d, b, sc, seed }) => {
    const m = await playMatch(world, sc, seed, { drone: DRONES[d](world, sc), bird: BIRDS[b] ? BIRDS[b](world, sc) : null });
    const re = replayMatch(world, sc, seed, m.decisions, { birdMode: BIRDS[b] ? "command" : "script" });
    const replayOk = re.outcome === m.result.outcome && re.time === m.result.time && re.endPos.join() === m.result.endPos.join();
    // Drone belief scoring (scripted birds have a known behavior).
    const beliefs = m.decisions.map((x) => x.drone.belief).filter(Boolean);
    let intentRight = null;
    if (b === "script" && beliefs.length) intentRight = beliefs.filter((x) => x.intent === FAMILY[sc.bird.strategy]).length / beliefs.length;
    const predErr = [];
    for (const x of m.decisions) {
      const p = x.drone.belief?.bird_in_2s;
      if (!Array.isArray(p) || p.length !== 3) continue;
      const f = m.frames.find((fr) => fr.t >= x.t + 2 - 1e-6);
      if (f) predErr.push(Math.hypot(p[0] - f.b[0], p[1] - f.b[1], p[2] - f.b[2]));
    }
    const invalid = { drone: m.decisions.filter((x) => x.drone.invalid).length, bird: m.decisions.filter((x) => x.bird?.invalid).length };
    const { events, ...result } = m.result;
    const row = { drone: d, bird: b, scenario: sc.id, behavior: sc.bird.strategy, seed, result, replayOk, decisions: m.decisions.length, invalid, intentRight, predErr: predErr.length ? predErr.reduce((a, c) => a + c, 0) / predErr.length : null };
    matchLog.write(JSON.stringify({ ...row, events, decisionLog: m.decisions, frames: m.frames.map((f) => [Math.round(f.t * 100) / 100, ...f.d.map((n) => Math.round(n * 100) / 100), ...f.b.map((n) => Math.round(n * 100) / 100)]) }) + "\n");
    done++;
    process.stdout.write(`\r${done}/${jobs.length} matches, ${ledger.calls} calls, ${Math.round((Date.now() - t0) / 1000)} s   `);
    return row;
  }),
);
console.log();

// ---------- summary (bootstrap over scenarios) ----------
function boot(rowsIn, stat, B = 2000) {
  const byScen = Object.values(Object.groupBy(rowsIn, (r) => r.scenario));
  let s = 12345;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const vals = [];
  for (let i = 0; i < B; i++) vals.push(stat(byScen.flatMap(() => byScen[Math.floor(rand() * byScen.length)])));
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * B)], vals[Math.floor(0.975 * B)]];
}
const rate = (rs, o) => rs.filter((r) => r.result.outcome === o).length / rs.length;
const mean = (xs) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null);
const cells = [];
for (const d of drones)
  for (const b of birds) {
    const rs = rows.filter((r) => r.drone === d && r.bird === b);
    const ci = boot(rs, (x) => rate(x, "reached"));
    cells.push({
      drone: d,
      bird: b,
      matches: rs.length,
      reached: rate(rs, "reached"),
      reachedCI: ci,
      caught: rate(rs, "intercepted"),
      crashed: rate(rs, "crashed"),
      timeout: rate(rs, "timeout"),
      meanDecisions: mean(rs.map((r) => r.decisions)),
      invalidDrone: rs.reduce((a, r) => a + r.invalid.drone, 0) / Math.max(1, rs.reduce((a, r) => a + r.decisions, 0)),
      invalidBird: rs.reduce((a, r) => a + r.invalid.bird, 0) / Math.max(1, rs.reduce((a, r) => a + r.decisions, 0)),
      intentAccuracy: mean(rs.map((r) => r.intentRight).filter((x) => x !== null)),
      predErrM: mean(rs.map((r) => r.predErr).filter((x) => x !== null)),
      replayOk: rs.filter((r) => r.replayOk).length,
    });
  }
const pct = (x) => (x === null || x === undefined ? "  -  " : `${Math.round(x * 100)}%`.padStart(5));
console.log("drone     bird      n   reached [95% CI]     caught crashed timeout  invalid d/b   intent  pred2s_m  replay");
for (const c of cells)
  console.log(
    `${c.drone.padEnd(9)} ${c.bird.padEnd(8)} ${String(c.matches).padStart(3)}  ${pct(c.reached)} [${pct(c.reachedCI[0])}-${pct(c.reachedCI[1])}]  ${pct(c.caught)}  ${pct(c.crashed)}  ${pct(c.timeout)}   ${pct(c.invalidDrone)}/${pct(c.invalidBird)}  ${pct(c.intentAccuracy)}  ${c.predErrM === null ? "  -  " : c.predErrM.toFixed(1).padStart(5)}    ${c.replayOk}/${c.matches}`,
  );
const summary = { at: new Date().toISOString(), variants, droneNotes: opt("--drone-notes"), birdNotes: opt("--bird-notes"), map: path.relative(root, mapFile), heldout: path.relative(root, heldoutFile), scenarios: scenarios.map((s) => s.id), seeds: nSeeds, temperature, provider, model: client.model, wallSeconds: Math.round((Date.now() - t0) / 1000), ledger, cells };
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
console.log("ledger", ledger, "\nwrote", path.relative(root, outDir));
matchLog.end();
client.close();
