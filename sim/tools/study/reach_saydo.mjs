// Say/do audit for Reach (P0, offline, no API calls). Asks what the
// "says one direction, commands another" rate actually measures:
//   1. Parser artifact? Compare the old first-word parser with one that reads
//      only the movement clause and combines words ("east and north" = NE).
//   2. Axis convention? For each disagreement, test whether reading the
//      vector under another convention reconciles it: z flipped (north = -z,
//      the three.js/screen convention), x flipped, or [east, north, up]
//      (north in the middle slot, the z-up habit).
//   3. Which channel is right? Score the stated word, the emitted vector and
//      the model's own predicted displacement against the goal bearing and
//      against the best free direction toward the goal at that moment.
// Two random headings agree within 67.5 deg 37.5% of the time; that is the
// chance line for every agreement rate below.
//   node sim/tools/study/reach_saydo.mjs runs/reach/c3s2-v0 runs/reach/c3-v0-repeat*
//   node sim/tools/study/reach_saydo.mjs --json out.json runs/reach/...
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../../src/world.js";
import { clearance } from "../../src/gym/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const world = new World(JSON.parse(fs.readFileSync(path.join(here, "../../maps/factory-full.json"))));
const sets = JSON.parse(fs.readFileSync(path.join(here, "../../scenarios/reach-factory.json")));
const scen = Object.fromEntries([...sets.train, ...sets.dev, ...sets.heldout].map((s) => [s.id, s]));
const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const dirs = args.filter((a, i) => a !== "--json" && args[i - 1] !== "--json");

const TOL = 67.5; // same tolerance as reach_diagnose.mjs
const angOf = (dx, dz) => (Math.atan2(dz, dx) * 180) / Math.PI; // from +x (east) toward +z (north)
const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const agree = (a, b) => a !== null && b !== null && diff(a, b) <= TOL;

