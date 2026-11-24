// Controlled probe sets: hold a scenario fixed, change one factor, and see
// whether Ripple's decision changes with it.
//
//   behavior  same start, goal, bird start and bird settings; only the hidden
//             behavior varies (pursue / intercept / ambush / patrol).
//             Does Ripple's guess track the truth? Does its plan change?
//   position  same start, goal and behavior (ambush); only the bird's
//             waiting point varies, each one sitting on a different route.
//             Does Ripple route away from where the bird is?
//
// Every scenario must be solvable (checkSolvable). The `probe` field is
// metadata for analysis; the model never sees it (defenderState only sends
// positions, bird observations and the route menu).
//   node sim/tools/legacy/make_probes.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World, routeMenu, v } from "../../src/world.js";
import { allowedBirdNodes } from "../../src/policy.js";
import { checkSolvable, runEpisode } from "../../src/scenarios.js";
import { rng } from "../../src/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const world = new World(JSON.parse(fs.readFileSync(path.join(here, "../../maps/building.json"))));
const N = world.nodes;
const BEHAVIORS = ["pursue", "intercept", "ambush", "patrol"];
const CTRL = { cruise_speed: 4.2, corner_slowdown: 0.6, avoidance_distance: 6, evade_strength: 0.6, replan_when_bird_nearby: true };
// Start/goal pairs from make_heldout.mjs (distinct ones only).
const PAIRS = [
  ["start", "goal"], ["exit_out", "f2_north"], ["east_lo", "f2_sw"], ["f2_north", "west_s"], ["window_in", "hall_n"],
  ["hall_s", "stair_hi"], ["f2_door_s", "exit_in"], ["west_n", "f2_door_s"], ["exit_out", "f2_ne"], ["stair_lo", "f2_sw"],
  ["west_s", "goal"], ["door_n", "f2_s"], ["exit_in", "f2_ne"], ["hall_ne", "window_in"], ["f2_sw", "exit_out"], ["east_lo", "f2_north"],
  ["start", "f2_ne"], ["stair_lo", "exit_in"], ["window_in", "west_n"], ["f2_north", "east_lo"], ["exit_out", "goal"], ["hall_s", "f2_door_s"],
];
const R = rng(777);
const pick = (a) => a[Math.floor(R.next() * a.length)];
const solvable = (sc) => checkSolvable(world, sc).solvable;
// Reached-of-4 for every route on the menu with one fixed controller.
const routeTable = (sc) => Object.fromEntries(routeMenu(world, sc.start, sc.goal).map((r) => [r.id, runEpisode(world, sc, { ...CTRL, route: r.route, route_id: r.id }, { keepFrames: false }).summary.reached]));
// Distance from a point to a route's polyline (closest segment).
function routeDist(route, p) {
  let best = Infinity;
  for (let i = 0; i + 1 < route.length; i++) {
    const a = N[route[i]], b = N[route[i + 1]];
    const ab = v.sub(b, a), t = Math.max(0, Math.min(1, v.dot(v.sub(p, a), ab) / Math.max(1e-9, v.dot(ab, ab))));
    best = Math.min(best, v.dist(p, v.add(a, v.scale(ab, t))));
  }
  return best;
}

