// Runs the 12 held-out scenarios through every harness in parallel and
// prints a comparison. With SIM_URL it uses real Ripple through the server;
// without, the offline stand-in (for plumbing tests only).
//   SIM_URL=http://localhost:8766 node sim/tools/legacy/harness_eval.mjs [--session sim/recordings/ripple-training.json] [--only raw,tools]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../../src/world.js";
import { Arena } from "../../src/arena.js";
import { ModelClient, HARNESSES } from "../../src/agents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
// --map / MAP selects the map (default: the grey building).
const mapArg = process.argv.includes("--map") ? process.argv[process.argv.indexOf("--map") + 1] : process.env.MAP;
const mapFile = mapArg || path.join(here, "../../maps/building.json");
const world = new World(JSON.parse(fs.readFileSync(mapFile)));
const mapRel = path.relative(path.join(here, "../.."), path.resolve(mapFile));
const heldoutFile = opt("--heldout") || path.join(here, "../../scenarios/heldout.json");
const heldout = JSON.parse(fs.readFileSync(heldoutFile)).scenarios;
const url = process.env.SIM_URL;
const client = new ModelClient({ endpoint: url ? `${url}/api/chat` : "/api/chat", enabled: !!url });
const arena = new Arena(world, heldout, client);
arena.mapFile = mapRel;

// --session <training session.json>: import the training run (episodes,
// frozen strategy, rematch) so harness E can use the strategy and the saved
// recording holds the whole demo story plus this comparison.
const stratFile = opt("--session") || opt("--strategy");
if (stratFile) {
  const data = JSON.parse(fs.readFileSync(stratFile));
  if (!data.strategy?.text) throw new Error(`${stratFile} has no frozen strategy`);
  if (url && !data.usingModel) throw new Error(`${stratFile} came from the offline stand-in, not Ripple`);
  const { checked, mismatched } = arena.importSession(data);
  console.log(`imported ${stratFile}: re-simulated ${checked} episodes, ${mismatched} mismatched`);
}
const only = opt("--only")?.split(",");
const conditions = [{ key: "shortest", label: "Shortest-path comparator" }];
for (const h of Object.values(HARNESSES)) {
  if (only && !only.includes(h.key)) continue;
  if (h.useStrategy && !arena.strategy) continue;
  conditions.push({ key: h.key, label: h.label, harness: h.key, mode: h.useStrategy ? "strategy" : "original" });
}
console.log("conditions:", conditions.map((c) => c.key).join(", "));
const t0 = Date.now();
const ev = await arena.evaluate((d, n) => process.stdout.write(`\r${d}/${n} episodes (${Math.round((Date.now() - t0) / 1000)} s)`), {
  conditions,
  quiz: false,
  concurrency: Number(opt("--concurrency") || 12),
});
console.log();
const f = (x, p = false) => (x === null || x === undefined ? "  -  " : p ? `${Math.round(x * 100)}%`.padStart(5) : String(x).padStart(5));
console.log("harness                      success  solved  family  exact  danger_m  predict_m  invalid  tools/dec  latency_s  hosts");
for (const c of conditions) {
  const m = ev.metrics[c.key];
  console.log(`${m.label.padEnd(28)} ${f(m.successRate, true)}   ${String(m.scenariosSolved).padStart(2)}/${m.scenarios}   ${f(m.familyAccuracy, true)}  ${f(m.behaviorAccuracy, true)}   ${f(m.meanDangerError)}     ${f(m.meanPredictionError)}     ${String(m.invalidActions).padStart(3)}     ${f(m.toolCallsPerDecision)}      ${f(m.medianLatencyS)}   ${(m.hosts || []).join("/")}`);
}
const session = { ...arena.exportSession({ includeFrames: false }), kind: "harness-eval", strategySource: stratFile, heldoutFile, tag: opt("--tag") };
if (process.env.SAVE_TO) fs.writeFileSync(process.env.SAVE_TO, JSON.stringify(session));
if (url) {
  const r = await fetch(`${url}/api/save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(session) });
  console.log("saved:", (await r.json()).dir);
}
console.log("ledger", ev.ledger);
