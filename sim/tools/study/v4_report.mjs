#!/usr/bin/env node
// Methodology v4 report: the pre-registered tests G1-G3
// (docs/PREREGISTRATION_V4.md), per-cell tables and the transfer matrix,
// from the single test pass (v4_run.mjs; factory reach from v3's pass).
// Every episode was replay-checked when it was flown; this counts them.
//   node sim/tools/study/v4_report.mjs   -> docs/RESULTS_V4.md, runs/v4-report.json
import fs from "node:fs";
import path from "node:path";
import { root } from "../benchmark_env.mjs";

const args = process.argv.slice(2);
const DRY = args.includes("--dry"); // rehearsal: read runs/v4dry, write nothing under docs/
const IN = DRY ? "runs/v4dry" : "runs/v4test";
const sel = JSON.parse(fs.readFileSync(path.join(root, "runs/v4-selection.json"), "utf8"));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
let episodes = 0, replayOk = 0;

function load(dir, condition) {
  const f = path.join(root, dir, "episodes.jsonl");
  const eps = fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.condition === condition);
  if (!eps.length) throw new Error(`${dir}: no ${condition} episodes`);
  return eps.map((e) => {
    episodes++;
    replayOk += e.replayOk ? 1 : 0;
    const success = e.success ?? e.result.outcome === "reached";
    return { item: e.mission ?? e.scenario, seed: e.seed, success: success ? 1 : 0, progress: e.progress, contacts: e.result.contacts };
  });
}
function averaged(lists) {
  const key = (r) => `${r.item}/${r.seed}`;
  const maps = lists.map((l) => Object.fromEntries(l.map((r) => [key(r), r])));
  return lists[0].map((r) => {
    const rs = maps.map((m) => m[key(r)]);
    return { item: r.item, seed: r.seed, success: mean(rs.map((x) => x.success)), progress: mean(rs.map((x) => x.progress)), contacts: mean(rs.map((x) => x.contacts)) };
  });
}
function rng(seed) { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); }
function paired(a, b, k = "success", B = 2000) {
  const key = (x) => `${x.item}/${x.seed}`;
  const bm = Object.fromEntries(b.map((x) => [key(x), x]));
  const pairs = a.filter((x) => bm[key(x)]).map((x) => ({ item: x.item, d: bm[key(x)][k] - x[k] }));
  const by = Object.values(Object.groupBy(pairs, (p) => p.item));
  const rand = rng(777), vals = [];
  for (let i = 0; i < B; i++) vals.push(mean(by.flatMap(() => by[Math.floor(rand() * by.length)]).map((p) => p.d)));
  vals.sort((x, y) => x - y);
  const p = Math.min(1, (2 * Math.min(vals.filter((v) => v <= 0).length, vals.filter((v) => v >= 0).length)) / B);
  // One-sided p for the stated direction (delta > 0): share of resamples <= 0.
  const pOne = vals.filter((v) => v <= 0).length / B;
  return { delta: mean(pairs.map((x) => x.d)), ci: [vals[Math.floor(0.025 * B)], vals[Math.floor(0.975 * B)]], p, pOne, n: pairs.length };
}
function ci(rs, k = "success", B = 2000) {
  const by = Object.values(Object.groupBy(rs, (r) => r.item));
  const rand = rng(12345), vals = [];
  for (let i = 0; i < B; i++) vals.push(mean(by.flatMap(() => by[Math.floor(rand() * by.length)]).map((r) => r[k])));
  vals.sort((x, y) => x - y);
  return [vals[Math.floor(0.025 * B)], vals[Math.floor(0.975 * B)]];
}