// ---- behavior probe: 12 bases x 4 behaviors ----
const behavior = [];
let b = 0;
for (const [start, goal] of PAIRS) {
  if (b >= 12) break;
  const allowed = allowedBirdNodes(world, { start, goal });
  let chosen = null, fallback = null;
  for (let attempt = 0; attempt < 40 && !chosen; attempt++) {
    const bird0 = { start: pick(allowed), ambush_node: pick(allowed), speed: Math.round((3.8 + R.next() * 0.8) * 10) / 10, lead_time: 1.0, trigger_distance: 12 };
    if (bird0.ambush_node === bird0.start) continue;
    const seeds = [0, 1, 2, 3].map((k) => 31000 + b * 10 + k);
    const variants = BEHAVIORS.map((strategy) => ({
      start, goal, seeds,
      bird: { ...bird0, strategy, ...(strategy === "pursue" ? { lead_time: 0 } : {}), ...(strategy === "pursue" || strategy === "intercept" ? { ambush_node: bird0.start } : {}) },
    }));
    if (!variants.every(solvable)) continue;
    const tables = variants.map(routeTable);
    // Discriminating: no single route reaches >= 3/4 against every behavior.
    const ids = Object.keys(tables[0]);
    const discriminating = !ids.some((id) => tables.every((t) => t[id] >= 3));
    const rec = { variants, tables, discriminating };
    if (discriminating) chosen = rec;
    else fallback ||= rec;
  }
  const rec = chosen || fallback;
  if (!rec) continue;
  b++;
  rec.variants.forEach((sc, i) => behavior.push({ id: `B${b}${"abcd"[i]}`, ...sc, probe: { family: "behavior", base: `B${b}`, routeReached: rec.tables[i], discriminating: rec.discriminating } }));
  console.log(`B${b} ${start}->${goal} bird@${rec.variants[0].bird.start} amb@${rec.variants[2].bird.ambush_node} discriminating=${rec.discriminating}`, BEHAVIORS.map((x, i) => `${x}:${JSON.stringify(rec.tables[i])}`).join(" "));
}

// ---- position probe: 10 pairs x up to 4 bird positions (ambush) ----
const position = [];
let p = 0;
for (const [start, goal] of [...PAIRS].reverse()) {
  if (p >= 10) break;
  const menu = routeMenu(world, start, goal);
  if (menu.length < 3) continue;
  const allowed = allowedBirdNodes(world, { start, goal });
  // For each allowed node, which route it sits on (closest) and how exclusively.
  const cands = allowed
    .map((id) => {
      const d = menu.map((r) => routeDist(r.route, N[id]));
      const near = d.indexOf(Math.min(...d));
      const others = d.filter((_, i) => i !== near);
      return { id, near: menu[near].id, dNear: d[near], margin: Math.min(...others) - d[near] };
    })
    .filter((c) => c.dNear <= 3 && c.margin >= 3)
    .sort((x, y) => y.margin - x.margin);
  const seen = new Set();
  const picks = [];
  for (const c of cands) if (!seen.has(c.near) && picks.length < 4) (seen.add(c.near), picks.push(c));
  if (picks.length < 3) continue;
  const seeds = [0, 1, 2, 3].map((k) => 32000 + p * 10 + k);
  const variants = picks.map((c) => ({ start, goal, seeds, bird: { start: c.id, strategy: "ambush", ambush_node: c.id, speed: 4.4, lead_time: 1.0, trigger_distance: 12 }, c }));
  if (!variants.every(solvable)) continue;
  p++;
  variants.forEach(({ c, ...sc }, i) => position.push({ id: `P${p}${"abcd"[i]}`, ...sc, probe: { family: "position", base: `P${p}`, birdOnRoute: c.near, routeReached: routeTable(sc), routeDistToBird: Object.fromEntries(menu.map((r) => [r.id, Math.round(routeDist(r.route, N[c.id]) * 10) / 10])) } }));
  console.log(`P${p} ${start}->${goal} routes=${menu.length} bird on ${picks.map((c) => `${c.near}@${c.id}`).join(", ")}`);
}

const write = (name, scenarios, note) => {
  const out = path.join(here, `../scenarios/${name}.json`);
  fs.writeFileSync(out, JSON.stringify({ map: "maps/building.json", note, scenarios }, null, 1));
  console.log("wrote", out, scenarios.length, "scenarios");
};
write("probe-behavior", behavior, "Behavior probe: each base keeps start, goal, bird start and settings fixed; only the hidden behavior varies. Generated by tools/legacy/make_probes.mjs.");
write("probe-position", position, "Position probe: each base keeps start, goal and behavior (ambush) fixed; only the bird's waiting point varies, each on a different route. Generated by tools/legacy/make_probes.mjs.");
