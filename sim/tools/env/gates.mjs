// Admission gates for docs/CONTRIBUTING_ENVIRONMENTS.md, stages 0-2.
// Each gate returns { id, stage, title, status, detail, value? } where status is
// "pass", "fail", "waived" (a person accepted a failure, with a reason recorded
// in the manifest's admission.signoffs), or "not-checked" (the data to check it
// is missing on this machine). Only "pass" and "waived" let a stage pass.
import fs from "node:fs";
import path from "node:path";
import { World } from "../../src/world.js";
import { SplatVoxels } from "../../src/splat_voxels.js";
import { makeReachSets } from "../../src/gym/reach.js";
import { makeMissionSets } from "../../src/gym/mission_sets.js";
import { RescueMission } from "../../src/gym/rescue_tasks.js";
import { runEpisode } from "../../src/gym/core.js";
import { oracleSearch, oracleDelivery } from "../../src/gym/mission_agents.js";
import { checkPlace } from "../maps/add_place.mjs";
import { missionSpotFilter } from "../benchmark_env.mjs";
import { root } from "./manifests.mjs";
import { readDensity, pointsNear } from "./scan_density.mjs";

// Criteria used in environment reports.
export const THRESHOLDS = {
  licences: ["CC BY 4.0", "CC0 1.0"],
  approvedReviews: /^(approved|existing-approved|approved-reserve|selected-for-.+)$/,
  alignment: 0.9,          // share of collider surface samples with scan points nearby
  coveredWaypoints: 0.9,   // share of the flight graph whose ground below was captured
  capturedRadius: 2.0,     // metres (map units) around a target or ground point
  capturedShare: 0.05,     // captured = at least this share of the scan's median point count around its own captured cells
  capturedFloor: 5,        // ...and never fewer than this many points
  plannerMin: 0.9,         // the planner, which has the map, reaches at least this share
  straightMax: 0.5,        // flying straight at the goal reaches at most this share
  passageMin: 0.75,        // narrowest gap on the flight graph, metres: 1.5x the drone's 0.5 m width (1.0 rejected every trusted map, whose build guarantees 0.9)
  oracleMissions: 4,       // dev missions the privileged oracle must complete
};

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
const gate = (stage, id, title, ok, detail, value) => ({ stage, id, title, status: ok ? "pass" : "fail", detail, ...(value !== undefined ? { value } : {}) });
const notChecked = (stage, id, title, detail) => ({ stage, id, title, status: "not-checked", detail });
const pct = (x) => `${Math.round(x * 1000) / 10}%`;

// Report license and scale separately from geometry and flight checks.
export const INFO_ONLY = new Set(["licence", "scale"]);
export const infoOnly = (gates) => gates.map((g) => (INFO_ONLY.has(g.id) && g.status !== "pass" ? { ...g, status: "info", detail: `${g.detail} (Shown for information; not enforced.)` } : g));

// Apply waivers recorded by a person: admission.signoffs[gateId] = { by, date, reason }.
export function applyWaivers(gates, signoffs = {}) {
  return gates.map((g) => (g.status !== "pass" && signoffs[g.id]?.waive ? { ...g, status: "waived", detail: `${g.detail} Waived by ${signoffs[g.id].by} (${signoffs[g.id].date}): ${signoffs[g.id].reason}` } : g));
}

