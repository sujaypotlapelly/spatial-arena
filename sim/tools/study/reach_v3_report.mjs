// Methodology v3 report: the pre-registered tests H1-H4 (docs/PREREGISTRATION_V3.md)
// and the full tables, from the single evaluation pass (reach_v3_run.mjs).
// Re-flies every episode (exact replay check + contact metrics). No API calls.
//   node sim/tools/study/reach_v3_report.mjs     → docs/RESULTS_V3.md, runs/reach/v3-report.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../../src/world.js";
import { makeReachSets } from "../../src/gym/reach.js";
import { auditEpisode, mean } from "../reach_metrics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const R = (p) => path.join(root, "runs/reach", p);
const sel = JSON.parse(fs.readFileSync(R("v3-selection.json")));
const tag = (run) => run.replace("/", "-");

const MAPS = {
  factory: { world: new World(JSON.parse(fs.readFileSync(path.join(root, "sim/maps/factory-full.json")))), pre: "v3test" },
  building: { world: new World(JSON.parse(fs.readFileSync(path.join(root, "sim/maps/building.json")))), pre: "v3bldg" },
};
MAPS.factory.scen = Object.fromEntries(makeReachSets(MAPS.factory.world).test.map((s) => [s.id, s]));
MAPS.building.scen = Object.fromEntries(makeReachSets(MAPS.building.world, { train: 0, dev: 0, heldout: 0, test: 40 }).test.map((s) => [s.id, s]));

let replays = 0, exact = 0;
function load(map, dir, cond) {
  const f = R(`${dir}/episodes.jsonl`);
  const eps = fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.condition === cond);
  return eps.map((e) => {
    const a = auditEpisode(MAPS[map].world, MAPS[map].scen, e);
    replays++;
    exact += a.exact ? 1 : 0;
    return { scenario: e.scenario, seed: e.seed, ...a };
  });
}
// Average several controllers flight by flight (the 24-program method mean).
function averaged(lists) {
  const key = (r) => `${r.scenario}/${r.seed}`;
  const maps = lists.map((l) => Object.fromEntries(l.map((r) => [key(r), r])));
  return lists[0].map((r) => {
    const rs = maps.map((m) => m[key(r)]);
    const o = { scenario: r.scenario, seed: r.seed };
    for (const k of ["reached", "clean", "reachedLowTouch", "progress", "touching", "perMin"]) o[k] = mean(rs.map((x) => x[k]));
    return o;
  });
}

const rows = {};
for (const map of ["factory", "building"]) {
  const P = MAPS[map].pre;
  const r = (rows[map] = {});
  r.planner = load(map, `${P}-baselines`, "planner@C1");
  r.straight = load(map, `${P}-baselines`, "straight@C2");
  r.avoider = load(map, `${P}-baselines`, "reactive@C3");
  r.tuned = load(map, `${P}-baselines`, "tuned@C3");
  const progs = sel.programs.map((p) => ({ run: p.run, rows: load(map, `${P}-prog-${tag(p.run)}`, "program@C3") }));
  r.program = progs.find((p) => p.run === sel.program.run).rows;
  r.programs = averaged(progs.map((p) => p.rows));
  r.perRun = progs.map((p) => ({ run: p.run, reached: mean(p.rows.map((x) => x.reached)), progress: mean(p.rows.map((x) => x.progress)) }));
  if (map === "factory") {
    r.ripple = load(map, "v3test-ripple-v0", "ripple@C3");
    r.rippleTuned = sel.perSecond.name === "v0" ? r.ripple : load(map, `v3test-ripple-${sel.perSecond.name}`, "ripple@C3");
  }
}

