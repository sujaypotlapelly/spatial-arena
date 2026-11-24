#!/usr/bin/env node
// Methodology v4: the single test pass (docs/PREREGISTRATION_V4.md).
// Applies the selection rules (v4_select.mjs), then flies every controller
// once on every cell's test set, plus the cross-environment transfer matrix.
// No model calls: programs run locally. Refuses to run twice.
//   node sim/tools/study/v4_run.mjs [--parallel 6]
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { root } from "../benchmark_env.mjs";

const args = process.argv.slice(2);
const PAR = Number(args.includes("--parallel") ? args[args.indexOf("--parallel") + 1] : 6);
// --dry: rehearse the whole pipeline on 2 DEV items per cell into runs/v4dry
// (never the test set), so the real pass cannot fail halfway.
const DRY = args.includes("--dry");
const OUT = path.join(root, DRY ? "runs/v4dry" : "runs/v4test");
if (!DRY && fs.existsSync(OUT)) throw new Error("v4 test pass already ran (runs/v4test exists). The pre-registration allows one look.");
if (DRY) fs.rmSync(OUT, { recursive: true, force: true });
execFileSync("node", [path.join(root, "sim/tools/study/v4_select.mjs")], { cwd: root, stdio: "inherit" });
const sel = JSON.parse(fs.readFileSync(path.join(root, "runs/v4-selection.json"), "utf8"));
fs.mkdirSync(OUT, { recursive: true });

const jobs = []; // [cellId, label, tool, args]
const SET = DRY ? ["--set", "dev", "--limit", "2"] : ["--set", "test"];
const reach = (map) => ["sim/tools/reach_eval.mjs", ["--map", map, ...SET, "--seeds", "2", "--random", "legacy"]];
const mission = (map, task) => ["sim/tools/mission_eval.mjs", ["--map", map, "--task", task, ...SET, "--seeds", "2", ...(DRY ? [] : ["--test-pass"])]];
for (const c of Object.values(sel.cells)) {
  const [tool, base] = c.task === "reach" ? reach(c.map) : mission(c.map, c.task);
  // Factory reach: v3 already flew every factory controller on this test set
  // (runs/reach/v3test-*); only the transfer jobs below are new.
  if (c.id !== "reach-factory" || DRY) {
    if (c.id === "reach-factory") c.tune = "runs/reach/avoider-tuned/best.json";
    if (c.task === "reach") jobs.push([c.id, "baselines", tool, [...base, "--conditions", "planner@C1,straight@C2,reactive@C3,tuned@C3", "--avoider", c.tune]]);
    else jobs.push([c.id, "baselines", tool, [...base, "--conditions", `oracle,${c.task === "search" ? "explorer" : "padseeker"},tuned`, "--params", c.tune]]);
    for (const p of c.programs) jobs.push([c.id, `prog-${p.run}`, tool, [...base, "--conditions", c.task === "reach" ? "program@C3" : "program", "--program", p.file]]);
  }
  // Transfer: every other environment's selected program for the same task.
  for (const o of Object.values(sel.cells)) {
    if (o.task !== c.task || o.map === c.map) continue;
    jobs.push([c.id, `from-${o.map}`, tool, [...base, "--conditions", c.task === "reach" ? "program@C3" : "program", "--program", o.program.file]]);
  }
}
fs.writeFileSync(path.join(OUT, "jobs.json"), JSON.stringify({ at: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim(), jobs }, null, 1));
console.log(`${jobs.length} evaluation jobs, ${PAR} at a time`);

function run([cell, label, tool, a]) {
  const dir = path.join(OUT, cell, label);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  return new Promise((resolve, reject) => {
    const out = fs.openSync(`${dir}.log`, "w");
    const p = spawn("node", [path.join(root, tool), ...a, "--out", dir], { cwd: root, stdio: ["ignore", out, out] });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cell}/${label} exited ${code}; see ${path.relative(root, dir)}.log`))));
  });
}
const t0 = Date.now();
let i = 0, done = 0;
await Promise.all(Array.from({ length: PAR }, async () => {
  while (i < jobs.length) {
    const j = jobs[i++];
    await run(j);
    done++;
    if (done % 10 === 0 || done === jobs.length) console.log(`${done}/${jobs.length} [${Math.round((Date.now() - t0) / 1000)} s]`);
  }
}));
console.log(`v4 test pass complete in ${Math.round((Date.now() - t0) / 60000)} min. Next: node sim/tools/study/v4_report.mjs`);
