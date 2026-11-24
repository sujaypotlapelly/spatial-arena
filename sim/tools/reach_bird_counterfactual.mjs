// Did the program's own reaction to the bird matter? For each flight of a
// policy(obs, memory) program, fly it again with the same wind and the same
// bird but with its bird sensor masked (obs.bird always { visible: false,
// last_seen_s_ago: null }). A flight that survives with the sensor and is
// caught with it masked is an avoidance the program did itself. No model calls.
//   node sim/tools/reach_bird_counterfactual.mjs --set dev --random separate --out <file> <program.js> [...]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v } from "../src/world.js";
import { runEpisode } from "../src/gym/core.js";
import { ReachBird } from "../src/gym/reach_bird.js";
import { programController, programRandomSeed } from "../src/gym/policy_sandbox.js";
import { loadFactory, loadBirdSets } from "./reach_bird_scenarios.mjs";

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const setName = opt("--set", "dev");
if (!["train", "train_v1", "dev"].includes(setName)) throw new Error("--set must be train, train_v1 or dev");
const RANDOM = opt("--random", "separate");
const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const { world } = loadFactory();
const scenarios = loadBirdSets()[setName].filter((s) => s.bird.strategy !== "absent");

const MASK = { visible: false, last_seen_s_ago: null };
export async function flyPair(code, sc, seed, random = RANDOM) {
  const mk = () => programController(code, { seed, randomSeed: programRandomSeed(seed, random) });
  const seen = [];
  const inner = mk();
  const real = await runEpisode(new ReachBird(world, sc, seed), async (obs) => {
    if (obs.bird.visible) seen.push({ t: obs.time_s, d: obs.bird.distance_m });
    return inner(obs);
  });
  const innerM = mk();
  const masked = await runEpisode(new ReachBird(world, sc, seed), async (obs) => innerM({ ...obs, bird: MASK }));
  // First decision where the two flights' commands differ.
  let diverge = null;
  for (let k = 0; k < Math.min(real.decisions.length, masked.decisions.length); k++)
    if (JSON.stringify(real.decisions[k].command) !== JSON.stringify(masked.decisions[k].command)) { diverge = real.decisions[k].t; break; }
  return { real: real.result, masked: masked.result, seen, diverge, realSay: real.decisions.map((d) => d.say).filter(Boolean) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = [];
  for (const f of files) {
    const code = fs.readFileSync(f, "utf8");
    for (const sc of scenarios)
      for (const seed of sc.seeds) {
        const p = await flyPair(code, sc, seed);
        const row = {
          program: f, scenario: sc.id, seed, strategy: sc.bird.strategy,
          real: { outcome: p.real.outcome, time: p.real.time, minBirdDist: p.real.minBirdDist, contacts: p.real.contacts },
          masked: { outcome: p.masked.outcome, time: p.masked.time, minBirdDist: p.masked.minBirdDist },
          birdSeenDecisions: p.seen.length, closestSeen_m: p.seen.length ? Math.min(...p.seen.map((s) => s.d)) : null, firstSeen_t: p.seen[0]?.t ?? null, diverge_t: p.diverge,
          avoided: p.real.outcome !== "caught" && p.masked.outcome === "caught",
          causedCatch: p.real.outcome === "caught" && p.masked.outcome !== "caught",
        };
        rows.push(row);
      }
    const mine = rows.filter((r) => r.program === f);
    console.log(`${f}: n=${mine.length}; real caught ${mine.filter((r) => r.real.outcome === "caught").length}, masked caught ${mine.filter((r) => r.masked.outcome === "caught").length}; saved by its own reaction ${mine.filter((r) => r.avoided).length}, caught only because of its reaction ${mine.filter((r) => r.causedCatch).length}`);
    for (const r of mine.filter((r) => r.avoided)) console.log(`  saved: ${r.scenario} seed ${r.seed} (${r.strategy}): real ${r.real.outcome} at ${r.real.time}s, closest ${r.real.minBirdDist} m; masked caught at ${r.masked.time}s; bird first seen t=${r.firstSeen_t}s, commands diverge t=${r.diverge_t}s`);
  }
  if (opt("--out")) fs.writeFileSync(opt("--out"), JSON.stringify(rows, null, 1));
}
