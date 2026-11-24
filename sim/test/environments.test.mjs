// Environment manifests (docs/CONTRIBUTING_ENVIRONMENTS.md): every manifest is
// valid, the older registries are exactly what the manifests generate, and
// the fast stage-2 gates still pass for the box-built places. The full audit,
// including scan coverage, is `node sim/tools/env/admit.mjs --all --check`.
import test from "node:test";
import assert from "node:assert/strict";
import { loadManifests, registryDrift } from "../tools/env/manifests.mjs";
import { stage2, loadWorld } from "../tools/env/gates.mjs";

test("environment manifests are valid and cross-reference each other", () => {
  const m = loadManifests();
  assert.deepEqual(m.problems, []);
  assert.ok(m.envs.length >= 9);
});

test("the registries in sim/scenes match the manifests exactly", () => {
  assert.deepEqual(registryDrift(), [], "run node sim/tools/env/sync_registries.mjs");
});

for (const id of ["warehouse", "building"]) {
  test(`${id}: stage-2 gates pass (routes pinned, fair test, exact replays)`, async () => {
    const m = loadManifests();
    const env = m.envs.find((e) => e.id === id);
    const gates = await stage2({ env, scene: null, map: null, world: loadWorld(env) });
    const failing = gates.filter((g) => g.status !== "pass").map((g) => `${g.id}: ${g.detail}`);
    assert.deepEqual(failing, []);
  });
}