// ---- stats: paired cluster bootstrap over routes ----
function paired(a, b, k = "reached", B = 2000, seed = 777) {
  const key = (x) => `${x.scenario}/${x.seed}`;
  const bm = Object.fromEntries(b.map((x) => [key(x), x]));
  const pairs = a.filter((x) => bm[key(x)]).map((x) => ({ scenario: x.scenario, d: bm[key(x)][k] - x[k] }));
  const by = Object.values(Object.groupBy(pairs, (p) => p.scenario));
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const vals = [];
  for (let i = 0; i < B; i++) vals.push(mean(by.flatMap(() => by[Math.floor(rand() * by.length)]).map((p) => p.d)));
  vals.sort((x, y) => x - y);
  const p = Math.min(1, 2 * Math.min(vals.filter((v) => v <= 0).length, vals.filter((v) => v >= 0).length) / B);
  return { delta: mean(pairs.map((x) => x.d)), ci: [vals[Math.floor(0.025 * B)], vals[Math.floor(0.975 * B)]], p, n: pairs.length };
}
function ci(rs, k = "reached", B = 2000, seed = 12345) {
  const by = Object.values(Object.groupBy(rs, (r) => r.scenario));
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const vals = [];
  for (let i = 0; i < B; i++) vals.push(mean(by.flatMap(() => by[Math.floor(rand() * by.length)]).map((r) => r[k])));
  vals.sort((x, y) => x - y);
  return [vals[Math.floor(0.025 * B)], vals[Math.floor(0.975 * B)]];
}

const F = rows.factory, Bd = rows.building;
const H = [
  { id: "H1", text: "program > per-second Ripple, tuned (factory test)", ...paired(F.rippleTuned, F.program) },
  { id: "H2", text: "program > avoider, tuned (factory test)", ...paired(F.tuned, F.program) },
  { id: "H3", text: "all 24 programs, averaged > per-second Ripple v0 (factory test)", ...paired(F.ripple, F.programs) },
  { id: "H4", text: "program > avoider, tuned (building transfer)", ...paired(Bd.tuned, Bd.program) },
];
// Holm: sort by p, compare to alpha / (m - rank).
[...H].sort((a, b) => a.p - b.p).forEach((h, i) => (h.holmAlpha = 0.05 / (H.length - i)));
let stop = false;
for (const h of [...H].sort((a, b) => a.p - b.p)) {
  h.holds = !stop && h.p <= h.holmAlpha && h.delta > 0;
  if (!h.holds) stop = true;
}

// Does train score predict test score across the 24 runs? (Spearman)
const rank = (xs) => { const s = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = []; s.forEach(([, i], k) => (r[i] = k)); return r; };
const trainScore = sel.programs.map((p) => p.trainReached + p.trainProgress);
const testScore = F.perRun.map((p) => p.reached + p.progress / 100);
const rx = rank(trainScore), ry = rank(testScore), n = rx.length;
const rho = 1 - (6 * rx.reduce((a, x, i) => a + (x - ry[i]) ** 2, 0)) / (n * (n * n - 1));

// ---- markdown ----
const pct = (x) => `${Math.round(x * 100)}%`;
const pp = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}`;
const row = (name, rs) => `| ${name} | ${pct(mean(rs.map((r) => r.reached)))} [${ci(rs).map(pct).join("–")}] | ${pct(mean(rs.map((r) => r.progress)))} | ${pct(mean(rs.map((r) => r.touching)))} | ${pct(mean(rs.map((r) => r.clean)))} |`;
const head = "| Controller | Reached [95% CI] | Progress | Time touching walls | Reached with no contact |\n|---|---|---|---|---|";
const perSecName = sel.perSecond.name === "v0" ? "Ripple, second by second (best prompt on train = plain v0)" : `Ripple, second by second, best prompt on train (${sel.perSecond.name})`;
const md = `# Results: methodology v3 (generated)

