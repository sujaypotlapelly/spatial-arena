// Methodology v3: apply the pre-registered selection rules
// (docs/PREREGISTRATION_V3.md) to TRAIN-route results only, and write
// runs/reach/v3-selection.json. Reads no test or building results.
//   node sim/tools/study/reach_v3_select.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const R = (p) => path.join(root, "runs/reach", p);

// ---- programs: 24 loop runs, each run's frozen best.js ----
export const LOOP_RUNS = [
  ...[0, 1, 2].map((i) => `cap/run${i}`),
  ...[0, 1, 2, 3, 4].map((i) => `cap2/run${i}`),
  ...Array.from({ length: 16 }, (_, i) => `cap3/run${i}`),
];
const programs = LOOP_RUNS.map((run) => {
  const f = R(`${run}/curve.json`);
  if (!fs.existsSync(f)) throw new Error(`${run} has no curve.json yet (is cap3 finished?)`);
  const c = JSON.parse(fs.readFileSync(f));
  const b = c.curve.find((x) => x.version === c.best);
  return { run, version: c.best, file: path.relative(root, R(`${run}/best.js`)), trainReached: b.reached, trainProgress: b.progress };
});
// Highest train reached, then train progress, then run order.
const program = [...programs].map((p, i) => ({ ...p, i })).sort((a, b) => b.trainReached - a.trainReached || b.trainProgress - a.trainProgress || a.i - b.i)[0];

// ---- per-second prompt variants on train ----
export const VARIANTS = {
  v0: [],
  rel: ["--features", "rel"],
  struct: ["--features", "struct"],
  ascii: ["--features", "ascii"],
  trail: ["--features", "trail"],
  "rel-struct-ascii-trail": ["--features", "rel,struct,ascii,trail"],
  named: ["--features", "named"],
  warn: ["--features", "warn"],
  "named-warn": ["--features", "named,warn"],
  lean: ["--features", "lean"],
  notes: ["--notes", "runs/reach/learn-c3/notes-round2.json"],
  "lean-notes": ["--features", "lean", "--notes", "runs/reach/learn-c3/notes-short.json"],
  dt2: ["--dt", "2"],
};
const variants = Object.entries(VARIANTS).map(([name, flags], i) => {
  const f = R(`v3train-${name}/summary.json`);
  if (!fs.existsSync(f)) throw new Error(`v3train-${name} has no summary.json yet`);
  const cell = JSON.parse(fs.readFileSync(f)).cells.find((c) => c.condition === "ripple@C3");
  if (cell.episodes !== 12) throw new Error(`v3train-${name}: ${cell.episodes} episodes, expected 12`);
  return { name, flags, i, trainReached: Math.round(cell.reached * 12), trainProgress: cell.progress };
});
// Highest train progress, then reached, then listed order.
const perSecond = [...variants].sort((a, b) => b.trainProgress - a.trainProgress || b.trainReached - a.trainReached || a.i - b.i)[0];

const avoider = JSON.parse(fs.readFileSync(R("avoider-tuned/best.json")));

const out = {
  at: new Date().toISOString(),
  rules: "docs/PREREGISTRATION_V3.md",
  program: { ...program, i: undefined },
  programs,
  perSecond: { ...perSecond, i: undefined },
  variants: variants.map(({ i, ...v }) => v),
  avoider: { file: "runs/reach/avoider-tuned/best.json", ...avoider.best },
};
fs.writeFileSync(R("v3-selection.json"), JSON.stringify(out, null, 1));
console.log(`program: ${program.run} v${program.version} (train ${program.trainReached}/12, ${Math.round(program.trainProgress * 100)}%)`);
console.log(`per-second: ${perSecond.name} (train ${perSecond.trainReached}/12, ${Math.round(perSecond.trainProgress * 100)}%)`);
console.log(`avoider: #${avoider.best.i} (train ${avoider.best.reached}/12, ${Math.round(avoider.best.progress * 100)}%)`);
console.log("variants on train:", variants.map((v) => `${v.name} ${v.trainReached}/12 ${Math.round(v.trainProgress * 100)}%`).join(" · "));
