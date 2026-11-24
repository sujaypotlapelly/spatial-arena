// Analyse probe runs (tools/legacy/make_probes.mjs + harness_eval.mjs): what does
// Ripple actually DO when one factor of the scenario changes?
//   node sim/tools/legacy/probe_report.mjs --behavior runs/probes/behavior-a.json [--repeat runs/probes/behavior-b.json] --position runs/probes/position.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World, routeMenu } from "../../src/world.js";
import { shortestPathPolicy, validateDefender } from "../../src/policy.js";
import { runEpisode } from "../../src/scenarios.js";
import { heuristicDefender } from "../../src/agents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const world = new World(JSON.parse(fs.readFileSync(path.join(here, "../../maps/building.json"))));
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const load = (f) => (f ? JSON.parse(fs.readFileSync(f)) : null);
const scen = (name) => Object.fromEntries(JSON.parse(fs.readFileSync(path.join(here, `../scenarios/${name}.json`))).scenarios.map((s) => [s.id, s]));
const pct = (x) => (x === null || Number.isNaN(x) ? "  -  " : `${Math.round(x * 100)}%`.padStart(4));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const f1 = (x) => (Number.isNaN(x) ? "-" : x.toFixed(1));
const FAMILY = { pursue: "chase", intercept: "chase", ambush: "wait", patrol: "wait" };
const LABEL = { raw: "A raw", tools: "C tools", structured: "D structured", structured_feedback: "H struct+strategy" };

// Non-LLM comparators flown on the same scenarios.
const baselineSuccess = (S) => {
  const out = { shortest: [], heuristic: [] };
  for (const sc of Object.values(S)) {
    out.shortest.push(runEpisode(world, sc, shortestPathPolicy(world, sc), { keepFrames: false }).summary.successRate);
    out.heuristic.push(runEpisode(world, sc, validateDefender(heuristicDefender(world, sc, { strategy: "bird-aware" }), world, sc).policy, { keepFrames: false }).summary.successRate);
  }
  return { shortest: mean(out.shortest), heuristic: mean(out.heuristic) };
};
const episodes = (session) => session.evaluation.episodes.filter((e) => e.condition !== "shortest");
const conds = (session) => [...new Set(episodes(session).map((e) => e.condition))];

