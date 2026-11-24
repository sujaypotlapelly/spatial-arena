// Audit: re-fly every recorded Reach episode from its recorded commands with
// the current code and check the outcome, time, contacts and end position
// match exactly. Each run directory's summary.json names its map (factory or
// building); routes are regenerated with makeReachSets, as reach_eval does.
//   node sim/tools/reach_verify.mjs runs/reach/v3test-* runs/reach/v3bldg-*
// Exits non-zero if any episode fails to replay exactly.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../src/world.js";
import { Reach, makeReachSets } from "../src/gym/reach.js";
import { replayEpisode } from "../src/gym/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// Older summaries name the factory by its file ("factory-full").
const MAPS = { factory: "factory-full.json", "factory-full": "factory-full.json", building: "building.json" };
const cache = {};
function load(mapName) {
  if (cache[mapName]) return cache[mapName];
  if (!MAPS[mapName]) throw new Error(`unknown map ${mapName}`);
  const world = new World(JSON.parse(fs.readFileSync(path.join(here, "../maps", MAPS[mapName]))));
  const sets = mapName !== "building" ? makeReachSets(world) : makeReachSets(world, { train: 0, dev: 0, heldout: 0, test: 40 });
  const scen = Object.fromEntries(["train", "dev", "heldout", "test"].flatMap((k) => sets[k] || []).map((s) => [s.id, s]));
  return (cache[mapName] = { world, scen });
}

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("usage: node sim/tools/reach_verify.mjs <run dir> [<run dir> ...]");
  process.exit(2);
}
let total = 0, ok = 0, skipped = 0;
for (const dir of dirs) {
  const f = path.join(dir, "episodes.jsonl");
  if (!fs.existsSync(f)) { skipped++; continue; }
  const summaryFile = path.join(dir, "summary.json");
  const mapName = (fs.existsSync(summaryFile) && JSON.parse(fs.readFileSync(summaryFile)).map) || "factory";
  const { world, scen } = load(mapName);
  let n = 0, k = 0;
  for (const line of fs.readFileSync(f, "utf8").trim().split("\n")) {
    if (!line) continue;
    const e = JSON.parse(line);
    n++;
    const sc = scen[e.scenario];
    if (!sc) { console.log(`  unknown route ${e.scenario} on ${mapName} in ${dir}`); continue; }
    const re = replayEpisode(new Reach(world, sc, e.seed, e.level), e.decisionLog, { dt: e.dt || 1 });
    if (JSON.stringify(re) === JSON.stringify(e.result)) k++;
    else console.log(`  mismatch ${dir} ${e.condition} ${e.scenario}: recorded ${e.result.outcome} ${e.result.time}s, replay ${re.outcome} ${re.time}s`);
  }
  console.log(`${dir} (${mapName}): ${k}/${n} exact`);
  total += n;
  ok += k;
}
console.log(`ALL: ${ok}/${total} exact${skipped ? ` (${skipped} directories without episodes.jsonl skipped)` : ""}`);
if (ok !== total) process.exitCode = 1;
