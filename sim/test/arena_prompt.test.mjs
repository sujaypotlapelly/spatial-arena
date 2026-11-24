// Environment-aware prompts (sim/src/gym/arena_prompt.js): byte-identical to
// the published factory prompt, free of factory wording elsewhere.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEnvironment } from "../tools/benchmark_env.mjs";
import { Reach } from "../src/gym/reach.js";
import { reachMessages, rippleReach } from "../src/gym/reach_agents.js";
import { runEpisode } from "../src/gym/core.js";
import { promptProfile, envReachMessages, localizeChat, localizeMessages, FACTORY_SCENE } from "../src/gym/arena_prompt.js";

const factory = loadEnvironment("factory");
const canyon = loadEnvironment("canyon5b");
const FEATURES = [[], ["memory"], ["struct"], ["lean"], ["named"], ["rel", "ascii", "trail", "warn"], ["struct", "memory", "rel"]];

// A few observations along a straight-at-the-goal flight, with a history.
function states(E, level, n = 3) {
  const sc = E.sets.dev[0];
  const env = new Reach(E.world, sc, sc.seeds[0], level);
  const out = [];
  const history = [];
  for (let k = 0; k < n; k++) {
    const obs = env.observe();
    out.push({ sc, obs, history: history.slice(), env });
    const cmd = level === "C1" ? { waypoint: sc.goal, speed: 3 } : level === "C2" ? { target: obs.goal.position, speed: 3 } : level === "C3" ? { velocity: [1, 0, 1] } : { turn_deg: 10, forward_mps: 2, climb_mps: 0 };
    history.push({ t: obs.time_s, command: env.apply(cmd), say: "test", obs, memory: "note" });
    for (let i = 0; i < 60 && !env.done; i++) env.tick(env.P.dt);
  }
  return out;
}

test("factory prompts are byte-identical to reach_agents.js for every level and feature set", () => {
  assert.equal(factory.scene, FACTORY_SCENE);
  const P = promptProfile(factory);
  let compared = 0;
  for (const level of ["C1", "C2", "C3", "C4"]) for (const features of FEATURES) for (const s of states(factory, level)) {
    const opts = { harness: "v0", features, dt: 1, scene: factory.scene };
    const want = reachMessages(factory.world, s.sc, level, s.obs, s.history, opts, s.env);
    const got = envReachMessages(factory.world, s.sc, level, s.obs, s.history, opts, s.env, P);
    assert.equal(JSON.stringify(got), JSON.stringify(want), `${level} ${features.join("+")}`);
    compared++;
  }
  assert.equal(compared, 4 * FEATURES.length * 3);
});

test("the wrapped chat sends the factory prompt unchanged through the real controller", async () => {
  const sc = factory.sets.dev[0];
  const direct = [], wrapped = [];
  const answer = async () => ({ content: '{"velocity": [1, 0, 1]}', finish: "stop" });
  const rec = (log) => async (m) => { log.push(JSON.stringify(m)); return answer(); };
  await runEpisode(new Reach(factory.world, sc, sc.seeds[0], "C3"), rippleReach(factory.world, sc, "C3", rec(direct), { harness: "v0", features: [], dt: 1, scene: factory.scene }));
  await runEpisode(new Reach(factory.world, sc, sc.seeds[0], "C3"), rippleReach(factory.world, sc, "C3", localizeChat(rec(wrapped), promptProfile(factory)), { harness: "v0", features: [], dt: 1, scene: factory.scene }));
  assert.ok(direct.length > 10);
  assert.deepEqual(wrapped, direct);
});

test("other environments get their own place, with no factory wording", () => {
  const P = promptProfile(canyon);
  assert.equal(P.setting, "an outdoor area");
  for (const level of ["C1", "C2", "C3", "C4"]) for (const features of FEATURES) {
    const s = states(canyon, level, 1)[0];
    const msgs = envReachMessages(canyon.world, s.sc, level, s.obs, s.history, { harness: "v0", features, dt: 1, scene: canyon.scene }, s.env, P);
    const text = msgs.map((m) => m.content).join("\n");
    assert.doesNotMatch(text, /indoor building|factory|building's/i, `${level} ${features.join("+")}`);
    assert.match(text, /90 s/);
    assert.match(text, /1 m of/);
    if (!features.includes("lean")) assert.ok(text.includes(canyon.scene));
  }
  // Indoor places that are not the factory keep "building" but lose "factory".
  const W = promptProfile({ name: "warehouse", scene: "The building is a warehouse." });
  assert.equal(W.setting, "an indoor building");
  assert.equal(W.leanPlace, "a building");
});

test("a changed anchor or a limit the simulator doesn't enforce is refused", () => {
  assert.throws(() => localizeMessages([{ role: "system", content: "x" }, { role: "user", content: "no anchors here" }], promptProfile(factory)), /reach_agents.js changed/);
  assert.throws(() => promptProfile({ ...canyon, limits: { timeLimitS: 120 } }), /differ from the simulator/);
  assert.throws(() => promptProfile({ ...canyon, world: { physics: { droneRadius: 0.3, droneMaxSpeed: 5.5, droneMaxAccel: 7 } } }), /physics.droneRadius/);
});