// ---------------- behavior probe ----------------
const B = load(opt("--behavior"));
if (B) {
  const S = scen("probe-behavior");
  const rep = load(opt("--repeat"));
  console.log(`\n## Behavior probe: ${Object.keys(S).length} scenarios (12 bases x 4 hidden behaviors), same start/goal/bird start within a base\n`);
  const base = baselineSuccess(S);
  console.log(`Non-LLM: shortest path ${pct(base.shortest)}, bird-aware heuristic ${pct(base.heuristic)}\n`);
  console.log("harness             success  family  exact  routes/base  same-route-all-4  route-works  success|right  success|wrong  invalid");
  for (const c of conds(B)) {
    const E = episodes(B).filter((e) => e.condition === c);
    const ok = E.filter((e) => !e.defender.invalid);
    const P = (e) => e.defender.policy;
    const bases = [...new Set(E.map((e) => S[e.scenario.id].probe.base))];
    const routesPerBase = bases.map((b) => new Set(ok.filter((e) => S[e.scenario.id].probe.base === b).map((e) => P(e).route_id)).size);
    const sameAll = routesPerBase.filter((n) => n === 1).length;
    // Did it pick a route that works (>=3/4 with the reference controller) against the TRUE behavior?
    const works = ok.map((e) => (S[e.scenario.id].probe.routeReached[P(e).route_id] ?? 0) >= 3);
    const right = ok.filter((e) => e.belief?.familyCorrect), wrong = ok.filter((e) => !e.belief?.familyCorrect);
    console.log(
      `${(LABEL[c] || c).padEnd(20)} ${pct(mean(E.map((e) => e.summary.successRate)))}    ${pct(mean(E.map((e) => (e.belief?.familyCorrect ? 1 : 0))))}   ${pct(mean(E.map((e) => (e.belief?.behaviorCorrect ? 1 : 0))))}      ${f1(mean(routesPerBase))}           ${sameAll}/${bases.length}            ${pct(mean(works.map(Number)))}        ${pct(mean(right.map((e) => e.summary.successRate)))} (${right.length})     ${pct(mean(wrong.map((e) => e.summary.successRate)))} (${wrong.length})     ${E.length - ok.length}`,
    );
  }
  // Confusion: what Ripple guessed for each true behavior (all harnesses pooled).
  console.log("\nGuess by true behavior (all harnesses pooled):");
  const all = episodes(B).filter((e) => !e.defender.invalid);
  for (const t of ["pursue", "intercept", "ambush", "patrol"]) {
    const g = {};
    for (const e of all.filter((e) => e.scenario.bird.strategy === t)) g[e.defender.policy.bird_behavior_guess] = (g[e.defender.policy.bird_behavior_guess] || 0) + 1;
    console.log(`  truth ${t.padEnd(9)} -> ${Object.entries(g).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  }
  // Do settings follow the stated belief?
  console.log("\nSettings by stated guess (all harnesses pooled):");
  console.log("  guess       n   speed  evade_at_m  evade_str  replan  chose_shortest");
  for (const g of ["pursue", "intercept", "ambush", "patrol"]) {
    const s = all.filter((e) => e.defender.policy.bird_behavior_guess === g);
    if (!s.length) continue;
    const P = (e) => e.defender.policy;
    console.log(`  ${g.padEnd(10)} ${String(s.length).padStart(3)}   ${mean(s.map((e) => P(e).cruise_speed)).toFixed(2)}   ${mean(s.map((e) => P(e).avoidance_distance)).toFixed(1)}        ${mean(s.map((e) => P(e).evade_strength)).toFixed(2)}       ${pct(mean(s.map((e) => (P(e).replan_when_bird_nearby ? 1 : 0))))}   ${pct(mean(s.map((e) => (P(e).route_id === "R1" ? 1 : 0))))}`);
  }
  // Decision noise: same scenario, same harness, asked twice.
  if (rep) {
    console.log("\nRepeatability (same scenario, same harness, two independent runs):");
    for (const c of conds(rep)) {
      const pairs = episodes(rep)
        .filter((e) => e.condition === c && !e.defender.invalid)
        .map((e2) => [episodes(B).find((e) => e.condition === c && e.scenario.id === e2.scenario.id && !e.defender.invalid), e2])
        .filter(([a]) => a);
      const same = (k) => mean(pairs.map(([a, b]) => (a.defender.policy[k] === b.defender.policy[k] ? 1 : 0)));
      // Within one run, how often does the route change across behaviors of the same base?
      const within = (sess) => {
        const E = episodes(sess).filter((e) => e.condition === c && !e.defender.invalid);
        const bases = [...new Set(E.map((e) => S[e.scenario.id].probe.base))];
        const changes = [];
        for (const b of bases) {
          const r = E.filter((e) => S[e.scenario.id].probe.base === b).map((e) => e.defender.policy.route_id);
          for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) changes.push(r[i] !== r[j] ? 1 : 0);
        }
        return mean(changes);
      };
      console.log(`  ${(LABEL[c] || c).padEnd(20)} n=${pairs.length}  same route ${pct(same("route_id"))}, same guess ${pct(same("bird_behavior_guess"))}, same speed ${pct(same("cruise_speed"))} | route differs across behaviors of a base: ${pct(within(B))} (run 1), ${pct(within(rep))} (run 2)`);
      console.log(`  ${"".padEnd(20)} success run 1 ${pct(mean(pairs.map(([a]) => a.summary.successRate)))}, run 2 ${pct(mean(pairs.map(([, b]) => b.summary.successRate)))}`);
    }
  }
}

// ---------------- position probe ----------------
const Pn = load(opt("--position"));
if (Pn) {
  const S = scen("probe-position");
  console.log(`\n## Position probe: ${Object.keys(S).length} scenarios (10 bases x 3-4 ambush points, each on a different route)\n`);
  const base = baselineSuccess(S);
  // Chance: a uniformly random route from the menu.
  const chanceOnBird = mean(Object.values(S).map((s) => 1 / routeMenu(world, s.start, s.goal).length));
  const chanceDist = mean(Object.values(S).map((s) => mean(Object.values(s.probe.routeDistToBird))));
  const maxDist = mean(Object.values(S).map((s) => Math.max(...Object.values(s.probe.routeDistToBird))));
  const heurDist = mean(Object.values(S).map((s) => s.probe.routeDistToBird[validateDefender(heuristicDefender(world, s, { strategy: "bird-aware" }), world, s).policy.route_id]));
  console.log(`Non-LLM: shortest path ${pct(base.shortest)}, bird-aware heuristic ${pct(base.heuristic)} (route ${f1(heurDist)} m from the bird)`);
  console.log(`Random route: on the bird's route ${pct(chanceOnBird)}, ${f1(chanceDist)} m from the bird; farthest route available: ${f1(maxDist)} m\n`);
  console.log("harness             success  on-bird's-route  route-dist-to-bird  routes/base  route-works  danger-pt-err  invalid");
  for (const c of conds(Pn)) {
    const E = episodes(Pn).filter((e) => e.condition === c);
    const ok = E.filter((e) => !e.defender.invalid);
    const P = (e) => e.defender.policy;
    const bases = [...new Set(E.map((e) => S[e.scenario.id].probe.base))];
    const routesPerBase = bases.map((b) => new Set(ok.filter((e) => S[e.scenario.id].probe.base === b).map((e) => P(e).route_id)).size);
    console.log(
      `${(LABEL[c] || c).padEnd(20)} ${pct(mean(E.map((e) => e.summary.successRate)))}        ${pct(mean(ok.map((e) => (P(e).route_id === S[e.scenario.id].probe.birdOnRoute ? 1 : 0))))}              ${f1(mean(ok.map((e) => S[e.scenario.id].probe.routeDistToBird[P(e).route_id])))} m            ${f1(mean(routesPerBase))}         ${pct(mean(ok.map((e) => ((S[e.scenario.id].probe.routeReached[P(e).route_id] ?? 0) >= 3 ? 1 : 0))))}        ${f1(mean(ok.map((e) => e.belief?.dangerError).filter((x) => typeof x === "number")))} m       ${E.length - ok.length}`,
    );
  }
}
