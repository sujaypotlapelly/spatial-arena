// Stage 2 gate: does the benchmark separate models?
// For each control level:
//   - per-model reached / low-touch / progress with 95% cluster-bootstrap CIs
//   - every pairwise model difference, paired on scenario + seed (samples
//     averaged), with bootstrap p-values and Holm correction across all pairs
//     at that level and metric
//   - test-retest: with K >= 2 samples, how often a model gets the same
//     outcome twice on the same route and seed (agreement and Cohen's kappa)
//   - C1 ceiling: every model near 100% when our planner flies
//   node sim/tools/study/bench_separation.mjs runs/bench/stage2 [--json out.json]
import fs from "node:fs";
import path from "node:path";
import { loadReach, auditEpisode, mean, bootCI } from "../reach_metrics.mjs";

const args = process.argv.slice(2);
const dir = path.resolve(args[0] || "");
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const { world, scen } = loadReach();

const rows = [];
for (const id of fs.readdirSync(dir).sort()) {
  const f = path.join(dir, id, "episodes.jsonl");
  if (!fs.existsSync(f) || id === "baselines") continue;
  for (const line of fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean)) {
    const e = JSON.parse(line);
    const a = auditEpisode(world, scen, e);
    rows.push({ model: id, level: e.level, scenario: e.scenario, seed: e.seed, sample: e.sample ?? 0, reached: a.reached, lowTouch: a.reachedLowTouch, progress: a.progress, touching: a.touching, exact: a.exact });
  }
}
const pct = (x) => `${Math.round(100 * x)}%`;
const cellMeans = (rs, k) => Object.fromEntries(Object.entries(Object.groupBy(rs, (r) => `${r.scenario}|${r.seed}`)).map(([key, g]) => [key, { scenario: g[0].scenario, v: mean(g.map((r) => r[k])) }]));

function pairedBoot(A, B, k, n = 4000) {
  const a = cellMeans(A, k), b = cellMeans(B, k);
  const d = Object.keys(a).filter((key) => b[key]).map((key) => ({ scenario: a[key].scenario, d: b[key].v - a[key].v }));
  const by = Object.values(Object.groupBy(d, (x) => x.scenario));
  let s = 4242;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const vals = [];
  for (let i = 0; i < n; i++) vals.push(mean(by.flatMap(() => by[Math.floor(rand() * by.length)]).map((x) => x.d)));
  vals.sort((x, y) => x - y);
  const le = vals.filter((x) => x <= 0).length / n, ge = vals.filter((x) => x >= 0).length / n;
  return { n: d.length, delta: mean(d.map((x) => x.d)), lo: vals[Math.floor(0.025 * n)], hi: vals[Math.floor(0.975 * n)], p: Math.min(1, 2 * Math.min(le, ge)) };
}
function holm(ps) {
  const idx = ps.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]);
  const adj = new Array(ps.length);
  let run = 0;
  idx.forEach(([p, i], r) => { run = Math.max(run, Math.min(1, (ps.length - r) * p)); adj[i] = run; });
  return adj;
}

const out = { levels: {} };
console.log(`Episodes: ${rows.length}; replays exact: ${rows.filter((r) => r.exact).length}`);
for (const level of [...new Set(rows.map((r) => r.level))].sort()) {
  let L = rows.filter((r) => r.level === level);
  // A run that aborted part-way (credits, rate limits) keeps only the episodes
  // that finished first, which are the quick successes: a biased subset.
  // Compare each model's episode count with what its own K implies for the
  // routes × seeds the other models flew, and drop incomplete ones.
  const cells = new Set(L.map((r) => `${r.scenario}|${r.seed}`)).size;
  const incomplete = [];
  for (const m of [...new Set(L.map((r) => r.model))]) {
    const R = L.filter((r) => r.model === m);
    const K = Math.max(...R.map((r) => r.sample)) + 1;
    if (R.length < cells * K) incomplete.push(`${m} (${R.length}/${cells * K})`);
  }
  if (incomplete.length) {
    console.log(`\n=== ${level} ===\n  EXCLUDED, incomplete run (biased toward quick successes): ${incomplete.join(", ")}`);
    const drop = new Set(incomplete.map((x) => x.split(" ")[0]));
    L = L.filter((r) => !drop.has(r.model));
  }
  const models = [...new Set(L.map((r) => r.model))];
  if (!incomplete.length) console.log(`\n=== ${level} ===`);
  console.log("model                      n   reached [CI]        low-touch [CI]      progress  touching  retest agree  kappa");
  const per = {};
  for (const m of models) {
    const R = L.filter((r) => r.model === m);
    const K = Math.max(...R.map((r) => r.sample)) + 1;
    let agree = null, kappa = null;
    if (K >= 2) {
      const pairs = Object.values(Object.groupBy(R, (r) => `${r.scenario}|${r.seed}`)).filter((g) => g.length >= 2).map((g) => [g[0].reached, g[1].reached]);
      agree = mean(pairs.map(([x, y]) => (x === y ? 1 : 0)));
      const p1 = mean(pairs.map((p) => p[0])), p2 = mean(pairs.map((p) => p[1]));
      const pe = p1 * p2 + (1 - p1) * (1 - p2);
      kappa = pe < 1 ? (agree - pe) / (1 - pe) : null;
    }
    per[m] = { n: R.length, K, reached: mean(R.map((r) => r.reached)), reachedCI: bootCI(R, (x) => mean(x.map((r) => r.reached))), lowTouch: mean(R.map((r) => r.lowTouch)), lowTouchCI: bootCI(R, (x) => mean(x.map((r) => r.lowTouch))), progress: mean(R.map((r) => r.progress)), touching: mean(R.map((r) => r.touching)), agree, kappa };
    const c = per[m];
    console.log(`${m.padEnd(24)} ${String(c.n).padStart(4)}   ${pct(c.reached).padStart(4)} [${pct(c.reachedCI[0])}–${pct(c.reachedCI[1])}]`.padEnd(54) + `${pct(c.lowTouch).padStart(4)} [${pct(c.lowTouchCI[0])}–${pct(c.lowTouchCI[1])}]`.padEnd(20) + `${pct(c.progress).padStart(6)}  ${pct(c.touching).padStart(8)}  ${agree == null ? "     –" : pct(agree).padStart(12)}  ${kappa == null ? "  –" : kappa.toFixed(2).padStart(5)}`);
  }
  const pairsOut = {};
  for (const k of ["reached", "lowTouch", "progress"]) {
    const res = [];
    for (let i = 0; i < models.length; i++) for (let j = i + 1; j < models.length; j++) res.push({ a: models[i], b: models[j], ...pairedBoot(L.filter((r) => r.model === models[i]), L.filter((r) => r.model === models[j]), k) });
    const adj = holm(res.map((r) => r.p));
    res.forEach((r, i) => (r.pHolm = adj[i]));
    pairsOut[k] = res;
    const sig = res.filter((r) => r.pHolm < 0.05);
    console.log(`  ${k}: ${sig.length} of ${res.length} model pairs differ after Holm (p < 0.05)` + (sig.length ? ":" : ""));
    for (const r of sig.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))) console.log(`    ${r.b} − ${r.a}: ${r.delta >= 0 ? "+" : ""}${Math.round(100 * r.delta)} pp [${Math.round(100 * r.lo)}, ${Math.round(100 * r.hi)}], p_Holm ${r.pHolm.toFixed(3)}`);
  }
  out.levels[level] = { per, pairs: pairsOut };
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
