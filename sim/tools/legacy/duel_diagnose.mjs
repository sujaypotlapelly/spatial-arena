// Why does a controller win or lose? Behavioral statistics per drone/bird
// cell from a duel_eval.mjs run: route changes, reversals, hovering, speed,
// path length relative to the shortest path, and (for scripted birds) belief
// accuracy by the bird's true behavior.
//   node sim/tools/legacy/duel_diagnose.mjs runs/duel/pilot-36x2
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../../src/world.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
const world = new World(JSON.parse(fs.readFileSync(path.join(here, "../../maps/building.json"))));
const heldout = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(here, "../../scenarios/heldout-36.json"))).scenarios.map((s) => [s.id, s]));
const rows = fs.readFileSync(path.join(dir, "matches.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const mean = (xs) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : NaN);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-");

const cells = {};
for (const m of rows) (cells[`${m.drone} vs ${m.bird}`] ??= []).push(m);
console.log("cell                 n  reached  viaChanges/match  reversals  hover%  meanCmdSpeed  pathRatio(reached)  firstMoveFromStart");
for (const [k, ms] of Object.entries(cells)) {
  const vc = [], rev = [], hov = [], spd = [], ratio = [], firstVia = {};
  for (const m of ms) {
    const ds = m.decisionLog.map((d) => d.drone.command);
    let changes = 0, reversals = 0;
    for (let i = 1; i < ds.length; i++) {
      if (ds[i].via !== ds[i - 1].via || ds[i].hold !== ds[i - 1].hold) changes++;
      if (i >= 2 && ds[i].via === ds[i - 2].via && ds[i].via !== ds[i - 1].via) reversals++;
    }
    vc.push(changes); rev.push(reversals);
    hov.push(ds.filter((c) => c.hold).length / ds.length);
    spd.push(mean(ds.filter((c) => !c.hold).map((c) => c.speed)));
    const sc = heldout[m.scenario];
    if (m.result.outcome === "reached") ratio.push(m.result.pathLength / world.routeLength(world.path(sc.start, sc.goal)));
    firstVia[ds[0].via === sc.goal ? "goal" : "detour"] = (firstVia[ds[0].via === sc.goal ? "goal" : "detour"] || 0) + 1;
  }
  const reached = ms.filter((m) => m.result.outcome === "reached").length / ms.length;
  console.log(`${k.padEnd(19)} ${String(ms.length).padStart(3)}  ${pct(reached).padStart(6)}   ${f1(mean(vc)).padStart(10)}       ${f1(mean(rev)).padStart(6)}   ${pct(mean(hov)).padStart(5)}   ${f1(mean(spd)).padStart(8)}        ${f1(mean(ratio)).padStart(8)}           ${JSON.stringify(firstVia)}`);
}

// Ripple drone vs scripted birds: outcome and stated intent by true behavior.
const rs = rows.filter((m) => m.drone === "ripple" && m.bird === "script");
if (rs.length) {
  console.log("\nRipple drone vs scripted birds, by true behavior:");
  const by = Object.groupBy(rs, (m) => m.behavior);
  for (const [b, ms] of Object.entries(by)) {
    const intents = {};
    for (const m of ms) for (const d of m.decisionLog) if (d.drone.belief?.intent) intents[d.drone.belief.intent] = (intents[d.drone.belief.intent] || 0) + 1;
    console.log(`  ${b.padEnd(10)} n=${ms.length} reached ${pct(ms.filter((m) => m.result.outcome === "reached").length / ms.length)} caught ${pct(ms.filter((m) => m.result.outcome === "intercepted").length / ms.length)}  intents ${JSON.stringify(intents)}`);
  }
  // Same scenario+seed, shortest vs ripple: who did better?
  const sh = Object.fromEntries(rows.filter((m) => m.drone === "shortest" && m.bird === "script").map((m) => [`${m.scenario}/${m.seed}`, m.result.outcome]));
  let better = 0, worse = 0, same = 0;
  for (const m of rs) {
    const a = m.result.outcome === "reached", b = sh[`${m.scenario}/${m.seed}`] === "reached";
    if (a && !b) better++; else if (!a && b) worse++; else same++;
  }
  console.log(`  paired with shortest path (same scenario+seed): Ripple better ${better}, worse ${worse}, same ${same}`);
}