// ---- parsers ----
const LEGACY = { "north-east": 45, northeast: 45, "north-west": 135, northwest: 135, "south-east": -45, southeast: -45, "south-west": -135, southwest: -135, north: 90, south: -90, east: 0, west: 180 };
const norm = (s) => (s || "").toLowerCase().replace(/north[\s_-]?east/g, "northeast").replace(/north[\s_-]?west/g, "northwest").replace(/south[\s_-]?east/g, "southeast").replace(/south[\s_-]?west/g, "southwest");
function legacyParse(say) {
  const s = norm(say);
  for (const [w, a] of Object.entries(LEGACY)) if (new RegExp(`\\b${w}\\b`).test(s)) return a;
  return null;
}
// Movement clause only: cut at the first reason/contrast marker, so
// "west and south because east and north are blocked" reads as SW.
const UNIT = { northeast: 45, northwest: 135, southeast: -45, southwest: -135, north: 90, south: -90, east: 0, west: 180 };
function clauseParse(say) {
  const s = norm(say).split(/\b(?:because|since|as|but|avoid\w*|blocked|until|while|then|watch\w*|keeping|keep)\b|[;,—:(]/)[0];
  const words = s.match(/\b(northeast|northwest|southeast|southwest|north|south|east|west)\b/g);
  if (!words) return null;
  let x = 0, z = 0;
  for (const w of new Set(words)) {
    x += Math.cos((UNIT[w] * Math.PI) / 180);
    z += Math.sin((UNIT[w] * Math.PI) / 180);
  }
  return Math.hypot(x, z) < 0.3 ? null : angOf(x, z); // "north and south" -> no direction
}

// ---- vector readings ----
const READINGS = {
  as_prompted: (v) => [v[0], v[2]], // +x east, +z north (what the prompt says)
  z_flipped: (v) => [v[0], -v[2]], // north = -z
  x_flipped: (v) => [-v[0], v[2]],
  east_north_up: (v) => [v[0], v[1]], // [east, north, up]
};
const COMPASS = { east: 0, north_east: 45, north: 90, north_west: 135, west: 180, south_west: -135, south: -90, south_east: -45 };
function bestFree(pos, goalAng) {
  const c = clearance(world, pos, 0.25, 12);
  let best = null;
  for (const [k, a] of Object.entries(COMPASS)) {
    if (c[k] < 1.5) continue;
    const score = Math.cos(((a - goalAng) * Math.PI) / 180) + (0.6 * Math.min(c[k], 4)) / 4;
    if (!best || score > best.score) best = { a, score };
  }
  return best ? best.a : null;
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : "–");
const report = {};
for (const dir of dirs) {
  const f = path.join(dir, "episodes.jsonl");
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").trim().split("\n")) {
    const e = JSON.parse(line);
    if (e.ctl !== "ripple" || !["C2", "C3"].includes(e.level)) continue;
    const key = `${e.condition} ${path.basename(dir)}`;
    const R = (report[key] ??= { n: 0, saidLegacy: 0, mismLegacy: 0, said: 0, mism: 0, reconciled: Object.fromEntries(Object.keys(READINGS).map((k) => [k, 0])), agreeAll: Object.fromEntries(Object.keys(READINGS).map((k) => [k, 0])), sayGoal: 0, vecGoal: 0, predGoal: 0, predN: 0, sayFree: 0, vecFree: 0, freeN: 0, predSay: 0, predVec: 0, predSayN: 0, vertical: 0 });
    const goal = world.nodes[scen[e.scenario].goal];
    for (const d of e.decisionLog) {
      const fr = e.frames.find((x) => x[0] >= d.t - 1e-6) || e.frames[e.frames.length - 1];
      const pos = [fr[1], fr[2], fr[3]];
      let vec = null;
      if (e.level === "C3" && Array.isArray(d.command.velocity)) vec = d.command.velocity;
      if (e.level === "C2" && Array.isArray(d.command.target)) vec = [d.command.target[0] - pos[0], d.command.target[1] - pos[1], d.command.target[2] - pos[2]];
      if (!vec || Math.hypot(vec[0], vec[2]) < 0.2) continue;
      R.n++;
      if (Math.abs(vec[1]) > Math.hypot(vec[0], vec[2])) R.vertical++;
      const vAng = angOf(vec[0], vec[2]);
      const gAng = angOf(goal[0] - pos[0], goal[2] - pos[2]);
      const free = bestFree(pos, gAng);
      const lw = legacyParse(d.say);
      if (lw !== null) {
        R.saidLegacy++;
        if (!agree(lw, vAng)) R.mismLegacy++;
      }
      const w = clauseParse(d.say);
      if (w !== null) {
        R.said++;
        const ok = agree(w, vAng);
        if (!ok) {
          R.mism++;
          for (const [k, fn] of Object.entries(READINGS)) {
            const [a, b] = fn(vec);
            if (k !== "as_prompted" && Math.hypot(a, b) > 0.2 && agree(w, angOf(a, b))) R.reconciled[k]++;
          }
        }
        for (const [k, fn] of Object.entries(READINGS)) {
          const [a, b] = fn(vec);
          if (Math.hypot(a, b) > 0.2 && agree(w, angOf(a, b))) R.agreeAll[k]++;
        }
        (R.rows ??= []).push({ w, vec, gAng, free, ok });
        if (agree(w, gAng)) R.sayGoal++;
        if (agree(vAng, gAng)) R.vecGoal++;
        if (free !== null) {
          R.freeN++;
          if (agree(w, free)) R.sayFree++;
          if (agree(vAng, free)) R.vecFree++;
        }
        const p = d.prediction?.position;
        if (Array.isArray(p) && p.length === 3 && Math.hypot(p[0] - pos[0], p[2] - pos[2]) > 0.3) {
          const pAng = angOf(p[0] - pos[0], p[2] - pos[2]);
          R.predSayN++;
          if (agree(pAng, w)) R.predSay++;
          if (agree(pAng, vAng)) R.predVec++;
          if (agree(pAng, gAng)) R.predGoal++;
        }
      }
    }
  }
}

