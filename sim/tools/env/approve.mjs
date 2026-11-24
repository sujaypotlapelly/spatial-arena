#!/usr/bin/env node
// Record a person's approval of a scene's look and use (the stage-0 review
// gate), then re-check every environment that uses the scene.
//
//   node sim/tools/env/approve.mjs verzasca-valley --by reviewer-name [--note "..."]
//   node sim/tools/env/approve.mjs verzasca-valley --by reviewer-name --reject --note "too dark"
import { execFileSync } from "node:child_process";
import { loadManifests, sceneFile, writeJson, root } from "./manifests.mjs";

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const id = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const by = opt("--by");
if (!id || !by) { console.error('usage: node sim/tools/env/approve.mjs <scene> --by <name> [--note "..."] [--reject]'); process.exit(2); }
const m = loadManifests();
const s = m.scenes.find((x) => x.id === id);
if (!s) throw new Error(`no scene "${id}"`);
const reject = args.includes("--reject"), date = new Date().toISOString().slice(0, 10);
s.registry.reviewDecision = reject ? "rejected" : "approved";
s.registry.reviewNote = `${reject ? "Rejected" : "Approved"} by ${by} on ${date}${opt("--note") ? `: ${opt("--note")}` : "."}`;
s.registry.status = reject ? "rejected at review" : "approved; see admission";
writeJson(sceneFile(id), s);
const run = (script, ...a) => execFileSync(process.execPath, [script, ...a], { cwd: root, stdio: "inherit" });
run("sim/tools/env/sync_registries.mjs");
for (const e of m.envs.filter((x) => x.scene === id && !x.videoOnly)) run("sim/tools/env/admit.mjs", e.id);
run("sim/tools/env/gallery.mjs");
