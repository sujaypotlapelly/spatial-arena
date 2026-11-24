#!/usr/bin/env node
// Add a SuperSplat scene to the arena, end to end, and check it against the
// admission gates (docs/CONTRIBUTING_ENVIRONMENTS.md):
//
//   node sim/tools/env/add_scene.mjs --hash fb6b9fae --id verzasca \
//     --search "Verzasca River" --describe "alpine river valley: a stone footbridge ..."
//
//  1. Owner metadata from the public PlayCanvas explore API: downloads must be
//     enabled by the owner with a CC BY licence, and the scene needs a
//     published collider. The record is kept as provenance.
//  2. The collider (scene.voxel.json/.bin) and the streamed splat files are
//     cached under cache/splat-scenes/<id>/ (large files stay out of git).
//  3. A scene manifest (sim/environments/scenes/<id>.json) with review
//     "pending": a person still approves the look and the use.
//  4. Scan density, then a map: crop from the collider, cell size chosen to
//     keep the grid small, an 8 m altitude band, hollows sealed, and a launch
//     point found automatically on captured, open-sky ground near the centre.
//  5. A flight volume over captured ground (suggest_volume.mjs) and the map
//     rebuilt inside it, with a target mask for missions.
//  6. Route and search sets with fresh seeds, pinned; then admit.mjs.
// Every step is an existing tool; this script only chains them and fills in
// the parameters a person used to choose by hand.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { root, loadManifests, writeJson, sceneFile, envFile, DIR, SCHEMA_VERSION, emptyAdmission } from "./manifests.mjs";
import { SplatVoxels } from "../../src/splat_voxels.js";
import { readDensity, pointsNear } from "./scan_density.mjs";
import { cacheStreamedScene } from "../maps/cache_splat_scene.mjs";

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const HASH = opt("--hash"), ID = opt("--id"), SEARCH = opt("--search"), DESCRIBE = opt("--describe");
const AGL = Number(opt("--agl", 8));
if (!HASH || !ID || !SEARCH || !DESCRIBE) {
  console.error('usage: node sim/tools/env/add_scene.mjs --hash <8 hex> --id <slug> --search "<title words>" --describe "<what the place is>" [--agl 8] [--from-step N]');
  process.exit(2);
}
if (!/^[0-9a-f]{8}$/.test(HASH) || !/^[a-z][a-z0-9-]{1,30}$/.test(ID)) throw new Error("bad --hash or --id");
const FROM = Number(opt("--from-step", 1));
const CACHE = path.join(root, "cache/splat-scenes", ID);
const rel = (p) => path.relative(root, p);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const node = (script, ...a) => execFileSync(process.execPath, [path.join(root, script), ...a], { cwd: root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).toString();
const log = (s) => console.log(`[${ID}] ${s}`);

async function fetchBounded(url, max) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length > max) throw new Error(`${url}: ${b.length} bytes exceeds ${max}`);
  return b;
}