Generated by \`sim/tools/study/reach_v3_report.mjs\` from the single evaluation pass under [PREREGISTRATION_V3.md](PREREGISTRATION_V3.md). Do not edit by hand. ${exact}/${replays} episodes re-flew exactly from their recorded commands.

**Selection (training routes only).** Program: \`${sel.program.run}\` v${sel.program.version} (train ${sel.program.trainReached}/12). Per-second prompt: \`${sel.perSecond.name}\` (train ${sel.perSecond.trainReached}/12, ${pct(sel.perSecond.trainProgress)} progress, best of ${sel.variants.length}). Avoider: parameter set #${sel.avoider.i} (train ${sel.avoider.reached}/12, best of ${sel.programs.length * 8 + 1}).

## Pre-registered tests (reached; paired by route and wind seed; Holm across H1–H4)

| | Hypothesis | Δ reached [95% CI] | p | Holm α | Result |
|---|---|---|---|---|---|
${H.map((h) => `| ${h.id} | ${h.text} | ${pp(h.delta)} pp [${pp(h.ci[0])}, ${pp(h.ci[1])}] | ${h.p.toFixed(3)} | ${h.holmAlpha.toFixed(4)} | **${h.holds ? "holds" : "not supported"}** |`).join("\n")}

## Factory, 48 fresh routes × 2 wind seeds (${F.program.length} flights per controller)

${head}
${row("Map + A* planner (upper bound)", F.planner)}
${row(`Program Ripple wrote (${sel.program.run})`, F.program)}
${row("All 24 programs, averaged", F.programs)}
${row("Avoider, tuned on train", F.tuned)}
${row("Avoider, hand-written", F.avoider)}
${sel.perSecond.name === "v0" ? "" : row(perSecName, F.rippleTuned) + "\n"}${row("Ripple, second by second (plain prompt)", F.ripple)}
${row("Straight-line flyer", F.straight)}

Per-run spread (24 programs, test reached): min ${pct(Math.min(...F.perRun.map((p) => p.reached)))}, median ${pct([...F.perRun.map((p) => p.reached)].sort((a, b) => a - b)[12])}, max ${pct(Math.max(...F.perRun.map((p) => p.reached)))}. Train score vs test score across runs: Spearman ρ = ${rho.toFixed(2)}.

## Building transfer, 40 routes × 2 wind seeds, zero-shot (${Bd.program.length} flights per controller)

${head}
${row("Map + A* planner (upper bound)", Bd.planner)}
${row(`Program Ripple wrote (${sel.program.run}, written for the factory)`, Bd.program)}
${row("All 24 programs, averaged", Bd.programs)}
${row("Avoider, tuned on factory train", Bd.tuned)}
${row("Avoider, hand-written", Bd.avoider)}
${row("Straight-line flyer", Bd.straight)}

## Secondary comparisons (not corrected)

| Comparison | Δ reached | Δ progress |
|---|---|---|
${[
  ["Program vs per-second v0 (factory)", F.ripple, F.program],
  ["Program vs avoider, hand-written (factory)", F.avoider, F.program],
  ["All 24 programs vs avoider, tuned (factory)", F.tuned, F.programs],
  ["Avoider tuned vs hand-written (factory)", F.avoider, F.tuned],
  ["All 24 programs vs avoider, tuned (building)", Bd.tuned, Bd.programs],
  ["Program vs avoider, hand-written (building)", Bd.avoider, Bd.program],
].map(([n, a, b]) => { const r = paired(a, b), q = paired(a, b, "progress"); return `| ${n} | ${pp(r.delta)} pp [${pp(r.ci[0])}, ${pp(r.ci[1])}] | ${pp(q.delta)} pp [${pp(q.ci[0])}, ${pp(q.ci[1])}] |`; }).join("\n")}
`;
fs.writeFileSync(path.join(root, "docs/RESULTS_V3.md"), md);
const summ = (rs) => ({ reached: mean(rs.map((r) => r.reached)), ci: ci(rs), progress: mean(rs.map((r) => r.progress)), touching: mean(rs.map((r) => r.touching)), clean: mean(rs.map((r) => r.clean)), n: rs.length });
const tables = {
  factory: { planner: summ(F.planner), program: summ(F.program), programs: summ(F.programs), tuned: summ(F.tuned), avoider: summ(F.avoider), rippleTuned: summ(F.rippleTuned), ripple: summ(F.ripple), straight: summ(F.straight) },
  building: { planner: summ(Bd.planner), program: summ(Bd.program), programs: summ(Bd.programs), tuned: summ(Bd.tuned), avoider: summ(Bd.avoider), straight: summ(Bd.straight) },
};
const pairsOut = {
  programVsRipple: paired(F.ripple, F.program), programVsRippleTuned: paired(F.rippleTuned, F.program), programVsTuned: paired(F.tuned, F.program),
  programsVsRipple: paired(F.ripple, F.programs), programsVsTuned: paired(F.tuned, F.programs), tunedVsAvoider: paired(F.avoider, F.tuned),
  bldgProgramVsTuned: paired(Bd.tuned, Bd.program), bldgProgramsVsTuned: paired(Bd.tuned, Bd.programs),
};
fs.writeFileSync(R("v3-report.json"), JSON.stringify({ selection: sel, hypotheses: H, rho, replays: { exact, total: replays }, perRun: { factory: F.perRun, building: Bd.perRun }, tables, pairs: pairsOut }, null, 1));
console.log(md);