// ---------------------------------------------------------------- stage 0
export function stage0({ env, scene }) {
  if (env.kind === "boxes") {
    return [gate(0, "licence", "Licence allows reuse", true, "Built in this repo from a box description; covered by the repo's own licence.")];
  }
  const src = scene.registry.source ?? {};
  const out = [];
  const cacheDir = scene.registry.assets?.cacheDirectory ?? `cache/splat-scenes/${scene.id}`;
  const provFile = path.join(root, cacheDir, "provenance.json");
  const prov = fs.existsSync(provFile) ? JSON.parse(fs.readFileSync(provFile, "utf8")) : null;
  if (!src.license) out.push(gate(0, "licence", "Licence allows reuse", false, src.licenseNote ?? "No licence is recorded for this scene."));
  else if (!THRESHOLDS.licences.includes(src.license)) out.push(gate(0, "licence", "Licence allows reuse", false, `“${src.license}” is not on the allowed list (${THRESHOLDS.licences.join(", ")}).`));
  else if (!prov) out.push({ ...notChecked(0, "licence", "Licence allows reuse", `The registry says ${src.license}, but the owner metadata cached by cache_splat_scene.mjs (${path.relative(root, provFile)}) isn't on this machine.`) });
  else {
    const same = prov.license === src.license && prov.sceneUrl === src.sceneUrl;
    out.push(gate(0, "licence", "Licence allows reuse", same, same
      ? `${src.license}, matching the owner metadata retrieved ${String(prov.retrievedAt ?? prov.checkedAt ?? "").slice(0, 10)} from ${src.sceneUrl}.`
      : `Registry says ${src.license} at ${src.sceneUrl}; cached owner metadata says ${prov.license} at ${prov.sceneUrl}.`, src.license));
  }
  out.push(gate(0, "attribution", "Attribution recorded", Boolean(src.attribution), src.attribution ?? "No attribution string."));
  const decision = scene.registry.reviewDecision ?? "";
  out.push(gate(0, "review", "A person approved the look and the use", THRESHOLDS.approvedReviews.test(decision), `Review decision “${decision || "none"}”${scene.registry.reviewNote ? `: ${scene.registry.reviewNote}` : "."}`));
  return out;
}

// ---------------------------------------------------------------- helpers
export function loadWorld(env) {
  const file = path.join(root, env.harness.map);
  if (!fs.existsSync(file)) throw new Error(`${env.harness.map} is missing`);
  return new World(JSON.parse(fs.readFileSync(file, "utf8")));
}

// Map point -> collider source frame, with the exact transform build_splat_map.mjs used.
export function sourceMapper({ env, scene, map }) {
  if (env.kind !== "scan" || !map) return null;
  const dir = path.join(root, scene.registry.assets?.cacheDirectory ?? `cache/splat-scenes/${scene.id}`);
  const metaF = path.join(dir, "scene.voxel.json"), binF = path.join(dir, "scene.voxel.bin");
  if (!fs.existsSync(metaF) || !fs.existsSync(binF)) return null;
  const t = scene.registry.transform.collision;
  const transform = { ...t, scale: (t.scale ?? 1) * (map.build.scale ?? 1) };
  const vox = new SplatVoxels(JSON.parse(fs.readFileSync(metaF, "utf8")), fs.readFileSync(binF), { transform, validate: false });
  // A map cell is the scan's own collider if any collider voxel lies in it
  // (build_splat_map marks a cell solid on any overlap, so test the whole cell).
  const isCollider = (c, cell) => {
    const h = cell * 0.45, k = [-h, 0, h];
    for (const dx of k) for (const dy of k) for (const dz of k) if (vox.isOccupied([c[0] + dx, c[1] + dy, c[2] + dz])) return true;
    return false;
  };
  // The scan collider's own surface under p: search down from p for the first
  // collider voxel, up to `depth` metres. null = no scan surface there (sealed or
  // never captured). Map cells are conservative, so the map's ground can sit up
  // to a cell or two above the collider's surface.
  const surfaceBelow = (p, depth = 2.5, step = 0.1) => {
    for (let y = p[1]; y >= p[1] - depth; y -= step) if (vox.isOccupied([p[0], y, p[2]])) return [p[0], y + step, p[2]];
    return null;
  };
  return { toSource: (p) => vox.toSource(p), isCollider, surfaceBelow, scale: transform.scale };
}

