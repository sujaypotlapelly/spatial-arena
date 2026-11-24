#!/usr/bin/env node
// One-off (2026-11-19): split the three registries into manifests under
// sim/environments/. Entries are copied verbatim, so sync_registries.mjs
// regenerates the registries exactly. Kept for provenance; refuses to run
// over existing manifests.
//
//   node sim/tools/env/migrate_registries.mjs
import fs from "node:fs";
import path from "node:path";
import { DIR, REGISTRY, SCHEMA_VERSION, emptyAdmission, writeJson, registryDrift, loadManifests } from "./manifests.mjs";

if (fs.existsSync(path.join(DIR, "registry-headers.json"))) {
  console.error("sim/environments/ already has manifests; nothing to migrate.");
  process.exit(1);
}
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const sets = read(REGISTRY.sets), maps = read(REGISTRY.maps), scenes = read(REGISTRY.scenes);

// Which scanned scene and which map build each harness environment uses.
// Factory maps come from build_factory_map.mjs + build_scan_graph.mjs, and the
// box-built places from add_place.mjs (or, for the v3 building, by hand), so
// they have no build_splat_map entry.
const LINKS = {
  factory: { kind: "scan", scene: "factory", mapBuild: null },
  building: { kind: "boxes", scene: null, mapBuild: null },
  canyon: { kind: "scan", scene: "canyon", mapBuild: "canyon" },
  residential: { kind: "scan", scene: "residential", mapBuild: "residential" },
  factory5: { kind: "scan", scene: "factory", mapBuild: null },
  canyon5: { kind: "scan", scene: "canyon", mapBuild: "canyon-v5" },
  residential5: { kind: "scan", scene: "residential", mapBuild: "residential" },
  "residential-video": { kind: "scan", scene: "residential", mapBuild: "residential-video" },
  warehouse: { kind: "boxes", scene: null, mapBuild: null },
};

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
writeJson(path.join(DIR, "registry-headers.json"), {
  note: "Top-level fields of the generated registries. sync_registries.mjs writes the registries from these plus the manifests; keyOrder keeps their original layout.",
  benchmarkSets: { keyOrder: Object.keys(sets), ...pick(sets, Object.keys(sets).filter((k) => k !== "environments")) },
  benchmarkMaps: { keyOrder: Object.keys(maps), ...pick(maps, Object.keys(maps).filter((k) => k !== "maps")) },
  rescueScenes: { keyOrder: Object.keys(scenes), ...pick(scenes, Object.keys(scenes).filter((k) => k !== "scenes")) },
});

Object.entries(sets.environments).forEach(([id, harness], i) => {
  const link = LINKS[id];
  if (!link) throw new Error(`no scene/map link for environment ${id}; add it to LINKS`);
  writeJson(path.join(DIR, `${id}.json`), {
    schemaVersion: SCHEMA_VERSION, id, ...link,
    videoOnly: Boolean(harness.videoOnly),
    harness, admission: emptyAdmission(), registryOrder: i,
  });
});
scenes.scenes.forEach((registry, i) => {
  writeJson(path.join(DIR, "scenes", `${registry.id}.json`), {
    schemaVersion: SCHEMA_VERSION, id: registry.id,
    registry, calibration: null, admission: emptyAdmission(), registryOrder: i,
  });
});
Object.entries(maps.maps).forEach(([id, build], i) => {
  writeJson(path.join(DIR, "maps", `${id}.json`), { schemaVersion: SCHEMA_VERSION, id, build, registryOrder: i });
});

const m = loadManifests();
if (m.problems.length) { console.error(m.problems.join("\n")); process.exit(1); }
const drift = registryDrift(m);
if (drift.length) { console.error(drift.join("\n")); process.exit(1); }
console.log(`Migrated ${m.envs.length} environments, ${m.scenes.length} scenes, ${m.maps.length} map builds; the registries regenerate exactly.`);
