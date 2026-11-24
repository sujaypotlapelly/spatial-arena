#!/usr/bin/env node
// Pools saved arena sessions (Arena.exportSession output) into one findings
// table. Each file is a replicate run; episodes are pooled by condition.
//   node sim/tools/legacy/report.mjs <file-or-glob>... [--out sim/recordings/findings]
//        [--group-by key|label] [--baseline raw] [--include-offline]
// Offline-heuristic sessions (usingModel false, or offline-*.json) are
// excluded by default; with --include-offline they are kept apart under an
// "offline:" prefix, never pooled with real Ripple results.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export const RESAMPLES = 2000;
export const SEED = 20261113;

// ---- statistics ----

// mulberry32: small, fast, seedable.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (sorted, q) => {
  const i = q * (sorted.length - 1);
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
};

// Percentile bootstrap: resample `items` (clusters) with replacement and
// recompute `stat`. Fresh RNG per call, so results never depend on call order.
export function bootstrap(items, stat, { resamples = RESAMPLES, seed = SEED } = {}) {
  if (!items.length) return null;
  const r = rng(seed);
  const vals = [];
  for (let i = 0; i < resamples; i++) {
    const v = stat(items.map(() => items[Math.floor(r() * items.length)]));
    if (Number.isFinite(v)) vals.push(v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return [quantile(vals, 0.025), quantile(vals, 0.975)];
}

const est = (items, stat) => ({ value: items.length ? stat(items) : null, ci: bootstrap(items, stat), n: items.length });

// ---- loading ----

function expand(args) {
  const out = [];
  for (const a of args) {
    if (fs.existsSync(a)) out.push(a);
    else if (/[*?[{]/.test(a)) out.push(...fs.globSync(a).sort());
    else out.push(a); // reported as unreadable below
  }
  return [...new Set(out)];
}

function fingerprint(s) {
  const sig = s.evaluation.episodes.map((e) => [e.condition, e.scenario?.id, e.defender?.latencyMs, (e.results || []).map((r) => [r.seed, r.outcome, r.time])]);
  return crypto.createHash("sha1").update(JSON.stringify(sig)).digest("hex");
}

export function loadSessions(paths, { includeOffline = false } = {}) {
  const files = [];
  const excluded = [];
  const seen = new Map();
  for (const p of expand(paths)) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      excluded.push({ path: p, reason: `unreadable: ${e.message.split("\n")[0]}` });
      continue;
    }
    if (!s?.evaluation?.episodes?.length) {
      excluded.push({ path: p, reason: "no evaluation episodes" });
      continue;
    }
    const offline = s.usingModel !== true || /^offline-/.test(path.basename(p));
    if (offline && !includeOffline) {
      excluded.push({ path: p, reason: s.usingModel !== true ? "offline heuristic (usingModel false)" : "offline-* file name" });
      continue;
    }
    const fp = fingerprint(s);
    if (seen.has(fp)) {
      excluded.push({ path: p, reason: `duplicate of ${seen.get(fp)} (identical evaluation episodes)` });
      continue;
    }
    seen.set(fp, p);
    files.push({ path: p, session: s, offline });
  }
  return { files, excluded };
}

// One flat record per evaluation episode (one decision flown on N seeds).
export function flatten(files, { groupBy = "key" } = {}) {
  const eps = [];
  for (const f of files) {
    const ev = f.session.evaluation;
    const labels = Object.fromEntries((ev.conditions || []).map((c) => [c.key, c.label || c.key]));
    for (const e of ev.episodes) {
      if (e.kind && e.kind !== "eval") continue;
      const model = e.condition !== "shortest";
      const results = e.results || [];
      const b = e.belief;
      const g = groupBy === "label" ? labels[e.condition] || e.condition : e.condition;
      eps.push({
        file: f.path,
        group: (f.offline ? "offline:" : "") + g,
        condition: e.condition,
        label: labels[e.condition] || e.condition,
        model,
        scenario: e.scenario?.id,
        scenarioDef: JSON.stringify({ start: e.scenario?.start, goal: e.scenario?.goal, bird: e.scenario?.bird }),
        results: results.map((r) => ({ seed: r.seed, reached: r.outcome === "reached" ? 1 : 0 })),
        trials: results.length,
        reached: results.filter((r) => r.outcome === "reached").length,
        solved: (e.summary?.successRate ?? (results.length ? results.filter((r) => r.outcome === "reached").length / results.length : 0)) >= 0.5 ? 1 : 0,
        invalid: !!e.defender?.invalid,
        // Invalid (or missing) beliefs count as wrong; null for the comparator.
        family: model ? (b?.familyCorrect ? 1 : 0) : null,
        behavior: model ? (b?.behaviorCorrect ? 1 : 0) : null,
        danger: b?.dangerError ?? null,
        prediction: b?.predictionError ?? null,
        latencyMs: Number.isFinite(e.defender?.latencyMs) ? e.defender.latencyMs : null,
        toolCalls: e.defender?.toolCalls?.length || 0,
        provider: e.defender?.provider || null,
      });
    }
  }
  return eps;
}

// ---- aggregation ----

const successStat = (eps) => sum(eps.map((e) => e.reached)) / sum(eps.map((e) => e.trials));
const rate = (k) => (eps) => mean(eps.map((e) => e[k]));

export function summarize(eps) {
  const model = eps.every((e) => e.model);
  const files = [...new Set(eps.map((e) => e.file))];
  const vals = (k) => eps.map((e) => e[k]).filter((x) => x !== null);
  return {
    label: [...new Set(eps.map((e) => e.label))].join(" / "),
    model,
    nFiles: files.length,
    nScenarios: new Set(eps.map((e) => e.scenario)).size,
    nDecisions: eps.length,
    nTrials: sum(eps.map((e) => e.trials)),
    success: est(eps, successStat),
    solved: rate("solved")(eps),
    family: model ? est(eps, rate("family")) : null,
    behavior: model ? est(eps, rate("behavior")) : null,
    danger: model ? est(vals("danger"), mean) : null,
    prediction: model ? est(vals("prediction"), mean) : null,
    invalid: eps.filter((e) => e.invalid).length,
    medianLatencyS: model && vals("latencyMs").length ? median(vals("latencyMs")) / 1000 : null,
    toolCallsPerDecision: model ? mean(eps.map((e) => e.toolCalls)) : null,
    hosts: [...new Set(eps.map((e) => e.provider).filter(Boolean))],
    perFile: files.map((f) => {
      const fe = eps.filter((e) => e.file === f);
      return { file: f, decisions: fe.length, success: successStat(fe) };
    }),
  };
}

// Paired by scenario id: average each side over its replicates, using only
// seeds both sides flew, then bootstrap the mean difference over scenarios.
export function paired(epsA, epsB) {
  const by = (eps) => {
    const m = new Map();
    for (const e of eps) {
      if (!m.has(e.scenario)) m.set(e.scenario, []);
      m.get(e.scenario).push(e);
    }
    return m;
  };
  const A = by(epsA);
  const B = by(epsB);
  const rows = [];
  for (const [id, ea] of A) {
    const eb = B.get(id);
    if (!eb) continue;
    const seedsA = new Set(ea.flatMap((e) => e.results.map((r) => r.seed)));
    const common = new Set(eb.flatMap((e) => e.results.map((r) => r.seed)).filter((s) => seedsA.has(s)));
    if (!common.size) continue;
    const succ = (eps) => mean(eps.flatMap((e) => e.results.filter((r) => common.has(r.seed)).map((r) => r.reached)));
    const fam = (eps) => (eps.every((e) => e.family !== null) ? mean(eps.map((e) => e.family)) : null);
    const fa = fam(ea);
    const fb = fam(eb);
    rows.push({ id, success: succ(ea) - succ(eb), family: fa !== null && fb !== null ? fa - fb : null });
  }
  const famRows = rows.filter((r) => r.family !== null).map((r) => r.family);
  const out = {
    nScenarios: rows.length,
    success: est(rows.map((r) => r.success), mean),
    family: famRows.length ? est(famRows, mean) : null,
  };
  for (const k of ["success", "family"]) if (out[k]) out[k].distinguishable = !!out[k].ci && (out[k].ci[0] > 0 || out[k].ci[1] < 0);
  return out;
}

export function buildReport(paths, { groupBy = "key", baseline = null, includeOffline = false } = {}) {
  const { files, excluded } = loadSessions(paths, { includeOffline });
  const eps = flatten(files, { groupBy });
  const groups = [...new Set(eps.map((e) => e.group))];
  const conditions = Object.fromEntries(groups.map((g) => [g, summarize(eps.filter((e) => e.group === g))]));
  const pick = (k) => groups.find((g) => g === k || eps.some((e) => e.group === g && e.condition === k));
  const base = baseline ? pick(baseline) : pick("raw") || pick("original");
  const comparisons = {};
  if (base) for (const g of groups) if (g !== base) comparisons[g] = paired(eps.filter((e) => e.group === g), eps.filter((e) => e.group === base));
  // Same scenario id, different definition across files: matching by id is unsafe.
  const defs = new Map();
  for (const e of eps) defs.set(e.scenario, (defs.get(e.scenario) || new Set()).add(e.scenarioDef));
  const conflicts = [...defs].filter(([, s]) => s.size > 1).map(([id]) => id);
  return {
    generatedAt: new Date().toISOString(),
    groupBy,
    bootstrap: { resamples: RESAMPLES, seed: SEED, unit: "episode (paired: scenario)" },
    files: files.map((f) => ({ path: f.path, offline: f.offline, exportedAt: f.session.exportedAt, evaluatedAt: f.session.evaluation.at, trainingEpisodes: f.session.training?.length || 0 })),
    excluded,
    totals: { files: files.length, scenarios: new Set(eps.map((e) => e.scenario)).size, decisions: eps.length, trials: sum(eps.map((e) => e.trials)) },
    scenarioConflicts: conflicts,
    baseline: base || null,
    conditions,
    comparisons,
  };
}

// ---- rendering ----

const pct = (x) => (x === null || x === undefined ? "-" : `${Math.round(x * 100)}%`);
const num = (x, d = 1) => (x === null || x === undefined ? "-" : x.toFixed(d));
const sgn = (x, f) => (x > 0 ? "+" : "") + f(x);
const pp = (x) => `${Math.round(x * 100)}pp`;
const withCi = (e, f) => (!e || e.value === null ? "-" : e.ci ? `${f(e.value)} [${f(e.ci[0])}–${f(e.ci[1])}]` : f(e.value));
const ppCi = (e) => (!e || e.value === null ? "-" : `${sgn(e.value, pp)} [${sgn(e.ci[0], pp)}, ${sgn(e.ci[1], pp)}]${e.distinguishable ? " *" : ""}`);
const m = (x) => num(x) + " m";

function tables(r) {
  const c = Object.entries(r.conditions);
  const main = {
    head: ["condition", "files", "scen", "decisions", "trials", "success [95% CI]", "solved", "family acc", "behavior acc", "danger err", "3s pred err"],
    rows: c.map(([k, s]) => [k, s.nFiles, s.nScenarios, s.nDecisions, s.nTrials, withCi(s.success, pct), pct(s.solved), withCi(s.family, pct), withCi(s.behavior, pct), withCi(s.danger, m), withCi(s.prediction, m)]),
  };
  const proc = {
    head: ["condition", "invalid", "median latency", "tool calls/dec", "hosts", "success per file"],
    rows: c.map(([k, s]) => [k, s.invalid, s.medianLatencyS === null ? "-" : `${num(s.medianLatencyS)} s`, num(s.toolCallsPerDecision), s.hosts.join(", ") || "-", s.perFile.map((f) => pct(f.success)).join(" ")]),
  };
  const cmp = {
    head: ["condition", `vs ${r.baseline}`, "paired scen", "Δ success [95% CI]", "Δ family acc [95% CI]"],
    rows: Object.entries(r.comparisons).map(([k, p]) => [k, r.baseline, p.nScenarios, ppCi(p.success), ppCi(p.family)]),
  };
  return { main, proc, cmp };
}

function textTable({ head, rows }) {
  const all = [head, ...rows].map((r) => r.map(String));
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => r.map((x, i) => (i === 0 ? x.padEnd(w[i]) : x.padStart(w[i]))).join("  ");
  return [line(all[0]), w.map((n) => "-".repeat(n)).join("  "), ...all.slice(1).map(line)].join("\n");
}

const mdTable = ({ head, rows }) => [head, head.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");

function countsLine(r) {
  const t = r.totals;
  return `${t.files} file(s), ${t.scenarios} distinct scenarios, ${t.decisions} decisions, ${t.trials} trials (bootstrap: ${r.bootstrap.resamples} resamples, seed ${r.bootstrap.seed})`;
}

// Bullets that state only what the numbers support.
export function findings(r) {
  const out = [];
  const conds = Object.entries(r.conditions);
  const fmt = (e, f) => `${f(e.value)}, CI ${f(e.ci[0])}–${f(e.ci[1])}`;
  const vsBase = (k, key) => {
    const p = r.comparisons[k]?.[key];
    if (!p || p.value === null) return "";
    return `; difference vs ${r.baseline} is ${sgn(p.value, pp)} (CI ${sgn(p.ci[0], pp)} to ${sgn(p.ci[1], pp)}, ${r.comparisons[k].nScenarios} paired scenarios), ${p.distinguishable ? "distinguishable" : "not distinguishable"} from zero`;
  };
  const best = (list, key) => list.filter(([, s]) => s[key]?.value !== null && s[key]?.ci).sort((a, b) => b[1][key].value - a[1][key].value);
  const bs = best(conds, "success");
  if (bs.length) {
    const [k, s] = bs[0];
    const ties = bs.filter(([, o]) => o.success.value === s.success.value).map(([n]) => n);
    out.push(`${ties.join(", ")} ${ties.length > 1 ? "share" : "has"} the highest trial success rate (${fmt(s.success, pct)})${k === r.baseline ? " — this is the baseline" : vsBase(k, "success")}.`);
  }
  const bf = best(conds.filter(([, s]) => s.model), "family");
  if (bf.length) {
    const [k, s] = bf[0];
    out.push(`${k} has the highest behavior-family accuracy (${fmt(s.family, pct)})${k === r.baseline ? " — this is the baseline" : vsBase(k, "family")}.`);
  }
  const sig = Object.entries(r.comparisons).flatMap(([k, p]) => ["success", "family"].filter((x) => p[x]?.distinguishable).map((x) => `${k} ${x} ${sgn(p[x].value, pp)}`));
  if (r.baseline) out.push(sig.length ? `Paired differences vs ${r.baseline} whose 95% CI excludes zero: ${sig.join("; ")}.` : `No condition differs from ${r.baseline} with a 95% CI that excludes zero, on success or family accuracy.`);
  const sp = conds.find(([, s]) => !s.model)?.[1];
  if (sp?.success.ci) out.push(`Shortest-path comparator succeeds on ${pct(sp.success.value)} of trials (CI ${pct(sp.success.ci[0])}–${pct(sp.success.ci[1])}).`);
  const inv = conds.filter(([, s]) => s.invalid).map(([k, s]) => `${k} ${s.invalid}/${s.nDecisions}`);
  if (inv.length) out.push(`Invalid decisions (scored as failed flights and wrong beliefs): ${inv.join(", ")}.`);
  const maxRep = Math.max(0, ...conds.map(([, s]) => s.nFiles));
  if (maxRep <= 1) out.push("Every condition has a single replicate run: run-to-run variance is not measured, and CIs reflect only scenario/seed sampling.");
  else
    for (const [k, s] of conds.filter(([, s]) => s.nFiles > 1)) {
      const v = s.perFile.map((f) => f.success);
      out.push(`${k}: per-replicate success ranges ${pct(Math.min(...v))}–${pct(Math.max(...v))} over ${s.nFiles} runs.`);
    }
  if (r.totals.scenarios < 30) out.push(`Only ${r.totals.scenarios} distinct scenarios: CIs are wide, and differences inside them should not be reported as effects.`);
  if (r.scenarioConflicts.length) out.push(`Warning: scenario ids ${r.scenarioConflicts.join(", ")} have different definitions across files; paired matching by id may be invalid.`);
  return out;
}

export function renderMarkdown(r) {
  const t = tables(r);
  const parts = [
    "# Findings",
    "",
    `Generated ${r.generatedAt}. Grouped by condition ${r.groupBy}.`,
    "",
    `**Counts:** ${countsLine(r)}.`,
    "",
    "## Outcomes and beliefs",
    "",
    mdTable(t.main),
    "",
    "Success is reached/trials (CI: cluster bootstrap over decisions). Family/behavior accuracy count invalid decisions as wrong. Errors are means over decisions that stated a value.",
    "",
    "## Process",
    "",
    mdTable(t.proc),
  ];
  if (t.cmp.rows.length) parts.push("", `## Paired vs ${r.baseline}`, "", mdTable(t.cmp), "", "Paired by scenario id (replicates averaged, common seeds only); bootstrap over scenarios. `*` = 95% CI excludes zero.");
  parts.push("", "## What the data says", "", ...findings(r).map((b) => `- ${b}`));
  parts.push("", "## Files", "", ...r.files.map((f) => `- included: \`${f.path}\`${f.offline ? " (offline, kept separate)" : ""}`), ...r.excluded.map((x) => `- excluded: \`${x.path}\` — ${x.reason}`));
  return parts.join("\n") + "\n";
}

export function renderText(r) {
  const t = tables(r);
  const parts = [`Counts: ${countsLine(r)}`, "", textTable(t.main), "", textTable(t.proc)];
  if (t.cmp.rows.length) parts.push("", textTable(t.cmp), "(* = 95% CI excludes zero)");
  parts.push("", ...findings(r).map((b) => `- ${b}`), "", ...r.files.map((f) => `included: ${f.path}`), ...r.excluded.map((x) => `excluded: ${x.path} (${x.reason})`));
  return parts.join("\n");
}

// ---- CLI ----

function main(argv) {
  const opts = { out: "sim/recordings/findings", groupBy: "key", baseline: null, includeOffline: false };
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--group-by") opts.groupBy = argv[++i];
    else if (a === "--baseline") opts.baseline = argv[++i];
    else if (a === "--include-offline") opts.includeOffline = true;
    else paths.push(a);
  }
  if (!paths.length || !["key", "label"].includes(opts.groupBy)) {
    console.error("usage: node sim/tools/legacy/report.mjs <file-or-glob>... [--out sim/recordings/findings] [--group-by key|label] [--baseline raw] [--include-offline]");
    process.exit(2);
  }
  const r = buildReport(paths, opts);
  if (!r.totals.decisions) {
    console.error("no usable sessions");
    for (const x of r.excluded) console.error(`excluded: ${x.path} (${x.reason})`);
    process.exit(1);
  }
  console.log(renderText(r));
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(`${opts.out}.json`, JSON.stringify(r, null, 2) + "\n");
  fs.writeFileSync(`${opts.out}.md`, renderMarkdown(r));
  console.log(`\nwrote ${opts.out}.json and ${opts.out}.md`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
