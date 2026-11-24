// Method-level comparison for code as policy: average several frozen
// programs (one per independent loop run) on each scenario+seed, then pair
// against a baseline on the same episodes. Bootstrap over scenarios. Also
// reports how well each run's TRAIN score predicts its held-out score.
//   node sim/tools/study/reach_method_compare.mjs --baseline runs/reach/heldout6-ripple-v0 ripple@C3 \
//     --programs runs/reach/heldout6-cap-run0 ... --curves runs/reach/cap/run0/curve.json ...
import fs from "node:fs";

const args = process.argv.slice(2);
const after = (k) => { const i = args.indexOf(k); const out = []; for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]); return out; };
const [baseDir, baseCond] = after("--baseline");
const progDirs = after("--programs");
const curves = after("--curves");
const load = (d, cond) => fs.readFileSync(`${d}/episodes.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.condition === cond);
const key = (e) => `${e.scenario}/${e.seed}`;
const base = Object.fromEntries(load(baseDir, baseCond).map((e) => [key(e), e]));
const progs = progDirs.map((d) => Object.fromEntries(load(d, "program@C3").map((e) => [key(e), e])));
const keys = Object.keys(base).filter((k) => progs.every((p) => p[k]));
const rows = keys.map((k) => ({
  scenario: base[k].scenario,
  base: { reached: base[k].result.outcome === "reached" ? 1 : 0, progress: base[k].progress },
  prog: { reached: progs.reduce((a, p) => a + (p[k].result.outcome === "reached" ? 1 : 0), 0) / progs.length, progress: progs.reduce((a, p) => a + p[k].progress, 0) / progs.length },
}));
function boot(metric, B = 4000) {
  const by = Object.values(Object.groupBy(rows, (r) => r.scenario));
  const d = (rs) => rs.reduce((s, r) => s + r.prog[metric] - r.base[metric], 0) / rs.length;
  let s = 4242;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const vals = [];
  for (let i = 0; i < B; i++) vals.push(d(by.flatMap(() => by[Math.floor(rand() * by.length)])));
  vals.sort((a, b) => a - b);
  const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  return { base: mean((r) => r.base[metric]), prog: mean((r) => r.prog[metric]), delta: d(rows), ci: [vals[Math.floor(0.025 * B)], vals[Math.floor(0.975 * B)]] };
}
const p = (x) => `${Math.round(x * 100)}`;
console.log(`${progDirs.length} programs (mean per episode) vs ${baseCond} in ${baseDir}: ${rows.length} paired episodes, ${new Set(rows.map((r) => r.scenario)).size} scenarios`);
for (const m of ["reached", "progress"]) { const r = boot(m); console.log(`  ${m.padEnd(9)} ${p(r.base)}% → ${p(r.prog)}%  (Δ ${p(r.delta)} pp [${p(r.ci[0])}, ${p(r.ci[1])}])`); }

if (curves.length === progDirs.length) {
  // Does the TRAIN score (what selection sees) predict the held-out score?
  const pts = curves.map((c, i) => {
    const cv = JSON.parse(fs.readFileSync(c));
    const best = cv.curve.find((x) => x.version === cv.best);
    const ho = Object.values(progs[i]);
    return { train: best.progress, heldout: ho.reduce((a, e) => a + e.progress, 0) / ho.length, heldoutReached: ho.filter((e) => e.result.outcome === "reached").length / ho.length };
  });
  const rank = (xs) => { const s = [...xs].map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = []; s.forEach(([, i], k) => (r[i] = k)); return r; };
  const rx = rank(pts.map((q) => q.train)), ry = rank(pts.map((q) => q.heldout));
  const n = pts.length;
  const rho = 1 - (6 * rx.reduce((a, x, i) => a + (x - ry[i]) ** 2, 0)) / (n * (n * n - 1));
  console.log(`  train progress → held-out progress, Spearman rho = ${rho.toFixed(2)} over ${n} runs:`);
  for (const q of pts.sort((a, b) => b.train - a.train)) console.log(`    train ${p(q.train)}%  →  held-out ${p(q.heldout)}% progress, ${p(q.heldoutReached)}% reached`);
}
