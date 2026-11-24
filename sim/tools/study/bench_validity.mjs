// Is the model in control, or is the simulator doing the work? Offline
// controls for Reach at C3 (no API calls). Two families:
//
//  Null controllers (what the physics gives you for free):
//    hover      velocity [0,0,0] every second
//    random     a seeded random horizontal direction at 3 m/s every second
//    goal-line  3 m/s straight at the goal, no avoidance
//    avoider    the senses-only reactive avoider (a competent scripted reference)
//
//  Counterfactual replays of a recorded model run (does success depend on
//  the model responding to *this* state at *this* time?):
//    real       the model's own commands (must reproduce the recorded result)
//    shuffled   another route's command sequence flown on this route
//    lagged     its own commands, each applied one second late
//    open-loop  its first command held for the whole flight (no feedback)
//
// If shuffled / lagged / open-loop collapse toward the null controllers,
// outcomes come from state-dependent decisions, not from the autopilot.
//   node sim/tools/study/bench_validity.mjs runs/reach/c3s2-v0 runs/reach/cap-dev-run2
import fs from "node:fs";
import path from "node:path";
import { Reach } from "../../src/gym/reach.js";
import { runEpisode } from "../../src/gym/core.js";
import { reactiveReach } from "../../src/gym/reach_agents.js";
import { rng } from "../../src/engine.js";
import { v } from "../../src/world.js";
import { loadReach, auditEpisode, mean, bootCI } from "../reach_metrics.mjs";

const { world, sets, scen } = loadReach();
const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const runs = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--json");
const N_DEC = 90; // one command per second for the 90 s limit

const pad = (cmds) => {
  const out = cmds.slice(0, N_DEC);
  while (out.length < N_DEC) out.push(out[out.length - 1] ?? { velocity: [0, 0, 0] });
  return out.map((command) => ({ command }));
};
const score = (sc, seed, decisionLog, result = {}) => auditEpisode(world, scen, { scenario: sc.id, seed, level: "C3", dt: 1, decisionLog, result });

const rows = [];
const add = (control, sc, seed, a) => rows.push({ control, scenario: sc.id, seed, ...a });

// ---------- null controllers on the dev set (24 routes × 2 seeds) ----------
const nullCtl = {
  hover: () => async () => ({ command: { velocity: [0, 0, 0] } }),
  random: (sc, seed) => {
    const R = rng(seed + 17);
    return async () => {
      const a = R.next() * 2 * Math.PI;
      return { command: { velocity: [3 * Math.cos(a), 0, 3 * Math.sin(a)] } };
    };
  },
  "goal-line": () => async (obs) => {
    const to = v.sub(obs.goal.position, obs.position);
    return { command: { velocity: v.scale(v.norm(to), 3) } };
  },
  avoider: (sc) => reactiveReach(world, sc),
};
for (const [name, make] of Object.entries(nullCtl))
  for (const sc of sets.dev)
    for (const seed of sc.seeds) {
      const ep = await runEpisode(new Reach(world, sc, seed, "C3"), make(sc, seed));
      add(name, sc, seed, score(sc, seed, ep.decisions));
    }

// ---------- counterfactual replays of recorded runs ----------
for (const dir of runs) {
  const eps = fs.readFileSync(path.join(dir, "episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.level === "C3" && e.ctl !== "reactive");
  const tag = `${path.basename(dir)}`;
  const byKey = Object.fromEntries(eps.map((e) => [`${e.scenario}/${e.seed}`, e]));
  const order = sets.dev.map((s) => s.id).filter((id) => eps.some((e) => e.scenario === id));
  for (const e of eps) {
    const sc = scen[e.scenario];
    const cmds = e.decisionLog.map((d) => d.command);
    const real = score(sc, e.seed, e.decisionLog, e.result);
    if (!real.exact) console.warn(`  ${tag} ${e.scenario}/${e.seed}: real replay does not reproduce`);
    add(`${tag}: real`, sc, e.seed, real);
    // shuffled: the next route's commands (same seed index), flown here
    const j = order.indexOf(e.scenario);
    const other = order[(j + 1) % order.length];
    const seedIdx = sc.seeds.indexOf(e.seed);
    const donor = byKey[`${other}/${scen[other].seeds[seedIdx]}`];
    if (donor) add(`${tag}: shuffled`, sc, e.seed, score(sc, e.seed, pad(donor.decisionLog.map((d) => d.command))));
    add(`${tag}: lagged 1 s`, sc, e.seed, score(sc, e.seed, pad([{ velocity: [0, 0, 0] }, ...cmds])));
    add(`${tag}: open-loop`, sc, e.seed, score(sc, e.seed, pad([cmds[0]])));
  }
}

// ---------- report ----------
const pct = (x) => `${Math.round(100 * x)}%`;
const groups = Object.groupBy(rows, (r) => r.control);
console.log("control                               n   reached [95% CI]   progress   touching");
const out = {};
for (const [k, rs] of Object.entries(groups)) {
  const ci = bootCI(rs, (x) => mean(x.map((r) => r.reached)));
  out[k] = { n: rs.length, reached: mean(rs.map((r) => r.reached)), reachedCI: ci, progress: mean(rs.map((r) => r.progress)), touching: mean(rs.map((r) => r.touching)), exact: rs.filter((r) => r.exact).length };
  console.log(`${k.padEnd(36)} ${String(rs.length).padStart(3)}   ${pct(out[k].reached).padStart(4)} [${pct(ci[0])}–${pct(ci[1])}]`.padEnd(63) + `${pct(out[k].progress).padStart(6)}   ${pct(out[k].touching).padStart(7)}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
