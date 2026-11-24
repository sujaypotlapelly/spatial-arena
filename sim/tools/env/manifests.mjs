// Environment manifests: the source of truth for every place in the arena.
//
//   sim/environments/<id>.json         one per harness environment (stages 2-4)
//   sim/environments/scenes/<id>.json  one per scanned scene (stages 0-1: source, licence, look, calibration)
//   sim/environments/maps/<id>.json    one per scan-to-map build (parameters for build_splat_map.mjs)
//   sim/environments/registry-headers.json  the top-level fields of the generated registries
//
// The older registries (sim/scenes/benchmark-sets.json, benchmark-maps.json,
// rescue-scenes.json) are generated from these files by sync_registries.mjs,
// so the tools that read them keep working. Edit the manifests, then sync.
// The spec is docs/CONTRIBUTING_ENVIRONMENTS.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.join(here, "../../..");
export const DIR = path.join(root, "sim/environments");
export const REGISTRY = {
  sets: path.join(root, "sim/scenes/benchmark-sets.json"),
  maps: path.join(root, "sim/scenes/benchmark-maps.json"),
  scenes: path.join(root, "sim/scenes/rescue-scenes.json"),
};
export const SCHEMA_VERSION = 1;
export const STAGES = ["candidate", "integrated", "valid", "demo-ready", "measured"];

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const listJson = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")).sort() : []);
export const writeJson = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 2) + "\n"); };

export function emptyAdmission() {
  return { stage: null, checkedAt: null, commit: null, gates: {}, signoffs: {} };
}

// Load every manifest, check the cross-references, and return them in registry order.
export function loadManifests(dir = DIR) {
  const envs = listJson(dir).filter((f) => f !== "registry-headers.json").map((f) => readJson(path.join(dir, f)));
  const scenes = listJson(path.join(dir, "scenes")).map((f) => readJson(path.join(dir, "scenes", f)));
  const maps = listJson(path.join(dir, "maps")).map((f) => readJson(path.join(dir, "maps", f)));
  const headers = readJson(path.join(dir, "registry-headers.json"));
  const byOrder = (a, b) => a.registryOrder - b.registryOrder;
  envs.sort(byOrder); scenes.sort(byOrder); maps.sort(byOrder);
  const problems = validate({ envs, scenes, maps });
  return { envs, scenes, maps, headers, problems };
}

export function validate({ envs, scenes, maps }) {
  const p = [];
  const sceneIds = new Set(scenes.map((s) => s.id)), mapIds = new Set(maps.map((m) => m.id));
  const idOk = (id) => /^[a-z][a-z0-9-]{1,40}$/.test(id ?? "");
  for (const [kind, list] of [["environment", envs], ["scene", scenes], ["map build", maps]]) {
    const seen = new Set();
    for (const m of list) {
      if (m.schemaVersion !== SCHEMA_VERSION) p.push(`${kind} ${m.id}: schemaVersion must be ${SCHEMA_VERSION}`);
      if (!idOk(m.id)) p.push(`${kind} ${m.id}: id must be lower-case letters, digits and dashes`);
      if (seen.has(m.id)) p.push(`${kind} ${m.id}: duplicate id`);
      seen.add(m.id);
      if (!Number.isInteger(m.registryOrder)) p.push(`${kind} ${m.id}: registryOrder must be an integer`);
    }
  }
  for (const e of envs) {
    if (!["scan", "boxes"].includes(e.kind)) p.push(`environment ${e.id}: kind must be "scan" or "boxes"`);
    if (e.kind === "scan" && !sceneIds.has(e.scene)) p.push(`environment ${e.id}: scene "${e.scene}" has no manifest in sim/environments/scenes/`);
    if (e.mapBuild != null && !mapIds.has(e.mapBuild)) p.push(`environment ${e.id}: mapBuild "${e.mapBuild}" has no manifest in sim/environments/maps/`);
    if (!e.harness?.map) p.push(`environment ${e.id}: harness.map is missing`);
    if (!e.videoOnly && (typeof e.harness?.scene !== "string" || e.harness.scene.length < 20)) p.push(`environment ${e.id}: harness.scene must describe the place to the model`);
    if (!e.admission) p.push(`environment ${e.id}: admission block is missing`);
  }
  for (const s of scenes) {
    if (!s.registry || s.registry.id !== s.id) p.push(`scene ${s.id}: registry.id must equal the manifest id`);
    if (!s.admission) p.push(`scene ${s.id}: admission block is missing`);
  }
  for (const m of maps) if (!m.build?.out) p.push(`map build ${m.id}: build.out is missing`);
  return p;
}

// The three registries, rebuilt from the manifests with their original key order.
export function buildRegistries({ envs, scenes, maps, headers }) {
  const h = headers;
  const sets = {};
  for (const k of h.benchmarkSets.keyOrder) {
    if (k === "environments") sets.environments = Object.fromEntries(envs.map((e) => [e.id, e.harness]));
    else sets[k] = h.benchmarkSets[k];
  }
  const mapsReg = {};
  for (const k of h.benchmarkMaps.keyOrder) {
    if (k === "maps") mapsReg.maps = Object.fromEntries(maps.map((m) => [m.id, m.build]));
    else mapsReg[k] = h.benchmarkMaps[k];
  }
  const scenesReg = {};
  for (const k of h.rescueScenes.keyOrder) {
    if (k === "scenes") scenesReg.scenes = scenes.map((s) => s.registry);
    else scenesReg[k] = h.rescueScenes[k];
  }
  return { sets, maps: mapsReg, scenes: scenesReg };
}

// Compare the generated registries with the files on disk (by value, not by
// formatting). Returns a list of differences; empty means in sync.
export function registryDrift(m = loadManifests()) {
  const built = buildRegistries(m);
  const drift = [];
  for (const k of ["sets", "maps", "scenes"]) {
    const onDisk = readJson(REGISTRY[k]);
    if (JSON.stringify(onDisk) !== JSON.stringify(built[k])) drift.push(`${path.relative(root, REGISTRY[k])} differs from the manifests`);
  }
  return drift;
}

export function environment(id, m = loadManifests()) {
  const e = m.envs.find((x) => x.id === id);
  if (!e) throw new Error(`no environment "${id}"; known: ${m.envs.map((x) => x.id).join(", ")}`);
  return { env: e, scene: m.scenes.find((s) => s.id === e.scene) ?? null, map: m.maps.find((x) => x.id === e.mapBuild) ?? null };
}

export const envFile = (id) => path.join(DIR, `${id}.json`);
export const sceneFile = (id) => path.join(DIR, "scenes", `${id}.json`);