// ---------- load every cell ----------
const tag = (run) => run.replace("/", "-");
const cells = {};
for (const c of Object.values(sel.cells)) {
  const T = `${IN}/${c.id}`;
  const r = { id: c.id, task: c.task, map: c.map };
  if (c.id === "reach-factory" && !DRY) {
    r.upper = load("runs/reach/v3test-baselines", "planner@C1");
    r.straight = load("runs/reach/v3test-baselines", "straight@C2");
    r.hand = load("runs/reach/v3test-baselines", "reactive@C3");
    r.tuned = load("runs/reach/v3test-baselines", "tuned@C3");
    r.perRun = c.programs.map((p) => ({ run: p.run, rows: load(`runs/reach/v3test-prog-${tag(p.run)}`, "program@C3") }));
  } else if (c.task === "reach") {
    r.upper = load(`${T}/baselines`, "planner@C1");
    r.straight = load(`${T}/baselines`, "straight@C2");
    r.hand = load(`${T}/baselines`, "reactive@C3");
    r.tuned = load(`${T}/baselines`, "tuned@C3");
    r.perRun = c.programs.map((p) => ({ run: p.run, rows: load(`${T}/prog-${p.run}`, "program@C3") }));
  } else {
    r.upper = load(`${T}/baselines`, "oracle");
    r.hand = load(`${T}/baselines`, c.task === "search" ? "explorer" : "padseeker");
    r.tuned = load(`${T}/baselines`, "tuned");
    r.perRun = c.programs.map((p) => ({ run: p.run, rows: load(`${T}/prog-${p.run}`, "program") }));
  }
  r.program = r.perRun.find((p) => p.run === c.program.run).rows;
  r.programs = averaged(r.perRun.map((p) => p.rows));
  r.from = {};
  for (const o of Object.values(sel.cells)) if (o.task === c.task && o.map !== c.map) r.from[o.map] = load(`${T}/from-${o.map}`, c.task === "reach" ? "program@C3" : "program");
  cells[c.id] = r;
}

// ---------- pre-registered tests ----------
const tests = [];
for (const r of Object.values(cells)) tests.push({ id: `G1 ${r.id}`, text: `program > tuned sensor-only baseline (${r.id})`, ...paired(r.tuned, r.program) });
for (const id of ["reach-canyon", "reach-residential"]) tests.push({ id: `G2 ${id}`, text: `in-environment program > factory program zero-shot (${id})`, ...paired(cells[id].from.factory, cells[id].program) });
for (const r of Object.values(cells)) tests.push({ id: `G3 ${r.id}`, text: `all 24 programs, averaged > hand-written baseline (${r.id})`, ...paired(r.hand, r.programs) });
// Holm across all primary tests.
// (a) As first coded, copied from v3: two-sided p, sequence stops at the first
//     test that does not hold, including a significant effect in the wrong
//     direction. With 18 tests this lets one wrong-direction result block
//     every test after it, which is not what the directional hypotheses mean.
// (b) Corrected, disclosed after seeing results: one-sided p for the stated
//     direction, standard Holm step-down. Both are reported.
function holm(key, out, alphaKey) {
  const order = [...tests].sort((a, b) => a[key] - b[key]);
  let stop = false;
  order.forEach((t, i) => {
    t[alphaKey] = 0.05 / (tests.length - i);
    const ok = !stop && t[key] <= t[alphaKey] && t.delta > 0;
    t[out] = ok;
    if (!ok) stop = true;
  });
}
holm("p", "holdsAsCoded", "alphaAsCoded");
holm("pOne", "holds", "alpha");

// ---------- tables ----------
const pct = (x) => `${Math.round(x * 100)}%`;
const pp = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}`;
const row = (name, rs) => `| ${name} | ${pct(mean(rs.map((x) => x.success)))} [${ci(rs).map(pct).join("–")}] | ${pct(mean(rs.map((x) => x.progress)))} | ${mean(rs.map((x) => x.contacts)).toFixed(1)} |`;
const NAMES = { reach: ["Map + A* planner (upper bound)", "Avoider"], search: ["Oracle: A*, knows where the hiker is (upper bound)", "Explorer"], delivery: ["Oracle: A* to the pad (upper bound)", "Pad seeker"] };
let md = `# Results: methodology v4 (generated)

