#!/usr/bin/env node
// Methodology v4: apply the pre-registered selection rules
// (docs/PREREGISTRATION_V4.md) to TRAIN results only and write
// runs/v4-selection.json. Reads no dev or test results.
//   node sim/tools/study/v4_select.mjs
import fs from "node:fs";
import path from "node:path";
import { root } from "../benchmark_env.mjs";

const J = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const exists = (p) => fs.existsSync(path.join(root, p));
const RUNS = 24;

// One cell = one environment x task. Factory reach reuses v3's 24 runs and selection.
export const CELLS = [
  { id: "reach-factory", task: "reach", map: "factory" },
  { id: "reach-canyon", task: "reach", map: "canyon", loop: "runs/reach/v4cap/canyon", tune: "runs/reach/v4tune/canyon/best.json" },
  { id: "reach-residential", task: "reach", map: "residential", loop: "runs/reach/v4cap/residential", tune: "runs/reach/v4tune/residential/best.json" },
  ...["factory", "canyon", "residential"].map((map) => ({ id: `search-${map}`, task: "search", map, loop: `runs/missions/v4cap/${map}-search`, tune: `runs/missions/v4tune/${map}-search/best.json` })),
  ...["factory", "residential"].map((map) => ({ id: `delivery-${map}`, task: "delivery", map, loop: `runs/missions/v4cap/${map}-delivery`, tune: `runs/missions/v4tune/${map}-delivery/best.json` })),
];

export function select() {
  const out = { at: new Date().toISOString(), rule: "Per run: the loop's own best TRAIN version. Across runs: most TRAIN successes, then TRAIN progress, then run order.", cells: {} };
  for (const c of CELLS) {
    if (c.id === "reach-factory") {
      const v3 = J("runs/reach/v3-selection.json");
      out.cells[c.id] = { ...c, programs: v3.programs.map((p) => ({ run: p.run, version: p.version, file: p.file, trainSuccess: p.trainReached, trainProgress: p.trainProgress })), program: { run: v3.program.run, version: v3.program.version, file: v3.program.file }, tune: "runs/reach/avoider-tuned/best.json", source: "runs/reach/v3-selection.json" };
      continue;
    }
    if (!exists(`${c.loop}/ledger.json`)) throw new Error(`${c.loop} has not finished (no ledger.json)`);
    if (!exists(c.tune)) throw new Error(`${c.tune} missing`);
    const programs = Array.from({ length: RUNS }, (_, i) => {
      const curve = J(`${c.loop}/run${i}/curve.json`);
      const b = curve.curve.find((x) => x.version === curve.best);
      return { run: `run${i}`, version: curve.best, file: `${c.loop}/run${i}/best.js`, trainSuccess: c.task === "reach" ? b.reached : b.success, trainProgress: b.progress };
    });
    const best = programs.map((p, i) => ({ ...p, i })).sort((a, b) => b.trainSuccess - a.trainSuccess || b.trainProgress - a.trainProgress || a.i - b.i)[0];
    out.cells[c.id] = { ...c, programs, program: { run: best.run, version: best.version, file: best.file, trainSuccess: best.trainSuccess, trainProgress: best.trainProgress } };
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const sel = select();
  fs.writeFileSync(path.join(root, "runs/v4-selection.json"), JSON.stringify(sel, null, 1));
  for (const [id, c] of Object.entries(sel.cells)) console.log(`${id.padEnd(22)} program ${c.program.run} v${c.program.version}  train ${c.program.trainSuccess ?? "-"}/12`);
  console.log("wrote runs/v4-selection.json");
}