// ---------------------------------------------------------------- 1-3
async function stepScene() {
  const api = `https://playcanvas.com/api/splats/explore?search=${encodeURIComponent(SEARCH)}&limit=100&features=downloadable`;
  const found = (await (await fetch(api)).json()).result ?? [];
  const rec = found.find((r) => r.hash === HASH);
  if (!rec) throw new Error(`scene ${HASH} not found searching “${SEARCH}”`);
  if (!rec.downloads?.enabled || rec.downloads.license !== "by") throw new Error(`owner licence is ${JSON.stringify(rec.downloads)}; only CC BY with downloads enabled is accepted`);
  if (rec.voxelTask?.status !== "complete") throw new Error("the scene has no published collider");
  if (!["ssog", "sog"].includes(rec.format)) throw new Error(`format ${rec.format}: only SOG scenes (streamed or single) are supported`);
  const entry = rec.format === "ssog" ? "lod-meta.json" : "meta.json";
  const base = `https://d28zzqy0iyovbz.cloudfront.net/${HASH}/v${rec.version}/`;
  fs.mkdirSync(CACHE, { recursive: true });
  const vj = await fetchBounded(base + "scene.voxel.json", 8 << 20);
  const vb = await fetchBounded(base + "scene.voxel.bin", 400 << 20);
  fs.writeFileSync(path.join(CACHE, "scene.voxel.json"), vj);
  fs.writeFileSync(path.join(CACHE, "scene.voxel.bin"), vb);
  const vmeta = JSON.parse(vj);
  const creator = rec.user?.username ?? "unknown";
  const source = {
    hash: HASH, originalTitle: rec.title, sceneUrl: `https://superspl.at/scene/${HASH}`, viewerUrl: `https://superspl.at/s?id=${HASH}`,
    creator, creatorUrl: `https://superspl.at/user/${creator}`, license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    attribution: `"${rec.title}" by ${creator} (https://superspl.at/scene/${HASH}), licensed under CC BY 4.0.`,
    modifications: "Collider converted to a flight map; altitude band, sealed hollows and a flight volume added; drone and targets added. Scan unchanged.",
  };
  writeJson(path.join(CACHE, "provenance.json"), {
    sceneId: ID, sceneUrl: source.sceneUrl, creator, license: "CC BY 4.0", licenseUrl: source.licenseUrl, retrievedAt: new Date().toISOString(),
    ownerMetadata: { source: api, hash: rec.hash, title: rec.title, user: rec.user, downloads: rec.downloads, voxelTask: rec.voxelTask, format: rec.format, size: rec.size, version: rec.version },
    files: [{ path: "scene.voxel.json", url: base + "scene.voxel.json", sha256: sha(vj) }, { path: "scene.voxel.bin", url: base + "scene.voxel.bin", sha256: sha(vb) }],
  });
  const gb = vmeta.gridBounds;
  const c = [0, 1, 2].map((k) => (gb.min[k] + gb.max[k]) / 2);
  const m = loadManifests();
  const old = m.scenes.find((s) => s.id === ID);
  writeJson(sceneFile(ID), {
    schemaVersion: SCHEMA_VERSION, id: ID,
    registry: {
      id: ID, title: rec.title, purpose: `Arena environment candidate: ${DESCRIBE}`,
      status: "added by sim/tools/env/add_scene.mjs; awaiting review",
      source,
      assets: { splatUrl: base + entry, collisionUrl: base + "scene.voxel.json", collisionBinaryUrl: base + "scene.voxel.bin",
        posterUrl: rec.thumbnails?.xl ?? null, format: rec.format, publishedSizeBytes: rec.size, cacheDirectory: rel(CACHE),
        collisionFormat: "supersplat-voxel-1.1", collisionResolution: vmeta.resolution ?? null, collisionGridBounds: gb },
      transform: {
        splat: { position: [0, 0, 0], rotation: [0, 0, 180], scale: 1 }, collision: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
        status: "official-viewer-coordinate-convention; physical scale provisional", units: "source scene units; not independently calibrated metres",
        note: "The SOG visual entity uses Z180 import rotation; v1.1 collider already uses engine coordinates.",
      },
      camera: { position: [c[0], gb.max[1], gb.min[2]], target: c, fov: 70, sourceFrame: "engine world", status: "default overview from the collider bounds" },
      flightBounds: null, routes: [], reviewActive: true, reviewDecision: "pending",
      reviewNote: "Picked from the PlayCanvas explore API as a candidate outdoor scene (mountains, forests, natural landscapes, small villages); look not yet approved.",
    },
    calibration: null, admission: emptyAdmission(), registryOrder: old ? old.registryOrder : Math.max(...m.scenes.map((s) => s.registryOrder)) + 1,
  });
  node("sim/tools/env/sync_registries.mjs");
  log(`scene manifest, collider ${(vb.length / 1e6).toFixed(1)} MB, licence CC BY (owner ${creator})`);
  const reg = loadManifests().scenes.find((s) => s.id === ID).registry;
  const res = await cacheStreamedScene(reg, {
    outDirectory: path.join(CACHE, "assets"), indexPath: path.join(CACHE, "asset-bundle.json"),
    concurrency: 4, retries: 2, maxTotalBytes: Math.ceil((rec.size * 1.3) / (1 << 20)) * (1 << 20), maxFileBytes: 96 << 20,
  });
  log(`cached ${res.totalFiles} splat files, ${(res.totalDecodedBytes / 1e6).toFixed(0)} MB`);
}

