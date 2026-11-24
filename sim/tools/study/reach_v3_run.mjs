// Methodology v3: the single evaluation pass (docs/PREREGISTRATION_V3.md).
// Applies the selection rules (reach_v3_select.mjs), then runs every
// controller once on the 48-route factory test set and the 40-route building
// transfer set. Refuses to run twice into the same directories.
//   node sim/tools/study/reach_v3_run.mjs
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const R = (p) => path.join(root, "runs/reach", p);
if (fs.existsSync(R("v3test-baselines"))) throw new Error("v3 test pass already ran (runs/reach/v3test-baselines exists). The pre-registration allows one look.");

execFileSync("node", [path.join(here, "reach_v3_select.mjs")], { cwd: root, stdio: "inherit" });
const sel = JSON.parse(fs.readFileSync(R("v3-selection.json")));
const AV = ["--avoider", "runs/reach/avoider-tuned/best.json"];
const tag = (run) => run.replace("/", "-");

// [label, args, paid?]
const jobs = [];
for (const [map, set] of [["factory", "test"], ["building", "test"]]) {
  const pre = map === "factory" ? "v3test" : "v3bldg";
  const m = ["--map", map, "--set", set, "--seeds", "2"];
  jobs.push([`${pre}-baselines`, [...m, "--conditions", "planner@C1,straight@C2,reactive@C3,tuned@C3", ...AV], false]);
  for (const p of sel.programs) jobs.push([`${pre}-prog-${tag(p.run)}`, [...m, "--conditions", "program@C3", "--program", p.file], false]);
}
// Per-second Ripple, factory test only (its prompt describes the factory).
const fm = ["--map", "factory", "--set", "test", "--seeds", "2", "--conditions", "ripple@C3", "--concurrency", "12"];
jobs.push(["v3test-ripple-v0", fm, true]);
if (sel.perSecond.name !== "v0") jobs.push([`v3test-ripple-${sel.perSecond.name}`, [...fm, ...sel.perSecond.flags], true]);

function run([label, a]) {
  return new Promise((resolve, reject) => {
    const out = fs.openSync(R(`${label}.log`), "w");
    const p = spawn("node", [path.join(here, "../reach_eval.mjs"), ...a, "--random", "legacy", "--out", R(label)], { cwd: root, stdio: ["ignore", out, out] });
    p.on("exit", (code) => (code === 0 ? resolve(label) : reject(new Error(`${label} exited ${code}; see runs/reach/${label}.log`))));
  });
}
// Paid jobs start at once; free jobs run 6 at a time alongside.
const paid = jobs.filter((j) => j[2]).map(run);
const free = jobs.filter((j) => !j[2]);
const t0 = Date.now();
let i = 0, done = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < free.length) {
    const j = free[i++];
    await run(j);
    done++;
    if (done % 10 === 0 || done === free.length) console.log(`free ${done}/${free.length} [${Math.round((Date.now() - t0) / 1000)} s]`);
  }
}));
console.log("free jobs done; waiting for per-second Ripple");
for (const l of await Promise.all(paid)) console.log("done", l);
console.log(`v3 pass complete in ${Math.round((Date.now() - t0) / 60000)} min. Next: node sim/tools/study/reach_v3_report.mjs`);
