// Tables for the transfer study write-up, from transfer_matrix.mjs outputs (local only).
//   node sim/tools/transfer_report.mjs --dir runs/transfer-v2
// Reads <dir>/matrix, <dir>/diagnostic and, when present, <dir>/mix-eval.
// Prints markdown. Intervals are 95% bootstraps over routes (both wind seeds
// of a route resampled together); paired differences resample routes too.
import fs from "node:fs";
import path from "node:path";
import { clusterCI } from "./transfer_matrix.mjs";

const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const dir = path.resolve(opt("--dir", "runs/transfer-v2"));
const load = (sub) => {
  const f = path.join(dir, sub, "episodes.jsonl");
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
};
let MAPS = ["factory", "canyon", "residential", "building"];
const NAME = new Proxy({ factory: "factory", canyon: "canyon", residential: "cottages", building: "2nd building" }, { get: (o, k) => o[k] ?? k });
const ok = (r) => r.result.outcome === "reached";
const rate = (rs) => rs.filter(ok).length / rs.length;
const pct = (x) => `${Math.round(x * 100)}%`;
const cell = (rs) => { const [lo, hi] = clusterCI(rs, rate); return `${rs.filter(ok).length}/${rs.length} (${pct(rate(rs))}, ${pct(lo)}-${pct(hi)})`; };
const pick = (rows, agent, map) => rows.filter((r) => r.agent === agent && r.map === map);
const table = (rows, agents, label = (a) => a) => {
  const out = [`| program | ${MAPS.map((m) => NAME[m]).join(" | ")} |`, `|---|${MAPS.map(() => "---").join("|")}|`];
  for (const a of agents) out.push(`| ${label(a)} | ${MAPS.map((m) => { const rs = pick(rows, a, m); return rs.length ? cell(rs) : "-"; }).join(" | ")} |`);
  return out.join("\n");
};
const classes = (rows, agents) => {
  const C = ["altitude", "stuck", "timeout", "error"];
  const out = [`| program | flown in | failed | ${C.join(" | ")} |`, `|---|---|---|${C.map(() => "---").join("|")}|`];
  for (const a of agents) for (const m of MAPS) {
    const rs = pick(rows, a, m).filter((r) => !ok(r));
    if (rs.length >= 12) out.push(`| ${a} | ${NAME[m]} | ${rs.length} | ${C.map((c) => rs.filter((r) => r.cls === c).length).join(" | ")} |`);
  }
  return out.join("\n");
};
// Paired difference a - b on the same flights (route, seed), bootstrap over routes.
const paired = (rows, a, b, m) => {
  const A = pick(rows, a, m), B = new Map(pick(rows, b, m).map((r) => [`${r.scenario}|${r.seed}`, r]));
  const pairs = A.filter((r) => B.has(`${r.scenario}|${r.seed}`)).map((r) => ({ scenario: r.scenario, seed: r.seed, d: (ok(r) ? 1 : 0) - (ok(B.get(`${r.scenario}|${r.seed}`)) ? 1 : 0) }));
  if (!pairs.length) return "-";
  const mean = (ps) => ps.reduce((x, p) => x + p.d, 0) / ps.length;
  const [lo, hi] = clusterCI(pairs, mean);
  const f = (x) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}`;
  return `${f(mean(pairs))} [${f(lo)}, ${f(hi)}]`;
};

const M = load("matrix");
if (!M) throw new Error(`${dir}/matrix/episodes.jsonl missing`);
const print = (s = "") => console.log(s);
const REFS = ["straight", "reactive", "tuned-factory", "tuned-canyon", "tuned-residential"];
print("## A. Selected programs and baselines on dev\n");
print(table(M, ["SEL-factory", "SEL-canyon", "SEL-residential", ...REFS]));

print("\n## A2. All 72 practice programs (24 per environment), pooled\n");
const progAgents = [...new Set(M.map((r) => r.agent))].filter((a) => /^(factory|canyon|residential)-/.test(a));
const outAlt = (a) => ["canyon", "residential"].reduce((x, m) => x + pick(M, a, m).filter((r) => r.cls === "altitude").length, 0);
const out2 = [`| written in | programs | ${MAPS.map((m) => NAME[m]).join(" | ")} |`, `|---|---|${MAPS.map(() => "---").join("|")}|`];
for (const src of ["factory", "canyon", "residential"]) for (const grp of ["all", "height-locked", "other"]) {
  const as = progAgents.filter((a) => a.startsWith(src + "-") && (grp === "all" || (grp === "height-locked") === (outAlt(a) >= 48)));
  if (!as.length) continue;
  out2.push(`| ${NAME[src]}, ${grp} | ${as.length} | ${MAPS.map((m) => { const rs = M.filter((r) => as.includes(r.agent) && r.map === m); return `${rs.filter(ok).length}/${rs.length} (${pct(rate(rs))})`; }).join(" | ")} |`);
}
print(out2.join("\n"));
print("\nHeight-locked: at least half of its 96 outdoor dev flights (canyon plus cottages) classified as altitude failures.");

print("\n## B. Failure classes (cells with at least 12 failed flights)\n");
print(classes(M, ["SEL-factory", "SEL-canyon", "SEL-residential"]));

const D = load("diagnostic");
if (D) {
  print("\n## B2. Altitude diagnostic (hand-patched copies, NOT results)\n");
  print(table(D, ["SEL-factory", "DIAG-ground", "DIAG-ground-goal"]));
}

const X = load("mix-eval");
if (X) {
  const mixAgents = [...new Set(X.map((r) => r.agent))].filter((a) => a.startsWith("MIX"));
  print("\n## E. Mixed practice (factory + canyon train routes) on dev\n");
  print(table(X, [...mixAgents, "SEL-factory", "SEL-canyon", "SEL-residential", "tuned-factory", "reactive"]));
  print("\n### Failure classes\n");
  print(classes(X, mixAgents));
  print("\n### Paired differences, MIX-selected minus each single-place program (points, 95% interval over routes)\n");
  const others = ["SEL-factory", "SEL-canyon", "SEL-residential", "tuned-factory"];
  print(`| compared with | ${MAPS.map((m) => NAME[m]).join(" | ")} |`);
  print(`|---|${MAPS.map(() => "---").join("|")}|`);
  for (const b of others) print(`| ${b} | ${MAPS.map((m) => paired(X, "MIX-selected", b, m)).join(" | ")} |`);
}

// ---------- selection rules, compared on existing programs ----------
// Needs <dir>/matrix-train (every program on every place's TRAIN routes, first
// wind seed, as in practice). Each rule ranks the 24 programs written in one
// place by a practice score (reached, then mean progress) and we report the dev
// results of its top pick and the mean of its top 3. Dev data plays no part in
// the ranking.
const T = load("matrix-train");
if (T) {
  const P = ["factory", "canyon", "residential"];
  const tr = {}, dv = {};
  for (const r of T) { const k = `${r.agent}|${r.map}`; const c = (tr[k] ??= { n: 0, ok: 0, pr: 0 }); c.n++; c.ok += ok(r) ? 1 : 0; c.pr += r.progress; }
  for (const r of M) { const k = `${r.agent}|${r.map}`; const c = (dv[k] ??= { n: 0, ok: 0 }); c.n++; c.ok += ok(r) ? 1 : 0; }
  const sum = (a, ps) => ({ ok: ps.reduce((x, m) => x + tr[`${a}|${m}`].ok, 0), pr: ps.reduce((x, m) => x + tr[`${a}|${m}`].pr / tr[`${a}|${m}`].n, 0) });
  const worst = (a, ps) => ({ ok: Math.min(...ps.map((m) => tr[`${a}|${m}`].ok)), pr: Math.min(...ps.map((m) => tr[`${a}|${m}`].pr / tr[`${a}|${m}`].n)) });
  const dev = (a) => MAPS.map((m) => dv[`${a}|${m}`].ok);
  print("\n## D2. Selection rules on the existing 72 programs (practice scores choose; dev results shown)\n");
  print(`| written in | rule (practice routes used to choose) | pick | ${MAPS.map((m) => NAME[m]).join(" | ")} | top-3 mean |`);
  print(`|---|---|---|${MAPS.map(() => "---").join("|")}|---|`);
  for (const X of P) {
    const as = [...new Set(T.map((r) => r.agent))].filter((a) => a.startsWith(X + "-"));
    const rules = [[`own: ${NAME[X]}`, (a) => sum(a, [X])]];
    for (const Y of P.filter((y) => y !== X)) {
      rules.push([`pooled: ${NAME[X]} + ${NAME[Y]}`, (a) => sum(a, [X, Y])]);
      rules.push([`worst of ${NAME[X]}, ${NAME[Y]}`, (a) => worst(a, [X, Y])]);
      rules.push([`held-back place only: ${NAME[Y]}`, (a) => sum(a, [Y])]);
    }
    rules.push(["pooled: all three", (a) => sum(a, P)]);
    for (const [name, f] of rules) {
      const r = as.map((a) => ({ a, s: f(a) })).sort((x, y) => y.s.ok - x.s.ok || y.s.pr - x.s.pr);
      const top3 = MAPS.map((_, i) => Math.round(r.slice(0, 3).reduce((x, o) => x + dev(o.a)[i], 0) / 3));
      print(`| ${NAME[X]} | ${name} | ${r[0].a.replace(`${X}-`, "")} | ${dev(r[0].a).map((x) => `${x}/48`).join(" | ")} | ${top3.join(" / ")} |`);
    }
  }
}

// ---------- newly admitted outdoor places (dev), where no program practised ----------
const N = load("new-places-dev");
if (N) {
  MAPS = [...new Set(N.map((r) => r.map))];
  const ags = [...new Set(N.map((r) => r.agent))];
  print("\n## G. Newly admitted outdoor places (dev routes; no program practised in any of them)\n");
  print(table(N, ags));
  print("\n### Paired differences, MIX-selected minus each program (points, 95% interval over routes)\n");
  print(`| compared with | ${MAPS.map((m) => NAME[m]).join(" | ")} |`);
  print(`|---|${MAPS.map(() => "---").join("|")}|`);
  for (const b of ["SEL-factory", "SEL-canyon", "SEL-residential", "tuned-factory"]) if (ags.includes(b)) print(`| ${b} | ${MAPS.map((m) => paired(N, "MIX-selected", b, m)).join(" | ")} |`);
  print("\n### Altitude failures (of 48 flights)\n");
  print(`| program | ${MAPS.map((m) => NAME[m]).join(" | ")} |`);
  print(`|---|${MAPS.map(() => "---").join("|")}|`);
  for (const a of ags) print(`| ${a} | ${MAPS.map((m) => pick(N, a, m).filter((r) => r.cls === "altitude").length).join(" | ")} |`);
}