// Clearance (distance to the nearest solid) at a point, by bisection on sphereHits.
function clearance(world, p, max = 1) {
  if (world.sphereHits(p, 0.001)) return 0;
  let lo = 0, hi = max;
  if (!world.sphereHits(p, hi)) return hi;
  for (let i = 0; i < 9; i++) { const mid = (lo + hi) / 2; if (world.sphereHits(p, mid)) hi = mid; else lo = mid; }
  return lo;
}

// Is p inside the topmost free interval of its grid column (open to the sky,
// or to the altitude fence)? Hollows under the real ground are not.
function skyFacing(world, p) {
  const { origin, cell, dims, occ } = world.grid;
  const [NX, NY] = dims;
  const ix = Math.floor((p[0] - origin[0]) / cell), iy = Math.floor((p[1] - origin[1]) / cell), iz = Math.floor((p[2] - origin[2]) / cell);
  const at = (x, y, z) => x + NX * (y + NY * z);
  let y = NY - 1;
  while (y >= 0 && occ[at(ix, y, iz)]) y--;          // skip the fence seal at the top
  while (y > 0 && !occ[at(ix, y - 1, iz)]) y--;      // down through the topmost free interval
  return iy >= y;
}

// How many scan points a captured spot of this scene typically has nearby: the
// median over the scan's own occupied cells. It belongs to the scene, not the
// map, so restricting a map to its best ground doesn't raise the bar. A few
// stray points floating in a hollow (v4 canyon: 0-6, against a median of 28)
// don't count as captured.
export function capturedModel(world, mapper, density) {
  const r = THRESHOLDS.capturedRadius / mapper.scale;
  if (density.reference?.r !== r) {
    const keys = [...density.counts.keys()];
    const step = Math.max(1, Math.floor(keys.length / 3000));
    const counts = [];
    for (let i = 0; i < keys.length; i += step) counts.push(pointsNear(density, keys[i].split(",").map((n) => (+n + 0.5) * density.cell), r));
    counts.sort((a, b) => a - b);
    density.reference = { r, median: counts.length ? counts[counts.length >> 1] : 0 };
  }
  const median = density.reference.median;
  const min = Math.max(THRESHOLDS.capturedFloor, Math.round(median * THRESHOLDS.capturedShare));
  // A point is captured when the scan's own surface lies within 2.5 m below it
  // and has at least `min` scan points around it.
  const captured = (p) => {
    const sp = mapper.surfaceBelow([p[0], p[1] + 0.5, p[2]]);
    return Boolean(sp) && pointsNear(density, mapper.toSource(sp), r) >= min;
  };
  return { median, min, captured, surfaceBelow: mapper.surfaceBelow };
}

// The first solid cell below p (the ground under a waypoint), or null.
function groundBelow(world, p) {
  const { origin, cell, dims, occ } = world.grid;
  const [NX, NY] = dims;
  const ix = Math.floor((p[0] - origin[0]) / cell), iz = Math.floor((p[2] - origin[2]) / cell);
  for (let iy = Math.floor((p[1] - origin[1]) / cell); iy >= 0; iy--) {
    if (occ[ix + NX * (iy + NY * iz)]) return [p[0], origin[1] + (iy + 1) * cell, p[2]];
  }
  return null;
}