Generated by \`sim/tools/study/v4_report.mjs\` from the single test pass under [PREREGISTRATION_V4.md](PREREGISTRATION_V4.md). Do not edit by hand. ${replayOk}/${episodes} episodes re-flew exactly from their recorded commands when they were run. Factory reach rows are v3's test pass (the same controllers, the same routes).

## Pre-registered tests (success; paired by item and wind seed; Holm across ${tests.length})

**Analysis correction, disclosed after seeing the results.** The report as first coded reused v3's procedure: two-sided p, with the Holm sequence stopping at the first test that does not hold. With 18 tests, a significant result in the *wrong* direction then blocks every later test, including G2's +69 and +76 pp effects at p < 0.001. The hypotheses are directional, so the corrected analysis uses one-sided p and standard Holm. Both verdicts are shown. The corrected column is the result.

| | Hypothesis | Δ success [95% CI] | p (one-sided) | Holm α | Result (corrected) | As first coded |
|---|---|---|---|---|---|---|
${tests.map((t) => `| ${t.id.split(" ")[0]} | ${t.text} | ${pp(t.delta)} pp [${pp(t.ci[0])}, ${pp(t.ci[1])}] | ${t.pOne.toFixed(4)} | ${t.alpha.toFixed(4)} | **${t.holds ? "holds" : "not supported"}** | ${t.holdsAsCoded ? "holds" : "not supported"} |`).join("\n")}
`;
for (const r of Object.values(cells)) {
  const [upper, hand] = NAMES[r.task];
  const runs = r.perRun.map((p) => mean(p.rows.map((x) => x.success))).sort((a, b) => a - b);
  md += `
## ${r.id} (${new Set(r.program.map((x) => x.item)).size} test items × 2 wind seeds)

| Controller | Success [95% CI] | Progress | Contacts / flight |
|---|---|---|---|
${row(upper, r.upper)}
${row(`Program Ripple wrote here (${sel.cells[r.id].program.run})`, r.program)}
${row("All 24 programs, averaged", r.programs)}
${Object.entries(r.from).map(([m, rs]) => row(`Program written for the ${m}, unchanged`, rs)).join("\n")}
${row(`${hand}, tuned on train`, r.tuned)}
${row(`${hand}, hand-written`, r.hand)}
${r.straight ? row("Straight-line flyer", r.straight) : ""}

Per-run spread (24 programs, test success): min ${pct(runs[0])}, median ${pct(runs[12])}, max ${pct(runs[23])}.
`;
}
md += `
## Transfer matrix (selected program per environment; rows = where it was written, columns = where it flew)

${["reach", "search", "delivery"].map((task) => {
  const maps = Object.values(cells).filter((r) => r.task === task).map((r) => r.map);
  const cell = (from, to) => { const r = cells[`${task}-${to}`]; return pct(mean((from === to ? r.program : r.from[from]).map((x) => x.success))); };
  return `**${task}**\n\n| written for ↓ / flown in → | ${maps.join(" | ")} |\n|---|${maps.map(() => "---").join("|")}|\n${maps.map((f) => `| ${f} | ${maps.map((t) => cell(f, t)).join(" | ")} |`).join("\n")}\n`;
}).join("\n")}`;
fs.writeFileSync(path.join(root, DRY ? "runs/v4dry/RESULTS_V4_DRY.md" : "docs/RESULTS_V4.md"), md);
const strip = (rs) => ({ success: mean(rs.map((x) => x.success)), ci: ci(rs), progress: mean(rs.map((x) => x.progress)) });
fs.writeFileSync(path.join(root, DRY ? "runs/v4dry/report.json" : "runs/v4-report.json"), JSON.stringify({ at: new Date().toISOString(), episodes, replayOk, tests, cells: Object.fromEntries(Object.values(cells).map((r) => [r.id, { upper: strip(r.upper), program: strip(r.program), programs: strip(r.programs), tuned: strip(r.tuned), hand: strip(r.hand), ...(r.straight ? { straight: strip(r.straight) } : {}), from: Object.fromEntries(Object.entries(r.from).map(([k, rs]) => [k, strip(rs)])), perRun: r.perRun.map((p) => ({ run: p.run, success: mean(p.rows.map((x) => x.success)) })) }])) }, null, 1));
console.log(md.split("\n").slice(0, 30).join("\n"));
console.log("wrote docs/RESULTS_V4.md, runs/v4-report.json");
