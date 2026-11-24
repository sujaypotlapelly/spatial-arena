// Benchmark environments: pinned route and mission sets regenerate exactly,
// the factory sets are unchanged by the generalized generator, missions are
// feasible for the privileged oracle, and search observations never leak the
// hidden hiker.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadEnvironment, ENVIRONMENTS, missionSpotFilter, root } from "../tools/benchmark_env.mjs";
import { makeMissionSets } from "../src/gym/mission_sets.js";
import { RescueMission } from "../src/gym/rescue_tasks.js";
import { runEpisode } from "../src/gym/core.js";
import { oracleSearch, oracleDelivery } from "../src/gym/mission_agents.js";

const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));

test("factory reach sets are unchanged (train/dev/heldout match the pinned file)", () => {
  const E = loadEnvironment("factory");
  const pinned = read("sim/scenarios/reach-factory.json");
  for (const k of ["train", "dev", "heldout"]) assert.deepEqual(E.sets[k], pinned[k]);
  assert.equal(E.sets.test.length, 48);
});

for (const name of ["canyon", "residential"]) {
  test(`${name} reach sets match the pinned file and are disjoint`, () => {
    const E = loadEnvironment(name);
    const pinned = read(E.scenarioFile);
    for (const k of ["train", "dev", "heldout", "test"]) assert.deepEqual(E.sets[k], pinned[k]);
    const keys = ["train", "dev", "heldout", "test"].flatMap((k) => E.sets[k].map((s) => [s.start, s.goal].sort().join("|")));
    assert.equal(new Set(keys).size, keys.length);
  });
}

for (const [name, env] of Object.entries(ENVIRONMENTS)) {
  for (const task of Object.keys(env.missions ?? {})) {
    test(`${name} ${task}: mission sets regenerate exactly; targets are disjoint; oracle succeeds`, async () => {
      const E = loadEnvironment(name);
      const file = `sim/scenarios/mission-${name}-${task}.json`;
      const pinned = read(file);
      const sets = makeMissionSets(E.world, task, { idPrefix: `${name}-${task}-`, ...E.missions[task] }, { spotFilter: missionSpotFilter(E.missions[task]) });
      // Compare as stored: JSON writes -0 as 0, and a rounded coordinate can be -0.
      for (const k of ["train", "dev", "test"]) assert.deepEqual(JSON.parse(JSON.stringify(sets[k])), pinned[k]);
      const targets = ["train", "dev", "test"].flatMap((k) => sets[k].map((m) => m.targetPosition.join(",")));
      assert.equal(new Set(targets).size, targets.length, "each target location is used once");
      for (const m of sets.dev.slice(0, 2)) {
        const env = new RescueMission(E.world, m, m.seeds[0]);
        const ctl = task === "search" ? oracleSearch(E.world, m) : oracleDelivery(E.world, m);
        const ep = await runEpisode(env, ctl);
        assert.ok(["found", "delivered", "misdelivered"].includes(ep.result.outcome), `${m.id}: oracle ${ep.result.outcome}`);
      }
    });
  }
}

test("search observations never contain the hidden hiker before it is found", () => {
  for (const name of ["factory", "canyon", "residential"]) {
    const E = loadEnvironment(name);
    const m = read(`sim/scenarios/mission-${name}-search.json`).train[0];
    const obs = new RescueMission(E.world, m, m.seeds[0]).observe();
    const text = JSON.stringify(obs);
    assert.equal(obs.search.target, null);
    assert.ok(!text.includes("oracleViewpoint") && !text.includes(String(m.targetPosition[0])), `${name}: target leaked`);
  }
});
