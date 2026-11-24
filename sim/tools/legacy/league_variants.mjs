// Turns a league directory into a duel_eval.mjs --variants file: one drone
// controller per (run, generation) plus the three pre-registered controls.
//   node sim/tools/legacy/league_variants.mjs runs/league/main --gens 0,2,4,8 > runs/league/main/variants.json
// Controls (drone side, matched to the final generation):
//   nonotes          gen 0 (no notes), sampled once per run like the others
//   placebo.r<k>     generic advice cut to the word count of run k's final notes
//   shuffled.r<k>    run k evaluated with run (k+1)'s final notes
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dir = path.resolve(args[0]);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const runs = fs.readdirSync(dir).filter((d) => /^run\d+$/.test(d)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
const lastGen = Math.max(...fs.readdirSync(path.join(dir, runs[0])).map((f) => /^gen(\d+)-drone\.json$/.exec(f)?.[1]).filter(Boolean).map(Number));
const gens = (opt("--gens") || `0,${lastGen}`).split(",").map(Number).filter((g) => g <= lastGen);
const placebo = fs.readFileSync(path.join(here, "../../scenarios/placebo-notes.txt"), "utf8").trim().split(/\s+/);

const out = { drone: {}, bird: {} };
for (const r of runs) {
  const k = Number(r.slice(3));
  for (const g of gens) out.drone[`g${g}.r${k}`] = g === 0 ? null : path.join(dir, r, `gen${g}-drone.json`);
  const final = JSON.parse(fs.readFileSync(path.join(dir, r, `gen${lastGen}-drone.json`))).text || "";
  const words = final.split(/\s+/).filter(Boolean).length;
  const pf = path.join(dir, r, "placebo-drone.json");
  const text = Array.from({ length: words }, (_, i) => placebo[i % placebo.length]).join(" ");
  fs.writeFileSync(pf, JSON.stringify({ text, matchedWords: words }));
  out.drone[`placebo.r${k}`] = pf;
  const other = runs[(runs.indexOf(r) + 1) % runs.length];
  if (other !== r) out.drone[`shuffled.r${k}`] = path.join(dir, other, `gen${lastGen}-drone.json`);
}
process.stdout.write(JSON.stringify(out, null, 1));