// ---------------------------------------------------------------- stage 1
export function stage1(ctx) {
  const { env, scene } = ctx;
  const world = ctx.world ?? loadWorld(env);
  const out = [];
  const drone = world.physics?.droneRadius ?? 0.25;

  // Scale
  if (env.kind === "boxes") out.push(gate(1, "scale", "Scale measured against a reference", true, "Box places are written in metres."));
  else {
    const cal = scene.calibration;
    if (cal?.reference?.points?.length === 2 && cal.reference.metres > 0) {
      out.push(gate(1, "scale", "Scale measured against a reference", true, `${cal.reference.object}, ${cal.reference.metres} m, measured by ${cal.reference.by ?? "unknown"}.`, cal.scale));
    } else {
      const note = ctx.map?.build?.unitsNote ?? scene.registry.transform?.status ?? "No calibration recorded.";
      out.push(gate(1, "scale", "Scale measured against a reference", false, `Not measured. Recorded so far: ${note}`));
    }
  }

  // Narrowest gap on the flight graph
  let narrow = Infinity, at = null;
  for (const [a, b] of world.map.edges) {
    const A = world.nodes[a], B = world.nodes[b];
    const len = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
    const n = Math.max(2, Math.ceil(len / 0.5));
    for (let i = 0; i <= n; i++) {
      const p = [0, 1, 2].map((k) => A[k] + ((B[k] - A[k]) * i) / n);
      const c = clearance(world, p, 1);
      if (c < narrow) { narrow = c; at = p; }
    }
  }
  const width = 2 * narrow;
  out.push(gate(1, "passage", "Narrowest gap is at least twice the drone's width", width >= THRESHOLDS.passageMin,
    `Narrowest gap on the flight graph: ${width.toFixed(2)} m (the drone is ${(2 * drone).toFixed(2)} m wide) at [${at?.map((x) => x.toFixed(1)).join(", ")}].`, Math.round(width * 100) / 100));

  // Alignment and coverage need the scan's points.
  if (env.kind === "boxes") {
    out.push(gate(1, "alignment", "Collider matches the scan", true, "No scan: the box description is the geometry."));
    out.push(gate(1, "coverage", "The flight space was captured by the scan", true, "No scan: every space is defined."));
    return out;
  }
  const mapper = sourceMapper(ctx);
  const density = readDensity(scene.id);
  if (!mapper || !density) {
    const why = !mapper ? "the scene's collider isn't cached here (or the map isn't built from a SuperSplat collider)" : `no scan density for “${scene.id}”; run node sim/tools/env/scan_density.mjs ${scene.id}`;
    out.push(notChecked(1, "alignment", "Collider matches the scan", `Not checked: ${why}.`));
    out.push(notChecked(1, "coverage", "The flight space was captured by the scan", `Not checked: ${why}.`));
    return out;
  }
  ctx.mapper = mapper; ctx.density = density;
  const rSrc = (m) => m / mapper.scale;

  // Alignment: collider surface cells (solid with a free neighbour) should have scan points nearby.
  const { origin, cell, dims, occ } = world.grid;
  const [NX, NY, NZ] = dims;
  const idx = (x, y, z) => x + NX * (y + NY * z);
  const surface = [];
  for (let z = 1; z < NZ - 1; z += 2) for (let y = 1; y < NY - 1; y += 2) for (let x = 1; x < NX - 1; x += 2) {
    if (!occ[idx(x, y, z)]) continue;
    if (occ[idx(x + 1, y, z)] && occ[idx(x - 1, y, z)] && occ[idx(x, y + 1, z)] && occ[idx(x, y - 1, z)] && occ[idx(x, y, z + 1)] && occ[idx(x, y, z - 1)]) continue;
    const c = [origin[0] + (x + 0.5) * cell, origin[1] + (y + 0.5) * cell, origin[2] + (z + 0.5) * cell];
    if (!mapper.isCollider(c, cell)) continue; // altitude fence and sealed hollows are ours, not the scan's
    surface.push(c);
  }
  // Deterministic sample: every k-th surface cell.
  const step = Math.max(1, Math.floor(surface.length / 4000));
  let near = 0, n = 0;
  for (let i = 0; i < surface.length; i += step) { n++; if (pointsNear(density, mapper.toSource(surface[i]), rSrc(cell * 2)) > 0) near++; }
  const align = n ? near / n : 0;
  out.push(gate(1, "alignment", "Collider matches the scan", align >= THRESHOLDS.alignment,
    `${pct(align)} of ${n} sampled surface cells of the scan's own collider (the altitude fence and sealed hollows excluded) have scan points within ${(cell * 2).toFixed(2)} m (needs ${pct(THRESHOLDS.alignment)}).`, Math.round(align * 1000) / 1000));

  // Coverage: the ground under each waypoint should be real, captured scan ground.
  const cap = capturedModel(world, mapper, density);
  ctx.captured = cap;
  const wps = Object.values(world.nodes);
  let cov = 0, sealed = 0;
  for (const p of wps) {
    const gp = groundBelow(world, p);
    if (!gp) continue;
    if (!mapper.surfaceBelow([gp[0], gp[1] + 0.5, gp[2]])) { sealed++; continue; }
    if (cap.captured(gp)) cov++;
  }
  const covered = wps.length ? cov / wps.length : 0;
  out.push(gate(1, "coverage", "The flight space was captured by the scan", covered >= THRESHOLDS.coveredWaypoints,
    `${pct(covered)} of ${wps.length} waypoints have captured scan ground below them (needs ${pct(THRESHOLDS.coveredWaypoints)}). Captured means at least ${cap.min} scan points within ${THRESHOLDS.capturedRadius} m (5% of this scan's median, ${cap.median}). ${sealed} waypoints sit over ground with no scan surface within 2.5 m (ground we sealed).`, Math.round(covered * 1000) / 1000));
  return out;
}

