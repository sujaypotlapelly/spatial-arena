// Failure taxonomy for Reach runs: step 4 of the harness loop. Per
// condition, how often each decision:
//   - says one direction but commands another (words vs. actual vector)
//   - commands motion with a horizontal component pointing away from the goal (> 90 deg)
//   - commands motion into a wall less than 1 m away (from the geometry at that moment)
//   - reverses its previous command (> 135 deg)
// plus wall contacts per minute.
//   node sim/tools/study/reach_diagnose.mjs runs/reach/ladder-v0-dev
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../../src/world.js";
import { clearance } from "../../src/gym/core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
const world = new World(JSON.parse(fs.readFileSync(path.join(here, "../../maps/factory-full.json"))));
const sets = JSON.parse(fs.readFileSync(path.join(here, "../../scenarios/reach-factory.json")));
const scen = Object.fromEntries([...sets.train, ...sets.dev, ...sets.heldout].map((s) => [s.id, s]));
const eps = fs.readFileSync(path.join(dir, "episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const WORDS = { "north-east": 45, northeast: 45, "north-west": 135, northwest: 135, "south-east": -45, southeast: -45, "south-west": -135, southwest: -135, north: 90, south: -90, east: 0, west: 180 };
const angOf = (dx, dz) => (Math.atan2(dz, dx) * 180) / Math.PI;
const diff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const COMPASS = { east: 0, north_east: 45, north: 90, north_west: 135, west: 180, south_west: -135, south: -90, south_east: -45 };

function saidDirection(say) {
  const s = (say || "").toLowerCase().replace(/north east/g, "northeast").replace(/north west/g, "northwest").replace(/south east/g, "southeast").replace(/south west/g, "southwest");
  for (const [w, a] of Object.entries(WORDS)) if (new RegExp(`\\b${w}\\b`).test(s)) return a;
  return null;
}

const by = Object.groupBy(eps, (e) => e.condition);
console.log("condition      decisions  says≠does  away-from-goal  into-wall<1m  reversals  turn-word≠sign  contacts/min");
for (const [cond, es] of Object.entries(by)) {
  let n = 0, said = 0, mism = 0, away = 0, wall = 0, rev = 0, turnWords = 0, turnMism = 0, contacts = 0, minutes = 0;
  for (const e of es) {
    const sc = scen[e.scenario];
    const goal = world.nodes[sc.goal];
    contacts += e.result.contacts;
    minutes += e.result.time / 60;
    let prevAng = null;
    for (const d of e.decisionLog) {
      const f = e.frames.find((fr) => fr[0] >= d.t - 1e-6) || e.frames[e.frames.length - 1];
      const pos = [f[1], f[2], f[3]];
      const heading = f[4];
      let dir = null; // commanded horizontal direction (deg, from +x toward +z)
      if (e.level === "C2" && Array.isArray(d.command.target)) dir = angOf(d.command.target[0] - pos[0], d.command.target[2] - pos[2]);
      if (e.level === "C3" && Math.hypot(d.command.velocity[0], d.command.velocity[2]) > 0.2) dir = angOf(d.command.velocity[0], d.command.velocity[2]);
      if (e.level === "C4" && d.command.forward_mps > 0.2) dir = ((heading * 180) / Math.PI + d.command.turn_deg);
      if (e.level === "C4") {
        const s = (d.say || "").toLowerCase();
        const L = /\bleft\b/.test(s), R = /\bright\b/.test(s);
        if ((L || R) && !(L && R) && d.command.turn_deg !== 0) {
          turnWords++;
          if ((L && d.command.turn_deg < 0) || (R && d.command.turn_deg > 0)) turnMism++;
        }
      }
      if (dir === null) continue;
      n++;
      const w = saidDirection(d.say);
      if (w !== null && e.level !== "C4") {
        said++;
        if (diff(w, dir) > 67.5) mism++;
      }
      if (diff(dir, angOf(goal[0] - pos[0], goal[2] - pos[2])) > 90) away++;
      const c = clearance(world, pos, 0.25, 3);
      const near = Object.entries(COMPASS).reduce((b, [k, a]) => (diff(a, dir) < diff(b[1], dir) ? [k, a] : b), ["east", 0]);
      if (c[near[0]] < 1) wall++;
      if (prevAng !== null && diff(prevAng, dir) > 135) rev++;
      prevAng = dir;
    }
  }
  const p = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-").padStart(6);
  console.log(`${cond.padEnd(13)} ${String(n).padStart(9)}  ${p(mism, said)} (${said})   ${p(away, n)}        ${p(wall, n)}      ${p(rev, n)}    ${p(turnMism, turnWords)} (${turnWords})     ${(contacts / minutes).toFixed(1).padStart(6)}`);
}
