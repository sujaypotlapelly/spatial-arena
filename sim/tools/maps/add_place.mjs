#!/usr/bin/env node
// Add a place to the arena from a short description: its size and its walls.
//
//   node sim/tools/maps/add_place.mjs sim/scenes/places/warehouse.json            # build, check, register
//   node sim/tools/maps/add_place.mjs sim/scenes/places/warehouse.json --dry-run  # build and check only
//
// The description is a JSON file:
//   { "id": "warehouse",                       lower-case name used with --map
//     "name": "Example warehouse",
//     "scene": "The building is a warehouse: ...",   one or two sentences the model is told about the place
//     "size": [48, 6, 36],                     metres: east-west, height, north-south. The floor is y = 0.
//     "walls": [ { "min": [x, y, z], "max": [x, y, z] }, ... ],   solid boxes
//     "routes": { "train": 12, "dev": 24, "test": 24 } }          optional; how many routes per set
//
// What this does:
//  1. Builds a waypoint graph in the free space (points with clearance, joined
//     where a tube between them is clear). The graph is only used to make
//     routes, for the planner upper bound and to measure progress. Pilots
//     under test never see it.
//  2. Makes the route sets by the same rule as every other place: start and
//     goal 15-35 m apart, out of each other's sight, needing a detour.
//  3. Flies the three scripted pilots on the development routes and refuses to
//     register the place if it is not a fair test: the planner must reach
//     nearly everything, and flying straight at the goal must not.
//  4. Writes sim/maps/<id>.json and the manifest sim/environments/<id>.json,
//     then regenerates sim/scenes/benchmark-sets.json, so --map <id> works
//     everywhere. Then run sim/tools/env/admit.mjs <id> for its report card.
//
// For a place built from a 3D scan, see build_splat_map.mjs in this folder.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { World, v } from "../../src/world.js";
import { Reach, makeReachSets } from "../../src/gym/reach.js";
import { runEpisode, replayEpisode } from "../../src/gym/core.js";
import { plannerReach, straightReach, reactiveReach } from "../../src/gym/reach_agents.js";
import { loadManifests, buildRegistries, writeJson, envFile, emptyAdmission, SCHEMA_VERSION } from "../env/manifests.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const SETS_FILE = path.join(root, "sim/scenes/benchmark-sets.json");
// Every place uses the same drone and wind, copied from the factory map.
const physics = () => JSON.parse(fs.readFileSync(path.join(root, "sim/maps/factory-full.json"), "utf8")).physics;

const isVec = (p) => Array.isArray(p) && p.length === 3 && p.every((x) => Number.isFinite(x));

export function checkDescription(d) {
  const bad = (m) => { throw new Error(`place description: ${m}`); };
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(d.id ?? "")) bad('"id" must be lower-case letters, digits and dashes, starting with a letter');
  if (typeof d.name !== "string" || !d.name.trim()) bad('"name" is missing');
  if (typeof d.scene !== "string" || d.scene.trim().length < 20) bad('"scene" must be a sentence or two describing the place to the model');
  if (!isVec(d.size) || d.size.some((x) => x <= 0)) bad('"size" must be [east-west, height, north-south] in metres');
  if (d.size[1] < 2.5) bad("the place must be at least 2.5 m high");
  if (!Array.isArray(d.walls) || !d.walls.length) bad('"walls" must list at least one box');
  d.walls.forEach((w, i) => {
    if (!isVec(w.min) || !isVec(w.max) || w.min.some((x, k) => x >= w.max[k])) bad(`walls[${i}] needs "min" and "max" corners with min below max on every axis`);
  });
}