console.log("Say/do audit. Agreement = within 67.5 deg; chance = 37.5%.\n");
console.log("run                                   moves  says≠does old parser  says≠does clause parser   of those, reconciled by: z-flip  x-flip  [E,N,U]");
for (const [k, R] of Object.entries(report))
  console.log(`${k.padEnd(37)} ${String(R.n).padStart(5)}  ${pct(R.mismLegacy, R.saidLegacy).padStart(5)} of ${String(R.saidLegacy).padEnd(5)}        ${pct(R.mism, R.said).padStart(5)} of ${String(R.said).padEnd(5)}              ${pct(R.reconciled.z_flipped, R.mism).padStart(6)}  ${pct(R.reconciled.x_flipped, R.mism).padStart(6)}  ${pct(R.reconciled.east_north_up, R.mism).padStart(6)}`);
console.log("\nWhich channel is right? (decisions with a parsed word)");
console.log("run                                   word→goal  vector→goal  prediction→goal   word→best-free  vector→best-free   prediction agrees with: word  vector");
for (const [k, R] of Object.entries(report))
  console.log(`${k.padEnd(37)} ${pct(R.sayGoal, R.said).padStart(8)}  ${pct(R.vecGoal, R.said).padStart(10)}  ${pct(R.predGoal, R.predSayN).padStart(14)}   ${pct(R.sayFree, R.freeN).padStart(13)}  ${pct(R.vecFree, R.freeN).padStart(15)}   ${pct(R.predSay, R.predSayN).padStart(26)}  ${pct(R.predVec, R.predSayN).padStart(6)}`);
// Null: shuffle the words across decisions within a run (seeded), then ask
// how often each re-reading "reconciles" a mismatch by chance. Also split
// the real mismatches: which channel was pointing somewhere sensible?
console.log("\nMismatches only, against a shuffled-word null (same run, words permuted across decisions)");
console.log("run                                   z-flip real / null   x-flip real / null   [E,N,U] real / null   word→goal  vector→goal  word→best-free  vector→best-free");
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
for (const [k, R] of Object.entries(report)) {
  const rows = R.rows || [];
  const words = rows.map((r) => r.w);
  for (let i = words.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [words[i], words[j]] = [words[j], words[i]]; }
  const rec = (w, vec, kk) => { const [a, b] = READINGS[kk](vec); return Math.hypot(a, b) > 0.2 && agree(w, angOf(a, b)); };
  const cnt = { real: {}, nul: {} };
  let nm = 0, nn = 0, wg = 0, vg = 0, wf = 0, vf = 0, fN = 0;
  rows.forEach((r, i) => {
    const vA = angOf(r.vec[0], r.vec[2]);
    if (!r.ok) {
      nm++;
      for (const kk of ["z_flipped", "x_flipped", "east_north_up"]) cnt.real[kk] = (cnt.real[kk] || 0) + (rec(r.w, r.vec, kk) ? 1 : 0);
      if (agree(r.w, r.gAng)) wg++;
      if (agree(vA, r.gAng)) vg++;
      if (r.free !== null) { fN++; if (agree(r.w, r.free)) wf++; if (agree(vA, r.free)) vf++; }
    }
    if (!agree(words[i], vA)) { nn++; for (const kk of ["z_flipped", "x_flipped", "east_north_up"]) cnt.nul[kk] = (cnt.nul[kk] || 0) + (rec(words[i], r.vec, kk) ? 1 : 0); }
  });
  const c = (kk) => `${pct(cnt.real[kk] || 0, nm).padStart(5)} / ${pct(cnt.nul[kk] || 0, nn).padEnd(5)}`;
  console.log(`${k.padEnd(37)} ${c("z_flipped").padStart(19)}  ${c("x_flipped").padStart(19)}  ${c("east_north_up").padStart(19)}   ${pct(wg, nm).padStart(8)}  ${pct(vg, nm).padStart(10)}  ${pct(wf, fN).padStart(13)}  ${pct(vf, fN).padStart(15)}`);
  delete R.rows;
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