// ---------------------------------------------------------------- stage 2
export async function stage2(ctx) {
  const { env } = ctx;
  const h = env.harness;
  const world = ctx.world ?? loadWorld(env);
  const out = [];
  out.push(gate(2, "scene-text", "The model is told what the place is", typeof h.scene === "string" && h.scene.length >= 20, h.scene ?? "No scene sentence."));

  // Route sets regenerate exactly and don't overlap.
  const sets = makeReachSets(world, h.reach ?? {});
  ctx.sets = sets;
  if (h.scenarioFile) {
    const pinned = readJson(h.scenarioFile);
    const diffs = ["train", "dev", "heldout", "test"].filter((k) => k in pinned && JSON.stringify(pinned[k]) !== JSON.stringify(sets[k]));
    const ids = ["train", "dev", "heldout", "test"].flatMap((k) => (sets[k] ?? []).map((s) => s.id));
    const disjoint = new Set(ids).size === ids.length;
    out.push(gate(2, "routes", "Route sets regenerate exactly and don't overlap", !diffs.length && disjoint,
      diffs.length ? `${h.scenarioFile}: ${diffs.join(", ")} differ from makeReachSets output.` : `${ids.length} routes (${["train", "dev", "heldout", "test"].map((k) => `${sets[k]?.length ?? 0} ${k}`).join(", ")}) match ${h.scenarioFile}${disjoint ? "" : "; some ids repeat"}.`));
  } else out.push(gate(2, "routes", "Route sets regenerate exactly and don't overlap", false, "No pinned scenario file, so a changed map could change the routes silently."));

  // Fairness: the same gate add_place.mjs applies to box places.
  // Fly the scripted pilots on the development routes, or the first set this
  // environment has (the v3 second building only has a test set).
  const fairSet = ["dev", "heldout", "test", "train"].find((k) => sets[k]?.length);
  const fair = await checkPlace(world.map, { reach: h.reach ?? {} }, { set: fairSet });
  const r = fair.reached;
  ctx.fairness = fair;
  out.push(gate(2, "planner", "The planner, which has the map, reaches nearly every route", r.planner >= THRESHOLDS.plannerMin, `${pct(r.planner)} of ${Math.min(24, sets[fairSet]?.length ?? 0)} ${fairSet ?? "development"} routes (needs ${pct(THRESHOLDS.plannerMin)}).`, r.planner));
  out.push(gate(2, "straight", "Flying straight at the goal fails most routes", r.straight <= THRESHOLDS.straightMax, `${pct(r.straight)} reached flying straight (at most ${pct(THRESHOLDS.straightMax)}).`, r.straight));
  out.push(gate(2, "between", "A simple reactive pilot lands between them", r.avoider > r.straight && r.avoider < r.planner, `Reactive avoider ${pct(r.avoider)}, between straight ${pct(r.straight)} and planner ${pct(r.planner)}.`, r.avoider));
  out.push(gate(2, "replay", "Every check flight replays exactly", fair.replays === fair.flights, `${fair.replays} of ${fair.flights} flights replay exactly.`));

  // Mission sets.
  const targets = [];
  for (const [task, cfg] of Object.entries(h.missions ?? {})) {
    const file = `sim/scenarios/mission-${env.id}-${task}.json`;
    if (!fs.existsSync(path.join(root, file))) { out.push(gate(2, `missions-${task}`, `${task} missions regenerate and are feasible`, false, `${file} is missing.`)); continue; }
    const pinned = readJson(file);
    const ms = makeMissionSets(world, task, { idPrefix: `${env.id}-${task}-`, ...cfg }, { spotFilter: missionSpotFilter(cfg) });
    const diffs = ["train", "dev", "test"].filter((k) => JSON.stringify(ms[k]) !== JSON.stringify(pinned[k]));
    const all = ["train", "dev", "test"].flatMap((k) => ms[k]);
    const unique = new Set(all.map((m) => m.targetPosition.join(","))).size === all.length;
    let oracleOk = 0;
    const tried = ms.dev.slice(0, THRESHOLDS.oracleMissions);
    for (const m of tried) {
      const ep = await runEpisode(new RescueMission(world, m, m.seeds[0]), task === "search" ? oracleSearch(world, m) : oracleDelivery(world, m));
      if (["found", "delivered", "misdelivered"].includes(ep.result.outcome)) oracleOk++;
    }
    out.push(gate(2, `missions-${task}`, `${task[0].toUpperCase() + task.slice(1)} missions regenerate and are feasible`, !diffs.length && unique && oracleOk === tried.length,
      `${diffs.length ? `${diffs.join(", ")} differ from ${file}. ` : `Sets match ${file}. `}${unique ? "Each target used once." : "Targets repeat."} Oracle completed ${oracleOk} of ${tried.length} development missions.`));
    for (const m of all) targets.push({ task, id: m.id, p: m.targetPosition });
  }
  ctx.targets = targets;

  // Targets on captured, sky-facing ground (scanned outdoor maps).
  if (env.kind === "scan" && ctx.map && targets.length) {
    const mapper = ctx.mapper ?? sourceMapper(ctx), density = ctx.density ?? readDensity(ctx.scene.id);
    if (mapper && density) {
      const cap = ctx.captured ?? capturedModel(world, mapper, density);
      const bad = targets.filter((t) => !cap.captured(t.p));
      for (const t of targets) t.captured = !bad.includes(t);
      out.push(gate(2, "targets-captured", "Every mission target sits in captured space", !bad.length,
        `${targets.length - bad.length} of ${targets.length} targets have at least ${cap.min} scan points within ${THRESHOLDS.capturedRadius} m (5% of this scan's median, ${cap.median}).${bad.length ? ` Uncaptured: ${bad.slice(0, 6).map((t) => t.id).join(", ")}${bad.length > 6 ? ` and ${bad.length - 6} more` : ""}.` : ""}`, bad.length));
    } else out.push(notChecked(2, "targets-captured", "Every mission target sits in captured space", "Needs the scan density and cached collider (stage 1)."));
    const under = targets.filter((t) => !skyFacing(world, t.p));
    for (const t of targets) t.sky = !under.includes(t);
    out.push(gate(2, "targets-sky", "Every outdoor target is open to the sky", !under.length,
      `${targets.length - under.length} of ${targets.length} targets are in their column's topmost free space.${under.length ? ` Under a roof, canopy or the ground: ${under.slice(0, 6).map((t) => t.id).join(", ")}${under.length > 6 ? ` and ${under.length - 6} more` : ""}.` : ""}`, under.length));
  }
  return out;
}