// ---------------------------------------------------------------- 4
function autoBuild() {
  const vox = new SplatVoxels(JSON.parse(fs.readFileSync(path.join(CACHE, "scene.voxel.json"), "utf8")), fs.readFileSync(path.join(CACHE, "scene.voxel.bin")), { validate: false });
  const d = readDensity(ID);
  const gb = vox.bounds;
  // Sky-facing ground on a coarse column grid, straight from the collider.
  const step = 1.0, dy = 0.1;
  const cols = [];
  for (let x = gb.min[0] + step / 2; x < gb.max[0]; x += step) for (let z = gb.min[2] + step / 2; z < gb.max[2]; z += step) {
    for (let y = gb.max[1] - dy; y > gb.min[1]; y -= dy) if (vox.isOccupied([x, y, z])) { cols.push([x, y + dy, z]); break; }
  }
  if (!cols.length) throw new Error("no ground found in the collider");
  // Scan density around a ground point (same 2 m rule as admit.mjs).
  const counts = cols.map((g) => pointsNear(d, g, 2));
  const sorted = [...counts].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const good = cols.filter((g, i) => counts[i] >= Math.max(5, median * 0.25));
  const ys = good.map((g) => g[1]).sort((a, b) => a - b);
  const lo = ys[Math.floor(ys.length * 0.02)], hi = ys[Math.floor(ys.length * 0.98)];
  // Launch: well-captured ground closest to the centre of the captured area, with room around it.
  const cx = good.reduce((s, g) => s + g[0], 0) / good.length, cz = good.reduce((s, g) => s + g[2], 0) / good.length;
  const clear = (p, r) => { for (const o of [[0, 0, 0], [r, 0, 0], [-r, 0, 0], [0, 0, r], [0, 0, -r], [0, r, 0], [0, -r * 0.6, 0]]) if (vox.isOccupied([p[0] + o[0], p[1] + o[1], p[2] + o[2]])) return false; return true; };
  const byDist = good.map((g) => [Math.hypot(g[0] - cx, g[2] - cz), g]).sort((a, b) => a[0] - b[0]);
  // Several candidates, nearest the centre first: the map build's clearance
  // check is stricter than this sampled one, so the build tries them in turn.
  const launches = [];
  for (const [, g] of byDist) { const p = [g[0], g[1] + 1.5, g[2]]; if (clear(p, 1.0)) { launches.push(p.map((v) => Math.round(v * 10) / 10)); if (launches.length >= 12) break; } }
  if (!launches.length) throw new Error("no clear launch point on captured ground");
  const launch = launches[0];
  const crop = { min: [Math.floor(gb.min[0]), Math.floor(lo - 4), Math.floor(gb.min[2])], max: [Math.ceil(gb.max[0]), Math.ceil(Math.min(gb.max[1], hi + AGL + 4)), Math.ceil(gb.max[2])] };
  const vol = (crop.max[0] - crop.min[0]) * (crop.max[1] - crop.min[1]) * (crop.max[2] - crop.min[2]);
  const cell = Math.max(0.25, Math.ceil(Math.cbrt(vol / 12e6) / 0.05) * 0.05);
  return { crop, launch, launches, cell: Math.round(cell * 100) / 100, groundRange: [lo, hi], median };
}

function mapBuild(id, extra) {
  const m = loadManifests();
  const old = m.maps.find((x) => x.id === id);
  writeJson(path.join(DIR, "maps", `${id}.json`), { schemaVersion: SCHEMA_VERSION, id, build: extra, registryOrder: old ? old.registryOrder : Math.max(...m.maps.map((x) => x.registryOrder)) + 1 });
  node("sim/tools/env/sync_registries.mjs");
  const out = node("sim/tools/maps/build_splat_map.mjs", "--scene", id);
  return out.split("\n").filter((l) => /^(wrote|graph|flight volume|geofence|free space)/.test(l)).join(" | ");
}

