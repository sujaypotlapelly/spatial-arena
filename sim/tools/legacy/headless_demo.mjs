// Runs the whole pipeline headless (no browser) and prints metrics.
//   node sim/tools/legacy/headless_demo.mjs            # offline heuristic stand-ins
//   SIM_URL=http://localhost:8765 node sim/tools/legacy/headless_demo.mjs   # Ripple via running server
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../../src/world.js";
import { Arena, TRAINING_EPISODES } from "../../src/arena.js";
import { ModelClient } from "../../src/agents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// --map / MAP selects the map (default: the grey building).
const mapArg = process.argv.includes("--map") ? process.argv[process.argv.indexOf("--map") + 1] : process.env.MAP;
const mapFile = mapArg || path.join(here, "../../maps/building.json");
const world = new World(JSON.parse(fs.readFileSync(mapFile)));
const mapRel = path.relative(path.join(here, "../.."), path.resolve(mapFile));
// HELDOUT_LIMIT=n evaluates the first n scenarios (behaviors rotate, so
// multiples of 4 stay balanced); TRAIN_EPISODES=n shortens training.
const heldout = JSON.parse(fs.readFileSync(process.env.HELDOUT || path.join(here, "../../scenarios/heldout.json"))).scenarios.slice(0, Number(process.env.HELDOUT_LIMIT) || undefined);
const nTrain = Number(process.env.TRAIN_EPISODES) || TRAINING_EPISODES;
const url = process.env.SIM_URL;
const client = new ModelClient({ endpoint: url ? `${url}/api/chat` : "/api/chat", enabled: !!url });
// HARNESS=<key> sets the defender's harness for training, rematch and evaluation.
const arena = new Arena(world, heldout, client, { defenderHarness: process.env.HARNESS || "raw" });
arena.mapFile = mapRel;
console.log("defender harness:", arena.defenderHarness, "| map:", mapRel, "| held-out:", heldout.length);

const b = arena.runBaseline();
console.log(`baseline: ${b.summary.reached}/${b.summary.trials} reached`);
for (let i = 0; i < nTrain; i++) {
  const ep = await arena.trainingEpisode();
  console.log(`T${ep.index} attack[${ep.attack.source}] ${ep.scenario.bird.strategy}@${ep.scenario.bird.ambush_node} from ${ep.scenario.bird.start} (witness ${ep.attack.solvability.witness.route_id}, rejected ${ep.attack.rejected.length}) | defender[${ep.defender.source}] ${ep.defender.invalid || ep.defender.policy.route_id} -> ${ep.summary.reached}/${ep.summary.trials} | guessed ${ep.belief?.guess ?? "-"} (actual ${ep.scenario.bird.strategy}${ep.belief ? `, ${ep.belief.familyCorrect ? "family ok" : "family wrong"}, danger err ${ep.belief.dangerError ?? "-"} m` : ""})${ep.defender.error ? ` ERROR ${ep.defender.error}` : ""}${ep.attack.error ? ` ATTACK-ERROR ${ep.attack.error}` : ""}\n     defender: ${ep.defender.policy.rationale || ""}\n     attacker: ${ep.scenario.bird.rationale || ""}`);
}
const st = await arena.freezeStrategy();
console.log(`strategy[${st.source}]: ${st.text}`);
const rm = await arena.runRematch();
console.log(`rematch of T${rm.before.index}: before ${rm.before.summary.reached}/${rm.before.summary.trials} -> after ${rm.after.summary.reached}/${rm.after.summary.trials} (${rm.after.defender.invalid || rm.after.defender.policy.route_id}, guessed ${rm.after.belief?.guess ?? "-"} vs ${rm.after.scenario.bird.strategy})`);
// EVAL_CONCURRENCY=n limits model calls in flight (default 8); lower it when the upstream is rate-limiting.
const ev = await arena.evaluate((d, n) => process.stdout.write(`\reval ${d}/${n}`), { concurrency: Number(process.env.EVAL_CONCURRENCY) || 8 });
console.log();
for (const [k, m] of Object.entries(ev.metrics)) console.log(k.padEnd(9), `success ${(m.successRate * 100).toFixed(0)}%  collisions ${(m.collisionRate * 100).toFixed(0)}%  efficiency ${m.pathEfficiency?.toFixed(2)}  invalid ${m.invalidActions}  solved ${m.scenariosSolved}/${m.scenarios ?? heldout.length}  behavior ${m.behaviorAccuracy === null ? "-" : (m.behaviorAccuracy * 100).toFixed(0) + "%"}  family ${m.familyAccuracy === null ? "-" : (m.familyAccuracy * 100).toFixed(0) + "%"}  danger err ${m.meanDangerError ?? "-"} m`);
console.log("quiz", JSON.stringify(Object.fromEntries(Object.entries(ev.quiz.results).map(([k, v]) => [k, v.accuracy ?? v.skipped ?? v.error]))), "collide share", ev.quiz.collideShare);
console.log("ledger", ev.ledger);
if (process.env.SAVE_TO) {
  fs.writeFileSync(process.env.SAVE_TO, JSON.stringify(arena.exportSession({ includeFrames: false })));
  console.log("wrote", process.env.SAVE_TO);
}
if (url) {
  const r = await fetch(`${url}/api/save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(arena.exportSession({ includeFrames: false })) });
  console.log("saved:", (await r.json()).dir, "(load session.json in the browser with Load recording)");
}
