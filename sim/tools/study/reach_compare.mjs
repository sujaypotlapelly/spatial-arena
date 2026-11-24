// Paired comparison of two Reach runs at one control level: step 5 of the
// harness loop. Episodes are matched on scenario + seed; differences are
// bootstrapped over scenarios. With --log, appends a row to
// docs/HARNESS_CHANGELOG.md (kept or reverted, decided by the rule: keep only
// if the paired 95% CI of the primary metric excludes zero, in favour).
//   node sim/tools/study/reach_compare.mjs runs/reach/ladder-v0-dev runs/reach/iter-rel ripple@C3 \
//     --change "rel: goal as relative vector + compass word" --log
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const [aDir, bDir, cond] = process.argv.slice(2);
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const load = (d, k) => fs.readFileSync(path.join(d, "episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.condition === k);
// --cond-b: compare different controllers on the same episodes (e.g. ripple@C3 vs program@C3).
const A = load(aDir, cond), B = load(bDir, opt("--cond-b", cond));
const key = (e) => `${e.scenario}/${e.seed}`;
const bmap = Object.fromEntries(B.map((e) => [key(e), e]));
const pairs = A.filter((e) => bmap[key(e)]).map((e) => ({ scenario: e.scenario, a: e, b: bmap[key(e)] }));
if (!pairs.length) throw new Error("no paired episodes");

const metrics = {
  reached: (e) => (e.result.outcome === "reached" ? 1 : 0),
  progress: (e) => e.progress,
  contactsPerMin: (e) => e.result.contacts / (e.result.time / 60),
};
function pairedBoot(f, B_ = 2000) {
  const by = Object.values(Object.groupBy(pairs, (p) => p.scenario));
  const d = (ps) => ps.reduce((s, p) => s + f(p.b) - f(p.a), 0) / ps.length;
  let s = 777;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const vals = [];
  for (let i = 0; i < B_; i++) vals.push(d(by.flatMap(() => by[Math.floor(rand() * by.length)])));
  vals.sort((x, y) => x - y);
  return { delta: d(pairs), ci: [vals[Math.floor(0.025 * B_)], vals[Math.floor(0.975 * B_)]], a: pairs.reduce((s2, p) => s2 + f(p.a), 0) / pairs.length, b: pairs.reduce((s2, p) => s2 + f(p.b), 0) / pairs.length };
}
const res = Object.fromEntries(Object.entries(metrics).map(([k, f]) => [k, pairedBoot(f)]));
const fmt = (k, r) => (k === "contactsPerMin" ? `${r.a.toFixed(1)} → ${r.b.toFixed(1)} (Δ ${r.delta.toFixed(1)} [${r.ci[0].toFixed(1)}, ${r.ci[1].toFixed(1)}])` : `${Math.round(r.a * 100)}% → ${Math.round(r.b * 100)}% (Δ ${Math.round(r.delta * 100)} pp [${Math.round(r.ci[0] * 100)}, ${Math.round(r.ci[1] * 100)}])`);
console.log(`${cond}: ${pairs.length} paired episodes (${new Set(pairs.map((p) => p.scenario)).size} scenarios)`);
for (const [k, r] of Object.entries(res)) console.log(`  ${k.padEnd(15)} ${fmt(k, r)}`);
// Primary metric: progress toward the goal (reached is too sparse at low success).
const primary = opt("--primary", "progress");
const p = res[primary];
const verdict = p.ci[0] > 0 ? "KEEP" : "revert";
console.log(`  verdict on ${primary}: ${verdict}`);
if (args.includes("--log")) {
  const f = path.join(root, "docs/HARNESS_CHANGELOG.md");
  if (!fs.existsSync(f))
    fs.writeFileSync(f, `# Harness changelog (generated rows)\n\nEvery harness change tried, kept or not. Rule: one change at a time on the dev set, paired by scenario + seed, and keep only if the paired 95% CI of the primary metric (progress toward the goal) excludes zero in favour. Rows are appended by \`sim/tools/study/reach_compare.mjs --log\`.\n\n| Date | Env · level | Change | From → to run | n | Reached | Progress (primary) | Wall contacts / min | Verdict |\n|---|---|---|---|---|---|---|---|---|\n`);
  fs.appendFileSync(f, `| ${new Date().toISOString().slice(0, 10)} | reach · ${cond}${opt("--cond-b") ? " → " + opt("--cond-b") : ""} | ${opt("--change", "?")} | \`${path.relative(root, aDir)}\` → \`${path.relative(root, bDir)}\` | ${pairs.length} | ${fmt("reached", res.reached)} | ${fmt("progress", res.progress)} | ${fmt("contactsPerMin", res.contactsPerMin)} | **${verdict}** |\n`);
  console.log("logged to docs/HARNESS_CHANGELOG.md");
}