// Build the map object (same format as sim/maps/building.json) from a description.
export function buildPlaceMap(d, { waypoints = 140, clearance = 0.8, edgeRadius = 0.45, maxEdge = 12 } = {}) {
  checkDescription(d);
  const [X, H, Z] = d.size;
  const base = {
    name: d.name,
    notes: `Built by sim/tools/maps/add_place.mjs from a description of ${d.walls.length} walls. The waypoint graph is generated; pilots under test never see it.`,
    bounds: { min: [0, 0, 0], max: [X, H, Z] },
    goalRadius: 1,
    routeTags: {},
    physics: physics(),
    boxes: d.walls.map((w, i) => ({ id: w.id ?? `wall-${i + 1}`, kind: "wall", min: w.min, max: w.max })),
  };
  const bare = new World({ ...base, waypoints: {}, edges: [] });

  // Candidate points: a 1 m lattice at one or two flying heights, with clearance.
  const heights = H >= 5.5 ? [1.6, Math.min(H - 1.5, 3.8)] : [Math.min(1.6, H / 2)];
  const cand = [];
  for (const y of heights) for (let x = 1; x < X; x += 1) for (let z = 1; z < Z; z += 1) {
    const p = [x, y, z];
    if (!bare.sphereHits(p, clearance)) cand.push(p);
  }
  if (cand.length < 30) throw new Error(`only ${cand.length} open points with ${clearance} m clearance: the place is too small or too full`);

  // Farthest-point sampling spreads the waypoints evenly through the free space.
  const chosen = [cand[0]];
  const minD = cand.map((p) => v.dist(p, cand[0]));
  while (chosen.length < Math.min(waypoints, cand.length)) {
    let bi = 0;
    for (let k = 1; k < cand.length; k++) if (minD[k] > minD[bi]) bi = k;
    if (minD[bi] <= 0) break;
    chosen.push(cand[bi]);
    for (let k = 0; k < cand.length; k++) minD[k] = Math.min(minD[k], v.dist(cand[k], cand[bi]));
  }

  // Join waypoints whose connecting tube is clear, then drop an edge when a
  // two-step path through a third waypoint is nearly as short.
  let edges = [];
  for (let i = 0; i < chosen.length; i++) for (let j = i + 1; j < chosen.length; j++) {
    const L = v.dist(chosen[i], chosen[j]);
    if (L <= maxEdge && bare.segmentClear(chosen[i], chosen[j], edgeRadius)) edges.push([i, j, L]);
  }
  const key = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const has = new Set(edges.map(([a, b]) => key(a, b)));
  edges = edges.filter(([a, b, L]) => {
    for (let c = 0; c < chosen.length; c++) {
      if (c === a || c === b || !has.has(key(a, c)) || !has.has(key(c, b))) continue;
      if (v.dist(chosen[a], chosen[c]) + v.dist(chosen[c], chosen[b]) <= 1.12 * L) return false;
    }
    return true;
  });

  // Keep the largest connected part.
  const adj = chosen.map(() => []);
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
  const comp = new Array(chosen.length).fill(-1);
  let best = { id: -1, size: 0 };
  for (let s = 0; s < chosen.length; s++) {
    if (comp[s] >= 0) continue;
    const stack = [s];
    comp[s] = s;
    let size = 0;
    while (stack.length) { const u = stack.pop(); size++; for (const w of adj[u]) if (comp[w] < 0) { comp[w] = s; stack.push(w); } }
    if (size > best.size) best = { id: s, size };
  }
  const kept = chosen.map((p, i) => ({ p, i })).filter(({ i }) => comp[i] === best.id);
  if (kept.length < 20) throw new Error(`the open space is split into small pieces (largest has ${kept.length} waypoints): check that doorways are at least 1.2 m wide`);

  // Names: the two waypoints farthest apart are start and goal; one near the middle is the perch.
  let far = [kept[0].i, kept[1].i, -1];
  for (const a of kept) for (const b of kept) {
    const L = v.dist(a.p, b.p);
    if (L > far[2]) far = [a.i, b.i, L];
  }
  const mid = v.lerp(chosen[far[0]], chosen[far[1]], 0.5);
  const perch = kept.filter(({ i }) => i !== far[0] && i !== far[1]).sort((a, b) => v.dist(a.p, mid) - v.dist(b.p, mid))[0].i;
  const names = {};
  let n = 0;
  for (const { i } of kept) names[i] = i === far[0] ? "start" : i === far[1] ? "goal" : i === perch ? "perch" : `w${++n}`;
  return {
    ...base,
    start: "start",
    goal: "goal",
    birdStart: "perch",
    waypoints: Object.fromEntries(kept.map(({ p, i }) => [names[i], p])),
    edges: edges.filter(([a, b]) => names[a] && names[b]).map(([a, b]) => [names[a], names[b]]),
  };
}

// The registry entry for a place. The route seed comes from the id, so the
// same description always gives the same routes.
export function placeEntry(d) {
  const seed = crypto.createHash("sha256").update(`place:${d.id}`).digest().readUInt32BE(0) % 1_000_000_000;
  const r = d.routes ?? {};
  return {
    map: `sim/maps/${d.id}.json`,
    scenarioFile: `sim/scenarios/reach-${d.id}.json`,
    reach: { train: r.train ?? 12, dev: r.dev ?? 24, heldout: 0, test: r.test ?? 24, seed, idPrefix: `${d.id}-`, windOffset: (seed % 900) * 1000 },
    scene: d.scene.trim(),
    routeText: "Routes are 15-35 m long",
    units: "metres",
    addedBy: "sim/tools/maps/add_place.mjs",
  };
}

