// Pre-demo check. For every recording the demo tabs use: re-simulate every
// episode and confirm the recorded outcomes reproduce, and count invalid
// (failed or unparseable) model decisions. Then check that the hosts the
// pages load from (three.js CDN, PlayCanvas, the factory scan) answer.
//   node sim/tools/legacy/preflight.mjs [recordings/a.json ...]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../../src/world.js";
import { Arena } from "../../src/arena.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sim = path.join(here, "../..");
const DEFAULT = ["recordings/ripple-demo-36.json", "recordings/ripple-training.json", "recordings/ripple-factory.json", "recordings/ripple-factory-full.json"];
const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
let bad = 0;

for (const rel of files) {
  const file = path.join(sim, rel);
  if (!fs.existsSync(file)) {
    console.log(`MISSING  ${rel}`);
    bad++;
    continue;
  }
  const data = JSON.parse(fs.readFileSync(file));
  const mapFile = data.mapFile || "maps/building.json";
  const world = new World(JSON.parse(fs.readFileSync(path.join(sim, mapFile))));
  const arena = new Arena(world, [], { enabled: false });
  const { checked, mismatched } = arena.importSession(data);
  const eps = data.evaluation?.episodes || [];
  const invalid = eps.filter((e) => e.defender?.invalid).length;
  const conds = data.evaluation ? Object.entries(data.evaluation.metrics).map(([k, m]) => `${k} ${Math.round(m.successRate * 100)}%`).join(", ") : "no evaluation";
  const ok = mismatched === 0 && data.usingModel;
  if (!ok) bad++;
  console.log(`${ok ? "OK      " : "CHECK   "} ${rel}`);
  console.log(`         ${data.usingModel ? "Ripple" : "NOT RIPPLE (offline stand-in)"} on ${mapFile}; ${checked} episodes re-simulated, ${mismatched} mismatched; ${invalid}/${eps.length} invalid held-out decisions`);
  console.log(`         ${conds}`);
}

const hosts = [
  ["three.js CDN", "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js"],
  ["Markdown renderer (Findings tab)", "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"],
  ["PlayCanvas engine", "https://cdn.jsdelivr.net/npm/playcanvas@2.18.0/build/playcanvas.min.mjs"],
  ["Factory scan (temporary URL)", "https://code.playcanvas.com/temp/factory/lod-meta.json"],
];
for (const [name, url] of hosts) {
  try {
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    console.log(`${r.ok ? "OK      " : "CHECK   "} ${name}: HTTP ${r.status}`);
    if (!r.ok) bad++;
  } catch (e) {
    console.log(`FAIL     ${name}: ${e.message}`);
    bad++;
  }
}
console.log(bad ? `\n${bad} item(s) need attention.` : "\nAll demo recordings reproduce and all hosts answer.");
process.exitCode = bad ? 1 : 0;
