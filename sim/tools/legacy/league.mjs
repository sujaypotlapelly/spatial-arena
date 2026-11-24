// Self-play league (methodology v2, X2/X3). Each run: G generations; in
// each, the current drone-Ripple plays the current bird-Ripple on M training
// matches; then each side rewrites its notes from its own matches' logs and
// the simulator's verdicts. Notes are saved per generation for held-out
// evaluation with duel_eval.mjs --drone-notes / --bird-notes.
//
// Training scenarios are generated here from start/goal pairs that never
// appear in the held-out set, with their own seed range.
//
//   node sim/tools/legacy/league.mjs --runs 5 --gens 8 --matches 16 --out runs/league/main
//   node sim/tools/legacy/league.mjs --offline --runs 1 --gens 2 --matches 4   # plumbing only, no API
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../../src/world.js";
import { rng } from "../../src/engine.js";
import { playMatch, replayMatch } from "../../src/duel.js";
import { rippleDrone, rippleBird, evaderDrone, greedyBird, matchDigest, reflectionMessages } from "../../src/duel_agents.js";
import { makeClient, preflight } from "../ripple_client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const offline = args.includes("--offline");
const RUNS = Number(opt("--runs", 5));
const GENS = Number(opt("--gens", 8));
const MATCHES = Number(opt("--matches", 16));
const outDir = path.resolve(opt("--out", path.join(root, "runs/league", new Date().toISOString().replace(/[:.]/g, "-"))));
const world = new World(JSON.parse(fs.readFileSync(opt("--map", path.join(here, "../../maps/building.json")))));
const heldout = JSON.parse(fs.readFileSync(opt("--heldout", path.join(here, "../../scenarios/heldout-36.json")))).scenarios;
fs.mkdirSync(outDir, { recursive: true });

// ---------- training scenarios (disjoint from held-out start/goal pairs) ----------
const banned = new Set(heldout.map((s) => `${s.start}>${s.goal}`));
const N = world.nodes;
const flat = (a, b) => Math.hypot(N[a][0] - N[b][0], N[a][2] - N[b][2]);
const pairs = [];
for (const a of world.nodeIds) for (const b of world.nodeIds) if (a !== b && !banned.has(`${a}>${b}`) && flat(a, b) >= 15) pairs.push([a, b]);
function trainingSet(run, gen) {
  const R = rng(700000 + run * 1000 + gen);
  const out = [];
  for (let i = 0; i < MATCHES; i++) {
    const [start, goal] = pairs[Math.floor(R.next() * pairs.length)];
    const birdNodes = world.nodeIds.filter((id) => id !== start && id !== goal && flat(id, start) >= 10);
    const birdStart = birdNodes[Math.floor(R.next() * birdNodes.length)];
    out.push({ id: `T${run}.${gen}.${i}`, start, goal, seeds: [710000 + run * 10000 + gen * 100 + i], bird: { start: birdStart, strategy: "pursue", ambush_node: birdStart, speed: 4, lead_time: 0, trigger_distance: 12 } });
  }
  return out;
}
fs.writeFileSync(path.join(outDir, "training-pairs.json"), JSON.stringify({ banned: [...banned], nPairs: pairs.length }, null, 1));

// ---------- controllers ----------
const client = offline ? null : makeClient({ root, maxInFlight: Number(opt("--concurrency", 24)), logFile: path.join(outDir, "calls.jsonl") });
if (client) console.log(`preflight ok on ${await preflight(client)}`);
const droneFor = (sc, notes) => (offline ? evaderDrone(world, sc) : rippleDrone(world, sc, client.chat, notes));
const birdFor = (sc, notes) => (offline ? greedyBird(world, sc) : rippleBird(world, sc, client.chat, notes));
async function reflect(role, digests, oldNotes, meta) {
  if (offline) return `${role} notes (offline stand-in) after ${digests.length} matches`;
  const r = await client.chat(reflectionMessages(world, role, digests, oldNotes), { role: `${role}-notes`, ...meta }, { max_tokens: 600 });
  const text = r.content.trim();
  return text.split(/\s+/).length > 260 ? text.split(/\s+/).slice(0, 260).join(" ") : text; // hard cap
}

// ---------- league ----------
const t0 = Date.now();
await Promise.all(
  Array.from({ length: RUNS }, async (_, run) => {
    let notes = { drone: null, bird: null };
    const runDir = path.join(outDir, `run${run}`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "gen0-drone.json"), JSON.stringify({ text: null }));
    fs.writeFileSync(path.join(runDir, "gen0-bird.json"), JSON.stringify({ text: null }));
    for (let gen = 0; gen < GENS; gen++) {
      const set = trainingSet(run, gen);
      const results = await Promise.all(
        set.map(async (sc) => {
          const m = await playMatch(world, sc, sc.seeds[0], { drone: droneFor(sc, notes.drone), bird: birdFor(sc, notes.bird) });
          const re = replayMatch(world, sc, sc.seeds[0], m.decisions, { birdMode: "command" });
          return { sc, m, replayOk: re.outcome === m.result.outcome && re.time === m.result.time };
        }),
      );
      const reached = results.filter((x) => x.m.result.outcome === "reached").length;
      fs.appendFileSync(path.join(runDir, "matches.jsonl"), results.map((x) => JSON.stringify({ gen, scenario: x.sc, result: (({ events, ...r }) => r)(x.m.result), replayOk: x.replayOk, decisions: x.m.decisions })).join("\n") + "\n");
      const [dn, bn] = await Promise.all([
        reflect("drone", results.map((x) => matchDigest("drone", x.m, x.sc)), notes.drone, { run, gen }),
        reflect("bird", results.map((x) => matchDigest("bird", x.m, x.sc)), notes.bird, { run, gen }),
      ]);
      notes = { drone: dn, bird: bn };
      fs.writeFileSync(path.join(runDir, `gen${gen + 1}-drone.json`), JSON.stringify({ text: dn, run, gen: gen + 1 }, null, 1));
      fs.writeFileSync(path.join(runDir, `gen${gen + 1}-bird.json`), JSON.stringify({ text: bn, run, gen: gen + 1 }, null, 1));
      fs.appendFileSync(path.join(runDir, "progress.jsonl"), JSON.stringify({ gen, droneWins: reached, matches: set.length, replayOk: results.filter((x) => x.replayOk).length }) + "\n");
      console.log(`run ${run} gen ${gen}: drone won ${reached}/${set.length} in training; notes written (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }),
);
fs.writeFileSync(path.join(outDir, "ledger.json"), JSON.stringify(client?.ledger ?? { offline: true }, null, 1));
client?.close();
console.log("done", path.relative(root, outDir));
