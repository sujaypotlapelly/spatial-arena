#!/usr/bin/env node
// Write the older registries from the manifests in sim/environments/, or
// check that they match. Tools that read sim/scenes/benchmark-sets.json,
// benchmark-maps.json and rescue-scenes.json keep working unchanged.
//
//   node sim/tools/env/sync_registries.mjs           # write any registry that differs
//   node sim/tools/env/sync_registries.mjs --check   # exit 1 if any differs
import fs from "node:fs";
import path from "node:path";
import { REGISTRY, root, loadManifests, buildRegistries, registryDrift } from "./manifests.mjs";

const m = loadManifests();
if (m.problems.length) { console.error(`Manifest problems:\n  - ${m.problems.join("\n  - ")}`); process.exit(1); }
const drift = registryDrift(m);
if (process.argv.includes("--check")) {
  if (drift.length) { console.error(`${drift.join("\n")}\nRun: node sim/tools/env/sync_registries.mjs`); process.exit(1); }
  console.log("Registries match the manifests.");
  process.exit(0);
}
const built = buildRegistries(m);
let wrote = 0;
for (const k of ["sets", "maps", "scenes"]) {
  const before = JSON.parse(fs.readFileSync(REGISTRY[k], "utf8"));
  if (JSON.stringify(before) === JSON.stringify(built[k])) continue;
  fs.writeFileSync(REGISTRY[k], JSON.stringify(built[k], null, 2) + "\n");
  console.log(`wrote ${path.relative(root, REGISTRY[k])}`);
  wrote++;
}
if (!wrote) console.log("Registries already match the manifests.");
