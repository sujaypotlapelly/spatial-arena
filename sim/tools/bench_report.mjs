// Leaderboard for a bench.mjs output directory (docs/BENCHMARK.md).
// Re-flies every episode with the current code (must reproduce exactly),
// then reports per model and control level:
//   reached        mean over all episodes (samples averaged), 95% cluster-bootstrap CI over scenarios
//   pass^k         share of scenario+seed cells where all k samples reached (reliability)
//   low-touch      reached while touching geometry ≤ 15% of the flight (pre-registered secondary)
//   progress, touching, invalid replies, truncated replies, cost
// and, with --ref <id>, paired differences against a reference model.
//   node sim/tools/bench_report.mjs runs/bench/dev-v1 --ref ripple-65b
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { loadEnvironment } from "./benchmark_env.mjs";
import { auditEpisode, harnessHash, harnessVersion, mean, bootCI, TOUCH_MAX, ROOT } from "./reach_metrics.mjs";

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const dir = path.resolve(args.find((a, i) => !a.startsWith("--") && !["--ref", "--registry"].includes(args[i - 1])) || "");
if (!fs.existsSync(dir)) throw new Error("usage: bench_report.mjs <bench output dir> [--ref model-id]");
const ref = opt("--ref");
const registry = JSON.parse(fs.readFileSync(path.resolve(opt("--registry", path.join(ROOT, "sim/bench/models.json")))));
const price = Object.fromEntries(registry.models.map((m) => [m.id, m.price]));
// The place and prompt features come from the run itself (older runs: the factory, no features).
let world = null, scen = null, setup = null;
const useSetup = (e) => {
  const s = `${e.map ?? "factory"}${(e.features ?? []).length ? ` + ${e.features.join("+")}` : ""}`;
  if (setup && s !== setup) throw new Error(`${dir} mixes runs flown on "${setup}" and "${s}". Report each from its own folder.`);
  if (!setup) {
    setup = s;
    const E = loadEnvironment(e.map ?? "factory");
    world = E.world;
    scen = Object.fromEntries(["train", "dev", "heldout", "test"].flatMap((k) => E.sets[k] ?? []).map((x) => [x.id, x]));
  }
};
const current = harnessHash();