async function main() {
  if (FROM <= 1) await stepScene();
  if (FROM <= 2) { log(node("sim/tools/env/scan_density.mjs", ID).trim()); }
  const a = autoBuild();
  log(`auto build: cell ${a.cell}, crop ${JSON.stringify(a.crop)}, launch ${JSON.stringify(a.launch)}, ground ${a.groundRange.map((v) => v.toFixed(1)).join("..")}`);
  const common = {
    cell: a.cell, crop: a.crop, launch: a.launch, terrainRadius: 4, agl: AGL, ceiling: null, floodClearance: 0.45, waypointClearance: 0.8,
    waypoints: 220, maxEdge: 24, edgeRadius: 0.45, scale: 1, maxCells: 26000000, scene: ID, sealBelowGroundBy: 3,
    unitsNote: "Scene units treated as metres at scale 1, without independent calibration.",
    autoNote: `Parameters chosen by sim/tools/env/add_scene.mjs from the collider and scan density on ${new Date().toISOString().slice(0, 10)}.`,
  };
  const rawId = `${ID}-raw`;
  if (FROM <= 3) {
    for (const [i, L] of a.launches.entries()) {
      try { common.launch = L; log(`raw map: ${mapBuild(rawId, { name: `${ID} (raw, before the flight volume)`, out: `sim/maps/${rawId}.json`, ...common })}`); break; }
      catch (e) { if (!/launch cell not clear/.test(String(e.stderr ?? e.message)) || i === a.launches.length - 1) throw e; log(`launch ${JSON.stringify(L)} not clear at map resolution; trying the next`); }
    }
  } else common.launch = loadManifests().maps.find((x) => x.id === rawId)?.build.launch ?? a.launch;

  // A temporary environment on the raw map, so suggest_volume can read it.
  // Seeds come from the scene hash, so re-running gives the same sets.
  const hv = parseInt(HASH, 16);
  const seedBase = 20270000 + 2 * (hv % 400000), windBase = 2000000 + 1000 * (hv % 9000);
  const harness = (map, prefix) => ({
    map, scenarioFile: `sim/scenarios/reach-${prefix}.json`,
    reach: { seed: seedBase, idPrefix: `${prefix}-`, windOffset: windBase },
    scene: `The area is a 3D scan of a real ${DESCRIBE}, open to the sky. An altitude geofence a few metres above the ground acts like a roof, so the drone cannot climb over tall obstacles.`,
    routeText: "Routes are 15-35 m long", units: "scene units (roughly metres, not calibrated)", version: "arena",
    missions: { search: { kind: "find-beacon", timeLimitSeconds: 90, train: 12, dev: 24, test: 48, detectionRange: 5, minDist: 15, maxDist: 35, seed: seedBase + 1, windBase: windBase + 3000000, surface: "sky" } },
  });
  const putEnv = (id, mapBuildId, h) => {
    const mm = loadManifests(), old = mm.envs.find((e) => e.id === id);
    writeJson(envFile(id), { schemaVersion: SCHEMA_VERSION, id, kind: "scan", scene: ID, mapBuild: mapBuildId, videoOnly: false, harness: h, admission: { ...emptyAdmission(), ...(old?.admission?.signoffs ? { signoffs: old.admission.signoffs } : {}) }, registryOrder: old ? old.registryOrder : Math.max(...mm.envs.map((e) => e.registryOrder)) + 1 });
    node("sim/tools/env/sync_registries.mjs");
  };
  const rawH = harness(`sim/maps/${rawId}.json`, rawId);
  delete rawH.scenarioFile; delete rawH.missions;
  putEnv(rawId, rawId, rawH);
  if (FROM <= 4) log(`volume: ${node("sim/tools/env/suggest_volume.mjs", rawId, "--agl", String(AGL), "--close", "2", "--margin", "0.8", "--out", ID).split("\n")[0]}`);

  // The arena map inside the volume, and its environment.
  if (FROM <= 5) log(`volume map: ${mapBuild(ID, { name: `${ID}: flight volume over captured ground`, out: `sim/maps/${ID}.json`, ...common, volume: `sim/maps/volumes/${ID}.json`, volumeNote: "Flight volume proposed by suggest_volume.mjs; awaiting review." })}`);
  const h = harness(`sim/maps/${ID}.json`, ID);
  putEnv(ID, ID, h);
  // Targets are judged on the final map, where they will actually sit.
  log(`targets: ${node("sim/tools/env/suggest_volume.mjs", ID, "--targets-only", "--out", ID).trim().split("\n").pop()}`);
  h.missions.search.targetMask = `sim/maps/volumes/${ID}-targets.json`;
  putEnv(ID, ID, h);
  // The raw environment was only a step; drop it so it never runs as a benchmark.
  fs.rmSync(envFile(rawId));
  node("sim/tools/env/sync_registries.mjs");

  for (const f of [`sim/scenarios/reach-${ID}.json`, `sim/scenarios/mission-${ID}-search.json`]) fs.rmSync(path.join(root, f), { force: true });
  execFileSync(process.execPath, ["--input-type=module", "-e", `import { loadEnvironment, pinScenarios } from "./sim/tools/benchmark_env.mjs"; pinScenarios(loadEnvironment(${JSON.stringify(ID)}));`], { cwd: root });
  let missions = "";
  try { missions = node("sim/tools/maps/make_mission_sets.mjs", "--map", ID, "--task", "search").trim(); }
  catch (e) { missions = `search missions failed: ${String(e.stderr ?? e.message).split("\n").find((l) => l.trim()) ?? ""}`; delete h.missions; putEnv(ID, ID, h); }
  log(missions);
  log(node("sim/tools/env/admit.mjs", ID).trim());
}

main().catch((e) => { console.error(`[${ID}] ${e.stack ?? e.message}`); process.exit(1); });
