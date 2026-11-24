// Wall-contact audit for Reach (P0, offline, no API calls). Contact only
// slows the drone, so a controller can "win" by sliding along walls. This
// re-flies every episode from its recorded commands and re-scores it as if
// touching geometry mattered:
//   reached          the current metric
//   reached-clean    contact = crash: reached with zero contacts
//   reached-≤3       reached with at most 3 contacts
//   progress-to-1st  progress toward the goal before the first contact
//   touching         share of physics ticks spent in contact (wall sliding)
// Then paired comparisons (by scenario + seed, bootstrap over scenarios)
// between any conditions given with --pair A:B.
//   node sim/tools/study/reach_contact_audit.mjs runs/reach/heldout-baselines runs/reach/heldout-ripple-v0 \
//     runs/reach/heldout-program-run2 --pair reactive@C3:program@C3 --pair ripple@C3:program@C3
import path from "node:path";
import fs from "node:fs";
import { loadReach, auditEpisode, mean } from "../reach_metrics.mjs";

const { world, scen } = loadReach();
const args = process.argv.slice(2);
const pairs = args.flatMap((a, i) => (args[i - 1] === "--pair" ? [a.split(":")] : []));
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const dirs = args.filter((a, i) => !a.startsWith("--") && !["--pair", "--json"].includes(args[i - 1]));
const audit = (e) => auditEpisode(world, scen, e);

const rows = [];
for (const dir of dirs) {
  const f = path.join(dir, "episodes.jsonl");
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").trim().split("\n")) {
    const e = JSON.parse(line);
    if (e.level === "C1") continue; // A* flies C1; wall sliding is not the controller's
    rows.push({ run: path.basename(dir), condition: e.condition, scenario: e.scenario, seed: e.seed, ...audit(e) });
  }
}

const pct = (x) => `${Math.round(100 * x)}%`;
console.log("run / condition                          n  exact  reached  reached-clean  reached-≤3  progress  progress-to-1st  contacts/ep  contacts/min  touching");
const groups = Object.groupBy(rows, (r) => `${r.run} ${r.condition}`);
for (const [k, rs] of Object.entries(groups))
  console.log(`${k.padEnd(38)} ${String(rs.length).padStart(3)}  ${String(rs.filter((r) => r.exact).length).padStart(5)}  ${pct(mean(rs.map((r) => r.reached))).padStart(7)}  ${pct(mean(rs.map((r) => r.clean))).padStart(13)}  ${pct(mean(rs.map((r) => r.le3))).padStart(10)}  ${pct(mean(rs.map((r) => r.progress))).padStart(8)}  ${pct(mean(rs.map((r) => r.progressFirst))).padStart(15)}  ${mean(rs.map((r) => r.contacts)).toFixed(1).padStart(11)}  ${mean(rs.map((r) => r.perMin)).toFixed(1).padStart(12)}  ${pct(mean(rs.map((r) => r.touching))).padStart(8)}`);

function pairedBoot(A, B, f, n = 2000) {
  const bmap = Object.fromEntries(B.map((r) => [`${r.scenario}/${r.seed}`, r]));
  const ps = A.filter((r) => bmap[`${r.scenario}/${r.seed}`]).map((r) => ({ s: r.scenario, d: f(bmap[`${r.scenario}/${r.seed}`]) - f(r) }));
  const by = Object.values(Object.groupBy(ps, (p) => p.s));
  let seed = 777;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const vals = [];
  for (let i = 0; i < n; i++) vals.push(mean(by.flatMap(() => by[Math.floor(rand() * by.length)]).map((p) => p.d)));
  vals.sort((x, y) => x - y);
  return { n: ps.length, delta: mean(ps.map((p) => p.d)), lo: vals[Math.floor(0.025 * n)], hi: vals[Math.floor(0.975 * n)] };
}
const out = { groups: {}, pairs: [] };
for (const [k, rs] of Object.entries(groups)) out.groups[k] = Object.fromEntries(["reached", "clean", "le3", "progress", "progressFirst", "contacts", "perMin", "touching"].map((m) => [m, mean(rs.map((r) => r[m]))]));
if (pairs.length) {
  console.log("\nPaired (B − A), 95% bootstrap CI over scenarios");
  for (const [a, b] of pairs) {
    const A = rows.filter((r) => r.condition === a), B = rows.filter((r) => r.condition === b);
    for (const m of ["reached", "clean", "le3", "progress", "progressFirst", "touching"]) {
      const r = pairedBoot(A, B, (x) => x[m]);
      out.pairs.push({ a, b, metric: m, ...r });
      console.log(`  ${b} vs ${a}  ${m.padEnd(14)} n=${r.n}  Δ ${Math.round(100 * r.delta)} pp [${Math.round(100 * r.lo)}, ${Math.round(100 * r.hi)}]`);
    }
  }
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2));
