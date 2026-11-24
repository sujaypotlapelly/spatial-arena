// Generates the 12 held-out evaluation scenarios (sim/scenarios/heldout.json).
// Different start/goal pairs and bird patterns from training; each must be
// solvable by a reference controller, and we prefer ones the shortest-path
// comparator does not already solve.
//   node sim/tools/legacy/make_heldout.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World, routeMenu } from "../../src/world.js";
import { rng } from "../../src/engine.js";
import { allowedBirdNodes, shortestPathPolicy } from "../../src/policy.js";
import { checkSolvable, runEpisode } from "../../src/scenarios.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAP = (() => { const a = process.argv.slice(2); return a.includes("--map") ? a[a.indexOf("--map") + 1] : path.join(here, "../../maps/building.json"); })();
const world = new World(JSON.parse(fs.readFileSync(MAP)));
const isBuilding = path.basename(MAP) === "building.json";
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const COUNT = Number(opt("--count", 12));
const OUT = opt("--out", path.join(here, "../../scenarios/heldout.json"));
const SEED_BASE = Number(opt("--seed-base", 9001));
const baseTasks = [
  ["start", "goal"], ["start", "goal"], ["start", "goal"],
  ["exit_out", "f2_north"], ["east_lo", "f2_sw"], ["f2_north", "west_s"], ["window_in", "hall_n"],
  ["hall_s", "stair_hi"], ["f2_door_s", "exit_in"], ["west_n", "f2_door_s"], ["exit_out", "f2_ne"], ["stair_lo", "f2_sw"],
];
// 12 is the original set; larger sets cycle through more start/goal pairs
// and rotate bird behaviors so each appears equally often.
const extraTasks = [
  ["west_s", "goal"], ["door_n", "f2_s"], ["exit_in", "f2_ne"], ["hall_ne", "window_in"], ["f2_sw", "exit_out"], ["east_lo", "f2_north"],
  ["start", "f2_ne"], ["stair_lo", "exit_in"], ["window_in", "west_n"], ["f2_north", "east_lo"], ["exit_out", "goal"], ["hall_s", "f2_door_s"],
];
// Scan maps: start/goal pairs far apart across the hall (>= 30 m), drawn
// deterministically from the waypoint graph.
const farPairs = () => {
  const ids = world.nodeIds.filter((id) => id !== world.map.birdStart);
  const Rp = rng(4242);
  const pairs = [];
  for (const a of ids) for (const b of ids) if (a < b && Math.hypot(world.nodes[a][0] - world.nodes[b][0], world.nodes[a][2] - world.nodes[b][2]) >= 30) pairs.push(Rp.next() < 0.5 ? [a, b] : [b, a]);
  for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(Rp.next() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
  return pairs;
};
// Scan maps: every far pair is a candidate; pairs with no solvable bird
// setup are skipped (slot numbering follows accepted scenarios, so maps
// where nothing is skipped produce the same file as before).
const tasks = !isBuilding ? farPairs() : COUNT <= 12 ? baseTasks.slice(0, COUNT) : Array.from({ length: COUNT }, (_, i) => [...baseTasks, ...extraTasks][i % (baseTasks.length + extraTasks.length)]);
const R = rng(COUNT <= 12 ? 20261113 : 20261113 + COUNT);
const pick = (a) => a[Math.floor(R.next() * a.length)];
const out = [];
for (const [start, goal] of tasks) {
  if (out.length >= COUNT) break;
  const i = out.length;
  const seeds = [0, 1, 2, 3].map((k) => SEED_BASE + i * 10 + k);
  let chosen = null;
  let fallback = null;
  for (let attempt = 0; attempt < 60 && !chosen; attempt++) {
    const base = { start, goal, seeds };
    const allowed = allowedBirdNodes(world, base);
    const forced = isBuilding && COUNT <= 12 ? ["ambush", "intercept", "patrol"][i] : ["pursue", "intercept", "ambush", "patrol"][i % 4];
    const strategy = forced || pick(["pursue", "intercept", "ambush", "patrol"]);
    const used = new Set(out.filter((o) => o.start === start && o.goal === goal).map((o) => o.bird.start));
    const bird = {
      start: pick(allowed.filter((n) => !used.has(n))),
      strategy,
      ambush_node: pick(allowed),
      speed: Math.round((3.6 + R.next() * 1.0) * 10) / 10,
      lead_time: strategy === "pursue" ? 0 : Math.round(R.next() * 15) / 10,
      trigger_distance: Math.round(8 + R.next() * 8),
    };
    if (strategy === "pursue" || strategy === "intercept") bird.ambush_node = bird.start;
    if (strategy === "patrol" && bird.ambush_node === bird.start) continue;
    const sc = { id: `H${i + 1}`, ...base, bird };
    const solv = checkSolvable(world, sc);
    if (!solv.solvable) continue;
    const sp = runEpisode(world, sc, shortestPathPolicy(world, sc), { keepFrames: false }).summary;
    const rec = { ...sc, witness: solv.witness, shortestPathReached: sp.reached };
    if (sp.reached <= 2) chosen = rec;
    else fallback = fallback || rec;
  }
  const sc = chosen || fallback;
  if (!sc && !isBuilding) {
    console.log(`skip ${start}->${goal}: no solvable bird setup`);
    continue;
  }
  if (!sc) throw new Error(`no solvable scenario for ${start}->${goal}`);
  console.log(sc.id, `${start}->${goal}`, sc.bird.strategy, `bird@${sc.bird.start}`, `amb@${sc.bird.ambush_node}`,
    `routes=${routeMenu(world, start, goal).length}`, `solvable via ${sc.witness.route_id} ${sc.witness.reached}/4`, `shortest-path ${sc.shortestPathReached}/4`);
  out.push(sc);
}
if (out.length < COUNT) throw new Error(`only ${out.length} of ${COUNT} scenarios are solvable`);
fs.writeFileSync(OUT, JSON.stringify({ map: path.relative(path.join(here, "../.."), MAP), note: `Held-out evaluation scenarios (${out.length}). Never shown to the model during adaptation. Generated by tools/legacy/make_heldout.mjs.`, scenarios: out }, null, 2));
console.log("wrote", OUT);
