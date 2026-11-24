import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { World, v } from "../src/world.js";
import { FogSearch, makeFogSets, floorGrid, cellIndex, fogFeedback, SIGHT_M, LEVELS } from "../src/gym/fog.js";
import { runEpisode, replayEpisode } from "../src/gym/core.js";
import { frontierFog, randomWalkFog, rippleFog, fogMessages } from "../src/gym/fog_agents.js";

const world = new World(JSON.parse(readFileSync(new URL("../maps/factory-full.json", import.meta.url))));
const sets = makeFogSets(world);
const G = floorGrid(world);

test("scenario sets: beacons hidden from the start, spread out, reachable, disjoint, deterministic", () => {
  const starts = new Set(), nodes = new Set();
  for (const sc of [...sets.train, ...sets.dev, ...sets.heldout]) {
    const s = world.nodes[sc.start];
    assert.equal(sc.beacons.length, 3);
    for (const b of sc.beacons) {
      assert.ok(v.dist(b, s) >= 12, `${sc.id} beacon too close to start`);
      assert.ok(G.reachable[cellIndex(G, b)], `${sc.id} beacon off the reachable floor`);
    }
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(v.dist(sc.beacons[i], sc.beacons[j]) >= 10);
    assert.ok(!starts.has(sc.start));
    starts.add(sc.start);
    for (const n of sc.beaconNodes) assert.ok(!nodes.has(n)), nodes.add(n);
  }
  assert.deepEqual(makeFogSets(world).dev, sets.dev);
});

test("every level replays exactly from recorded commands", async () => {
  const c1 = (w, sc) => { let k = 0; return async () => ({ command: { waypoint: sc.beaconNodes[Math.min(2, Math.floor(k++ / 25))], speed: 4 } }); };
  const c4 = () => async (obs) => ({ command: { turn_deg: obs.free_space_m.ahead < 2 ? 60 : 0, forward_mps: 3, climb_mps: 0 } });
  const ctl = { C1: c1, C2: frontierFog, C3: randomWalkFog, C4: c4 };
  for (const sc of sets.dev.slice(0, 2)) {
    for (const level of LEVELS) {
      const ep = await runEpisode(new FogSearch(world, sc, sc.seeds[0], level), ctl[level](world, sc, { seed: sc.seeds[0] }));
      const re = replayEpisode(new FogSearch(world, sc, sc.seeds[0], level), ep.decisions);
      assert.deepEqual(re, ep.result, `${sc.id} ${level}`);
    }
  }
});

test("vision: 8 m in line of sight; nothing about unseen beacons leaks into observations", () => {
  const sc = sets.dev[0];
  const env = new FogSearch(world, sc, 1, "C2");
  assert.deepEqual(env.found, [null, null, null]);
  const o = env.observe();
  assert.deepEqual(o.beacons, []);
  assert.ok(!JSON.stringify(o).includes(JSON.stringify(sc.beacons[0].map((x) => Math.round(x * 10) / 10))));
  assert.ok(env.explored() > 0 && env.explored() < 15);
  // Next to beacon 1 (its own waypoint is in clear view of it): found.
  env.drone.pos = world.nodes[sc.beaconNodes[0]].slice();
  env.look();
  assert.notEqual(env.found[0], null);
  assert.equal(env.observe().beacons[0].beacon, 1);
  // Far away: not found.
  const far = new FogSearch(world, sc, 1, "C2");
  far.drone.pos = v.add(sc.beacons[1], [SIGHT_M + 4, 0, 0]);
  far.look();
  assert.equal(far.found[1], null);
});

test("command cleanup is idempotent at every level (exact replay)", () => {
  const sc = sets.dev[0];
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 20 - 10;
  for (let i = 0; i < 200; i++) {
    const raw = { velocity: [rnd(), rnd(), rnd()], target: [rnd() * 6, rnd(), rnd() * 6], speed: rnd(), turn_deg: rnd() * 40, forward_mps: rnd(), climb_mps: rnd(), waypoint: i % 2 ? world.nodeIds[i % world.nodeIds.length] : "nowhere" };
    for (const level of LEVELS) {
      const once = new FogSearch(world, sc, 1, level).apply(raw);
      assert.deepEqual(new FogSearch(world, sc, 1, level).apply(once), once, `${level} ${JSON.stringify(raw)}`);
    }
  }
});

test("frontier exploration finds all beacons and out-explores a random walk", async () => {
  let all = 0, fCov = 0, rCov = 0;
  const scs = sets.dev.slice(0, 4);
  for (const sc of scs) {
    const f = await runEpisode(new FogSearch(world, sc, sc.seeds[0], "C2", { stopWhenFound: false }), frontierFog(world, sc));
    const r = await runEpisode(new FogSearch(world, sc, sc.seeds[0], "C3", { stopWhenFound: false }), randomWalkFog(world, sc, { seed: sc.seeds[0] }));
    if (f.result.beaconsFound === 3) all++;
    fCov += f.result.exploredPct;
    rCov += r.result.exploredPct;
    assert.equal(f.result.coverage.length, 6); // every 30 s for 180 s
  }
  assert.ok(all >= 3, `frontier found all on ${all}/4`);
  assert.ok(fCov > rCov, `frontier ${fCov / 4}% vs random ${rCov / 4}%`);
});

test("feedback: true explored map, missed beacons with closest approach, revisits", async () => {
  const sc = sets.dev[0];
  const env = new FogSearch(world, sc, sc.seeds[0], "C3");
  await runEpisode(env, randomWalkFog(world, sc, { seed: 3 }));
  const fb = fogFeedback(env, { believed: [[world.nodes[sc.start][0], world.nodes[sc.start][2]], [100, 100]] });
  const rows = fb.explored_map.split("\n");
  assert.ok(rows.length > 10 && rows.every((r) => r.length === rows[0].length));
  assert.equal(fb.beacons_missed.length, env.found.filter((x) => x === null).length);
  for (const m of fb.beacons_missed) assert.ok(m.closest_approach_m > 0);
  assert.deepEqual(fb.claims_checked.map((c) => c.actually_explored), [true, false]);
  assert.equal(fb.revisits, env.revisits);
});

test("Ripple controller plugs in at every level; P2 memory is carried between decisions (fake chat, no network)", async () => {
  const sc = sets.dev[0];
  for (const level of LEVELS) {
    const env = new FogSearch(world, sc, 1, level);
    const prompts = [];
    let k = 0;
    const chat = async (msgs) => {
      prompts.push(msgs[1].content);
      return { content: JSON.stringify({ waypoint: sc.start, target: [0, 0.8, 0], velocity: [1, 0, 0], turn_deg: 5, forward_mps: 1, speed: 2, memory: `note ${++k}`, say: "look" }) };
    };
    const ctl = rippleFog(world, sc, level, chat, { perception: "P2" });
    for (let i = 0; i < 2; i++) {
      const rec = await ctl(env.observe(), env);
      assert.equal(rec.invalid, undefined);
      env.apply(rec.command);
    }
    assert.match(prompts[0], /Your memory[^\n]*\n\(empty\)/);
    assert.match(prompts[1], /Your memory[^\n]*\nnote 1/);
  }
  assert.ok(!fogMessages(world, sc, "C3", new FogSearch(world, sc, 1, "C3").observe(), [])[1].content.includes("Your memory"));
});
