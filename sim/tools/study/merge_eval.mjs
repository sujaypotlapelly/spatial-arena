// Merge evaluation conditions from several sessions run on the same held-out
// set into the first session (which keeps its training, strategy, rematch).
// Conditions already present in an earlier file are kept from that file.
//   node sim/tools/study/merge_eval.mjs out.json base.json extra1.json [extra2.json ...]
import fs from "node:fs";

const [out, base, ...extras] = process.argv.slice(2);
if (!out || !base || !extras.length) throw new Error("usage: merge_eval.mjs out.json base.json extra.json ...");
const s = JSON.parse(fs.readFileSync(base));
if (!s.evaluation) throw new Error(`${base} has no evaluation`);
const ids = (sess) => [...new Set(sess.evaluation.episodes.map((e) => e.scenario.id))].sort().join();
for (const f of extras) {
  const x = JSON.parse(fs.readFileSync(f));
  if (!x.evaluation) throw new Error(`${f} has no evaluation`);
  if (x.usingModel !== s.usingModel) throw new Error(`${f} usingModel differs from ${base}; refusing to mix Ripple and offline results`);
  if (ids(x) !== ids(s)) throw new Error(`${f} was run on a different held-out set`);
  const have = new Set(s.evaluation.conditions.map((c) => c.key));
  for (const c of x.evaluation.conditions) {
    if (have.has(c.key)) continue;
    s.evaluation.conditions.push(c);
    s.evaluation.episodes.push(...x.evaluation.episodes.filter((e) => e.condition === c.key));
    s.evaluation.metrics[c.key] = x.evaluation.metrics[c.key];
    console.log(`added ${c.key} from ${f}`);
  }
  if (s.ledger && x.ledger) for (const k of Object.keys(s.ledger)) s.ledger[k] = (s.ledger[k] || 0) + (x.ledger[k] || 0);
}
s.mergedFrom = [base, ...extras];
fs.writeFileSync(out, JSON.stringify(s));
console.log(`wrote ${out}: ${s.evaluation.conditions.map((c) => c.key).join(", ")}`);