const rows = [];
const meta = {};
const versions = new Set();
for (const id of fs.readdirSync(dir).sort()) {
  const f = path.join(dir, id, "episodes.jsonl");
  let episodes;
  if (fs.existsSync(f)) episodes = fs.readFileSync(f, "utf8");
  else if (fs.existsSync(f + ".gz")) episodes = gunzipSync(fs.readFileSync(f + ".gz")).toString("utf8");
  else continue;
  const cfg = fs.existsSync(path.join(dir, id, "config.json")) ? JSON.parse(fs.readFileSync(path.join(dir, id, "config.json"))) : {};
  const ledgers = fs.existsSync(path.join(dir, id, "ledger.jsonl")) ? fs.readFileSync(path.join(dir, id, "ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).ledger).filter(Boolean) : [];
  const sum = (k) => ledgers.reduce((s, l) => s + (l[k] || 0), 0);
  const hosts = {};
  for (const l of ledgers) for (const [h, n] of Object.entries(l.providers || {})) hosts[h] = (hosts[h] || 0) + n;
  meta[id] = { cfg, calls: sum("calls"), promptTokens: sum("promptTokens"), completionTokens: sum("completionTokens"), retries: sum("transportRetries"), hosts };
  for (const line of episodes.trim().split("\n")) {
    const e = JSON.parse(line);
    if (e.harnessHash) versions.add(harnessVersion(e.harnessHash, current));
    useSetup(e);
    const a = auditEpisode(world, scen, e);
    let finishCut = 0;
    for (const d of e.decisionLog) if (d.meta?.finish && d.meta.finish !== "stop") finishCut++;
    rows.push({ model: id, ctl: e.ctl, condition: e.condition, level: e.level, scenario: e.scenario, seed: e.seed, sample: e.sample ?? 0, decisions: e.decisions, invalid: e.invalid, finishCut, ...a });
  }
}
if (!rows.length) throw new Error(`no episodes under ${dir}`);
// One report, one harness version: flights from different versions were flown under different rules.
if (versions.size > 1) throw new Error(`${dir} mixes harness versions (${[...versions].join(", ")}). Report each version from its own folder.`);
const reportVersion = [...versions][0] ?? "not recorded";

const pct = (x) => (x == null ? "–" : `${Math.round(100 * x)}%`);
const ci = ([lo, hi]) => `[${Math.round(100 * lo)}–${Math.round(100 * hi)}]`;
const cells = [];
for (const [cond, rs] of Object.entries(Object.groupBy(rows, (r) => r.condition))) {
  const r0 = rs[0];
  const K = Math.max(...rs.map((r) => r.sample)) + 1;
  const bySS = Object.values(Object.groupBy(rs, (r) => `${r.scenario}|${r.seed}`));
  const passK = K > 1 ? mean(bySS.map((g) => (g.length === K && g.every((r) => r.reached) ? 1 : 0))) : null;
  const dec = rs.reduce((s, r) => s + r.decisions, 0);
  cells.push({
    model: r0.model, condition: cond, ctl: r0.ctl, level: r0.level, episodes: rs.length, scenarios: new Set(rs.map((r) => r.scenario)).size, K,
    reached: mean(rs.map((r) => r.reached)), reachedCI: bootCI(rs, (x) => mean(x.map((r) => r.reached))),
    passK, lowTouch: mean(rs.map((r) => r.reachedLowTouch)), lowTouchCI: bootCI(rs, (x) => mean(x.map((r) => r.reachedLowTouch))),
    progress: mean(rs.map((r) => r.progress)), touching: mean(rs.map((r) => r.touching)),
    invalidRate: dec ? rs.reduce((s, r) => s + r.invalid, 0) / dec : 0, truncatedRate: dec ? rs.reduce((s, r) => s + r.finishCut, 0) / dec : 0,
    exact: rs.filter((r) => r.exact).length,
  });
}
const order = (c) => [c.ctl === "model" ? 0 : 1, c.level, c.model];
cells.sort((a, b) => (order(a).join("|") < order(b).join("|") ? -1 : 1));

const lines = [];
const out = (s = "") => { lines.push(s); console.log(s); };
out(`# Reach benchmark: ${path.basename(dir)}`);
out();
out(`Place and prompt: ${setup}. Harness ${reportVersion}. Generated by \`sim/tools/bench_report.mjs\` from \`${path.relative(ROOT, dir)}\`; do not edit by hand. Reached = within 1 m of the goal in 90 s. Low-touch = reached while touching geometry at most ${Math.round(TOUCH_MAX * 100)}% of the flight. CIs are 95% cluster bootstraps over scenarios.`);
out();
const levels = [...new Set(cells.map((c) => c.level))].sort();
const models = [...new Set(cells.filter((c) => c.ctl === "model").map((c) => c.model))];
if (models.length) {
  out("## Reached, by model and control level");
  out();
  out(`| Model | ${levels.join(" | ")} |`);
  out(`|---|${levels.map(() => "---").join("|")}|`);
  for (const m of models) out(`| ${m} | ${levels.map((l) => { const c = cells.find((x) => x.model === m && x.level === l); return c ? `${pct(c.reached)} ${ci(c.reachedCI)}` : "–"; }).join(" | ")} |`);
  const base = cells.filter((c) => c.ctl !== "model");
  if (base.length) out(`| *baselines* | ${levels.map((l) => base.filter((c) => c.level === l).map((c) => `${c.ctl} ${pct(c.reached)}`).join(", ") || "–").join(" | ")} |`);
  out();
}
out("## All cells");
out();
out("| Model | Level | Episodes | Scen. × K | Reached [CI] | pass^k | Low-touch [CI] | Progress | Touching | Invalid | Truncated | Replays exact |");
out("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const c of cells) out(`| ${c.ctl === "model" ? c.model : c.ctl} | ${c.level} | ${c.episodes} | ${c.scenarios} × ${c.K} | ${pct(c.reached)} ${ci(c.reachedCI)} | ${pct(c.passK)} | ${pct(c.lowTouch)} ${ci(c.lowTouchCI)} | ${pct(c.progress)} | ${pct(c.touching)} | ${pct(c.invalidRate)} | ${pct(c.truncatedRate)} | ${c.exact}/${c.episodes} |`);
out();
out("## Runs");
out();
out("| Model | Model id | Host pin | Hosts seen | Calls | Prompt tokens | Completion tokens | Transport retries | Est. cost |");
out("|---|---|---|---|---|---|---|---|---|");
for (const [id, m] of Object.entries(meta)) {
  if (id === "baselines") continue;
  const p = price[id];
  const cost = p ? `$${((m.promptTokens * p.in + m.completionTokens * p.out) / 1e6).toFixed(2)}` : "–";
  out(`| ${id} | \`${m.cfg.model ?? "?"}\` | ${m.cfg.provider ?? "unpinned"}${m.cfg.quantizations ? " " + m.cfg.quantizations.join("/") : ""} | ${Object.entries(m.hosts).map(([h, n]) => `${h} ${n}`).join(", ") || "–"} | ${m.calls} | ${m.promptTokens} | ${m.completionTokens} | ${m.retries} | ${cost} |`);
}
out();

let pairs = [];
if (ref) {
  out(`## Paired differences against ${ref} (same scenario and seed, samples averaged)`);
  out();
  out("| Model | Level | n cells | Reached Δ [95% CI] | Low-touch Δ [95% CI] |");
  out("|---|---|---|---|---|");
  const cellMean = (rs, k) => Object.fromEntries(Object.entries(Object.groupBy(rs, (r) => `${r.scenario}|${r.seed}`)).map(([key, g]) => [key, { scenario: g[0].scenario, v: mean(g.map((r) => r[k])) }]));
  for (const m of models.filter((x) => x !== ref)) for (const l of levels) {
    const A = rows.filter((r) => r.model === ref && r.level === l), B = rows.filter((r) => r.model === m && r.level === l);
    if (!A.length || !B.length) continue;
    const res = {};
    for (const k of ["reached", "reachedLowTouch"]) {
      const a = cellMean(A, k), b = cellMean(B, k);
      const d = Object.keys(a).filter((key) => b[key]).map((key) => ({ scenario: a[key].scenario, d: b[key].v - a[key].v }));
      res[k] = { n: d.length, delta: mean(d.map((x) => x.d)), ci: bootCI(d, (x) => mean(x.map((y) => y.d))) };
    }
    pairs.push({ ref, model: m, level: l, ...res });
    const f = (r) => `${r.delta >= 0 ? "+" : ""}${Math.round(100 * r.delta)} pp [${Math.round(100 * r.ci[0])}, ${Math.round(100 * r.ci[1])}]`;
    out(`| ${m} | ${l} | ${res.reached.n} | ${f(res.reached)} | ${f(res.reachedLowTouch)} |`);
  }
  out();
  out("Uncorrected; apply Holm across the comparisons in a pre-registered family before calling any difference significant.");
}
fs.writeFileSync(path.join(dir, "LEADERBOARD.md"), lines.join("\n") + "\n");
fs.writeFileSync(path.join(dir, "leaderboard.json"), JSON.stringify({ harness: current, harnessVersion: reportVersion, cells, runs: meta, pairs }, null, 1));
console.error(`\nwrote ${path.relative(ROOT, path.join(dir, "LEADERBOARD.md"))}`);
