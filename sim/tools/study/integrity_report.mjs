// Tables for docs/RESULTS_INTEGRITY.md from the dev sweeps flown by
// reach_eval.mjs --wind / --noise (runs/integrity/<level>). Reads recorded
// results only. Each level is compared with the no-perturbation run on the
// same routes and wind seeds (paired, bootstrap over routes).
//   node sim/tools/study/integrity_report.mjs --runs <checkout>/runs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootCI, mean } from "../reach_metrics.mjs";
import { rng } from "../../src/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const RUNS = path.resolve(opt("--runs", path.join(here, "../../../runs")));
const D = path.join(RUNS, "integrity");
const load = (dir) => fs.readFileSync(path.join(D, dir, "episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((e) => ({ condition: e.condition, scenario: e.scenario, seed: e.seed, reached: e.result.outcome === "reached" ? 1 : 0, progress: e.progress, contacts: e.result.contacts, replayOk: e.replayOk }));
const NAMES = { "program@C3": "Program (cap2/run3)", "reactive@C3": "Avoider, hand-written", "straight@C2": "Straight-line flyer" };
const rate = (rs) => mean(rs.map((r) => r.reached));
function pairedDelta(base, other, B = 10000, seed = 919) {
  const bm = Object.fromEntries(base.map((r) => [`${r.scenario}/${r.seed}`, r.reached]));
  const pairs = other.map((r) => ({ scenario: r.scenario, d: r.reached - bm[`${r.scenario}/${r.seed}`] }));
  const by = Object.values(Object.groupBy(pairs, (p) => p.scenario));
  const rand = rng(seed).next;
  const vals = [];
  for (let i = 0; i < B; i++) vals.push(mean(by.flatMap(() => by[Math.floor(rand() * by.length)]).map((p) => p.d)));
  vals.sort((a, b) => a - b);
  return { delta: mean(pairs.map((p) => p.d)), ci: [vals[Math.floor(0.025 * B)], vals[Math.floor(0.975 * B)]] };
}
const pct = (x) => `${Math.round(x * 100)}%`;
const pp = (x) => `${x >= 0 ? "+" : "-"}${Math.abs(Math.round(x * 100))}`;
// Routes on which every wind seed gave the same outcome.
const agree = (rs) => { const by = Object.values(Object.groupBy(rs, (r) => r.scenario)); return `${by.filter((g) => g.every((r) => r.reached === g[0].reached)).length}/${by.length}`; };

function table(levels, label) {
  const base = load(levels[0][1]);
  const lines = [`| ${label} | Controller | Reached | 95% CI | Change vs none [95% CI] | Progress | Routes with the same outcome on all 6 seeds | Exact replays |`, "|---|---|---|---|---|---|---|---|"];
  const json = [];
  for (const [lvl, dir] of levels) {
    const rows = load(dir);
    for (const c of Object.keys(NAMES)) {
      const rs = rows.filter((r) => r.condition === c), bs = base.filter((r) => r.condition === c);
      const d = pairedDelta(bs, rs);
      const ci = bootCI(rs, rate);
      json.push({ level: lvl, controller: c, reached: rs.filter((r) => r.reached).length, flights: rs.length, rate: rate(rs), ci, delta: d.delta, deltaCI: d.ci, progress: mean(rs.map((r) => r.progress)), sameAllSeeds: agree(rs), replayOk: rs.filter((r) => r.replayOk).length });
      lines.push(`| ${lvl} | ${NAMES[c]} | ${rs.filter((r) => r.reached).length}/${rs.length} = ${pct(rate(rs))} | ${pct(ci[0])}-${pct(ci[1])} | ${lvl === levels[0][0] ? "" : `${pp(d.delta)} pp [${pp(d.ci[0])}, ${pp(d.ci[1])}]`} | ${pct(mean(rs.map((r) => r.progress)))} | ${agree(rs)} | ${rs.filter((r) => r.replayOk).length}/${rs.length} |`);
    }
  }
  return { md: lines.join("\n"), json };
}
const wind = table([["none (published gusts)", "wind-none"], ["light", "wind-light"], ["moderate", "wind-moderate"], ["strong", "wind-strong"]], "Wind");
const noise = table([["none", "wind-none"], ["low", "noise-low"], ["medium", "noise-medium"], ["high", "noise-high"], ["severe", "noise-severe"], ["moderate wind + medium noise", "wind-moderate-noise-medium"]], "Sensor noise");
console.log(wind.md + "\n\n" + noise.md);
fs.writeFileSync(path.join(D, "tables.md"), `## Wind\n\n${wind.md}\n\n## Sensor noise\n\n${noise.md}\n`);
fs.writeFileSync(path.join(D, "sweeps.json"), JSON.stringify({ at: new Date().toISOString(), wind: wind.json, noise: noise.json }, null, 1));
