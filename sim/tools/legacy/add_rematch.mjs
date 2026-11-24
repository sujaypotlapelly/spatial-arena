// Adds the rematch (first failed training episode re-flown with the frozen
// strategy) to a saved session that was recorded before rematches existed.
// One defender model call. Writes <session>.rematch.json next to it and
// saves a new run directory through the server.
//   SIM_URL=http://localhost:8766 node sim/tools/legacy/add_rematch.mjs runs/arena/<stamp>/session.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../../src/world.js";
import { Arena } from "../../src/arena.js";
import { ModelClient } from "../../src/agents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
const url = process.env.SIM_URL;
if (!file || !url) throw new Error("usage: SIM_URL=http://localhost:8766 node sim/tools/legacy/add_rematch.mjs <session.json>");
const world = new World(JSON.parse(fs.readFileSync(path.join(here, "../../maps/building.json"))));
const heldout = JSON.parse(fs.readFileSync(path.join(here, "../../scenarios/heldout.json"))).scenarios;
const data = JSON.parse(fs.readFileSync(file));
const arena = new Arena(world, heldout, new ModelClient({ endpoint: `${url}/api/chat`, enabled: true }));
const { checked, mismatched } = arena.importSession(data);
console.log(`re-simulated ${checked} episodes, ${mismatched} mismatched`);
if (data.usingModel === false) throw new Error("this session used the offline heuristic, not Ripple");
const rm = await arena.runRematch();
console.log(`rematch of T${rm.before.index}: before ${rm.before.summary.reached}/${rm.before.summary.trials} -> after ${rm.after.summary.reached}/${rm.after.summary.trials}`);
const out = { ...arena.exportSession({ includeFrames: false }), usingModel: true, ledger: data.ledger, exportedAt: data.exportedAt, rematchAddedAt: new Date().toISOString() };
const r = await fetch(`${url}/api/save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(out) });
console.log("saved:", (await r.json()).dir);