// Fly the scripted pilots on the development routes and judge the place.
export async function checkPlace(map, entry, { limit = 24, set = "dev" } = {}) {
  const world = new World(map);
  const sets = makeReachSets(world, entry.reach);
  const problems = [];
  for (const k of ["train", "dev", "test"]) {
    if (sets[k].length < entry.reach[k]) problems.push(`only ${sets[k].length} of ${entry.reach[k]} ${k} routes could be made (${sets.nCandidates} candidate pairs): add walls that block lines of sight, make the place larger, or ask for fewer routes`);
  }
  const routes = (sets[set] ?? []).slice(0, limit);
  const pilots = { planner: ["C1", plannerReach], straight: ["C2", straightReach], avoider: ["C3", reactiveReach] };
  const reached = {};
  let replays = 0, flights = 0;
  for (const [name, [level, make]] of Object.entries(pilots)) {
    let ok = 0;
    for (const sc of routes) {
      const ep = await runEpisode(new Reach(world, sc, sc.seeds[0], level), make(world, sc));
      const re = replayEpisode(new Reach(world, sc, sc.seeds[0], level), ep.decisions);
      flights++;
      if (JSON.stringify(re) === JSON.stringify(ep.result)) replays++;
      if (ep.result.outcome === "reached") ok++;
    }
    reached[name] = routes.length ? ok / routes.length : 0;
  }
  if (routes.length) {
    if (reached.planner < 0.9) problems.push(`the planner, which has the map, reaches only ${Math.round(reached.planner * 100)}% of routes: some routes are not flyable in 90 s (doorways too narrow, or routes too long)`);
    if (reached.straight > 0.5) problems.push(`flying straight at the goal reaches ${Math.round(reached.straight * 100)}% of routes: the place is too open to test anything`);
    if (replays !== flights) problems.push(`${flights - replays} of ${flights} flights did not replay exactly`);
  }
  return { sets, reached, replays, flights, problems, world };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file || args.includes("--help")) {
    console.log("usage: node sim/tools/maps/add_place.mjs <description.json> [--dry-run] [--replace]\nSee sim/scenes/places/warehouse.json for an example description.");
    process.exit(file ? 0 : 2);
  }
  const d = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const registry = JSON.parse(fs.readFileSync(SETS_FILE, "utf8"));
  if (registry.environments[d.id] && !args.includes("--replace") && !args.includes("--dry-run")) throw new Error(`a place called "${d.id}" already exists; pass --replace to rebuild it`);

  const map = buildPlaceMap(d);
  const entry = placeEntry(d);
  console.log(`${d.name}: ${Object.keys(map.waypoints).length} waypoints, ${map.edges.length} edges`);
  const c = await checkPlace(map, entry);
  const pct = (x) => `${Math.round(x * 100)}%`;
  console.log(`routes: ${c.sets.train.length} practice, ${c.sets.dev.length} development, ${c.sets.test.length} test (from ${c.sets.nCandidates} candidate pairs)`);
  console.log(`scripted pilots on the development routes: planner with the map ${pct(c.reached.planner)}, avoider ${pct(c.reached.avoider)}, straight at the goal ${pct(c.reached.straight)}; ${c.replays}/${c.flights} flights replay exactly`);
  if (c.problems.length) {
    console.error(`\nNot registered:\n  - ${c.problems.join("\n  - ")}`);
    process.exit(1);
  }
  if (args.includes("--dry-run")) { console.log("Dry run: the place is a fair test. Nothing written."); return; }

  fs.writeFileSync(path.join(root, entry.map), JSON.stringify(map, null, 1) + "\n");
  const { nCandidates, ...sets } = c.sets;
  fs.writeFileSync(path.join(root, entry.scenarioFile), JSON.stringify({ note: `Reach scenario sets (${d.id}). Generated by makeReachSets in sim/src/gym/reach.js from ${entry.map} with ${JSON.stringify(entry.reach)}; tools regenerate and check them.`, ...sets, nCandidates }, null, 1));
  // The manifest is the source of truth; the registry is regenerated from it.
  const m = loadManifests();
  const old = m.envs.find((e) => e.id === d.id);
  writeJson(envFile(d.id), {
    schemaVersion: SCHEMA_VERSION, id: d.id, kind: "boxes", scene: null, mapBuild: null, videoOnly: false,
    harness: entry, admission: emptyAdmission(),
    registryOrder: old ? old.registryOrder : Math.max(-1, ...m.envs.map((e) => e.registryOrder)) + 1,
  });
  fs.writeFileSync(SETS_FILE, JSON.stringify(buildRegistries(loadManifests()).sets, null, 2) + "\n");
  console.log(`\nRegistered "${d.id}". Try it:\n  node sim/tools/bench.mjs --map ${d.id} --baselines --set dev --out runs/bench/${d.id}\n  node sim/tools/bench_report.mjs runs/bench/${d.id}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
