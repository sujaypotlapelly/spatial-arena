// Integrity check 2: how much do the gusts actually move the drone?
// Flies a drone in open air (no geometry) holding a fixed velocity command,
// for many seeds, and measures how far its velocity sits from the command and
// how far it drifts from where a perfect drone would be after 1 s (one
// decision) and after 5 s. Published gusts first, then the opt-in wind levels
// in sim/src/gym/reach_perturb.js. No model calls.
//   node sim/tools/study/integrity_wind.mjs --out <checkout>/runs/integrity
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World, v } from "../../src/world.js";
import { FreeDrone } from "../../src/gym/core.js";
import { WindyDrone, WIND_LEVELS } from "../../src/gym/reach_perturb.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const factory = new World(JSON.parse(fs.readFileSync(path.join(root, "sim/maps/factory-full.json"))));
// Same physics and bounds, no walls.
const open = { physics: factory.physics, bounds: { min: [-1e6, -1e6, -1e6], max: [1e6, 1e6, 1e6] }, moveSphere: (p, q) => q };
const dt = factory.physics.dt;
const SEEDS = 400, SETTLE = 5, T = 30;

function measure(make, cmd) {
  const velErr = [], drift1 = [], drift5 = [], hold = [];
  for (let s = 0; s < SEEDS; s++) {
    const d = make(820001 + s);
    d.vel = cmd.slice();
    d.setVelocity(cmd);
    const track = [];
    for (let i = 0; i < Math.round(T / dt); i++) {
      d.step(dt, i * dt);
      if (i * dt >= SETTLE) { velErr.push(v.len(v.sub(d.vel, cmd))); track.push(d.pos.slice()); }
    }
    // Drift: displacement minus the commanded displacement, over 1 s and 5 s windows.
    const n1 = Math.round(1 / dt), n5 = Math.round(5 / dt);
    for (let i = 0; i + n5 < track.length; i += n5) {
      drift1.push(v.len(v.sub(v.sub(track[i + n1], track[i]), v.scale(cmd, 1))));
      drift5.push(v.len(v.sub(v.sub(track[i + n5], track[i]), v.scale(cmd, 5))));
    }
    hold.push(v.len(v.sub(v.scale(v.sub(track[track.length - 1], track[0]), 1 / ((track.length - 1) * dt)), cmd)));
  }
  const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const r = (x) => Math.round(x * 100) / 100;
  return { velErrMean: r(mean(velErr)), velErrP95: r(q(velErr, 0.95)), drift1sMean: r(mean(drift1)), drift1sP95: r(q(drift1, 0.95)), drift5sMean: r(mean(drift5)), drift5sP95: r(q(drift5, 0.95)), meanVelocityOffset: r(mean(hold)) };
}

const rows = [];
for (const [name, cmd] of [["hover", [0, 0, 0]], ["cruise 3 m/s", [3, 0, 0]]]) {
  rows.push({ level: "published gusts (0.8 m/s^2)", command: name, ...measure((s) => new FreeDrone(open, [0, 5, 0], s), cmd) });
  for (const [lvl, w] of Object.entries(WIND_LEVELS)) if (w) rows.push({ level: `${lvl} (steady ${w.steady} m/s^2, gusts x${w.gustScale})`, command: name, ...measure((s) => new WindyDrone(open, [0, 5, 0], s, w), cmd) });
}
console.log("level | command | |vel - cmd| mean / p95 (m/s) | drift over 1 s mean / p95 (m) | drift over 5 s mean / p95 (m) | mean velocity offset over 25 s (m/s)");
for (const r of rows) console.log(`${r.level} | ${r.command} | ${r.velErrMean} / ${r.velErrP95} | ${r.drift1sMean} / ${r.drift1sP95} | ${r.drift5sMean} / ${r.drift5sP95} | ${r.meanVelocityOffset}`);
const out = path.resolve(opt("--out", path.join(root, "runs/integrity")));
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "wind-disturbance.json"), JSON.stringify({ at: new Date().toISOString(), seeds: SEEDS, settle_s: SETTLE, flight_s: T, rows }, null, 1));
console.log("wrote", path.join(out, "wind-disturbance.json"));
