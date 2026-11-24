import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { World, v } from "../src/world.js";
import { GateRun, makeGateSets, gateEntry, gateExit, gateFeedback, N_GATES, LEVELS } from "../src/gym/gate.js";
import { runEpisode, replayEpisode } from "../src/gym/core.js";
import { astarGate, waypointGate, straightGate, reactiveGate, rippleGate, gateMessages } from "../src/gym/gate_agents.js";

const world = new World(JSON.parse(readFileSync(new URL("../maps/factory-full.json", import.meta.url))));
const sets = makeGateSets(world);
const c4spin = () => async () => ({ command: { turn_deg: 15, forward_mps: 3, climb_mps: 0.2 } });

test("course sets: 8 gates, open and flyable, leg-disjoint, deterministic", () => {
  const legs = new Set();
  for (const sc of [...sets.train, ...sets.dev, ...sets.heldout]) {
    assert.equal(sc.gates.length, N_GATES);
    for (const g of sc.gates) {
      assert.ok(Math.abs(Math.hypot(g.normal[0], g.normal[2]) - 1) < 0.01 && g.normal[1] === 0);
      assert.ok(world.segmentClear(gateEntry(g), gateExit(g), world.physics.droneRadius), `${sc.id} ${g.node}`);
    }
    for (let i = 1; i < sc.gates.length; i++) {
      const leg = `${sc.gates[i - 1].node}>${sc.gates[i].node}`;
      assert.ok(!legs.has(leg), `leg ${leg} reused`);
      legs.add(leg);
    }
  }
  assert.deepEqual(makeGateSets(world).dev, sets.dev);
});

test("every level replays exactly from recorded commands", async () => {
  const ctl = { C1: waypointGate, C2: astarGate, C3: reactiveGate, C4: c4spin };
  for (const sc of sets.dev.slice(0, 3)) {
    for (const level of LEVELS) {
      const ep = await runEpisode(new GateRun(world, sc, sc.seeds[0], level), ctl[level](world, sc));
      const re = replayEpisode(new GateRun(world, sc, sc.seeds[0], level), ep.decisions);
      assert.deepEqual(re, ep.result, `${sc.id} ${level}`);
    }
    // Faster decision rate (the planner bound) and the senses-only floor.
    const ep = await runEpisode(new GateRun(world, sc, sc.seeds[1], "C2"), astarGate(world, sc), { dt: 0.25 });
    assert.deepEqual(replayEpisode(new GateRun(world, sc, sc.seeds[1], "C2"), ep.decisions, { dt: 0.25 }), ep.result, `${sc.id} astar dt=0.25`);
    const st = await runEpisode(new GateRun(world, sc, sc.seeds[1], "C2"), straightGate(world, sc));
    assert.deepEqual(replayEpisode(new GateRun(world, sc, sc.seeds[1], "C2"), st.decisions), st.result, `${sc.id} straight`);
  }
});

test("gate passing: forward through the opening only, strictly in order", () => {
  const sc = sets.dev[0];
  const env = new GateRun(world, sc, 1, "C3");
  const g = env.gates[0], g2 = env.gates[1];
  const u = [-g.normal[2], 0, g.normal[0]];
  const before = v.sub(g.center, v.scale(g.normal, 0.1)), after = v.add(g.center, v.scale(g.normal, 0.1));
  assert.notEqual(env.crossing(0, before, after), null); // through the middle
  assert.equal(env.crossing(0, after, before), null); // backwards
  const off = v.scale(u, 1.2); // 1.2 m to the side: outside the 2 m wide opening
  assert.equal(env.crossing(0, v.add(before, off), v.add(after, off)), null);
  assert.equal(env.crossing(0, v.add(before, [0, 0.8, 0]), v.add(after, [0, 0.8, 0])), null); // above it
  // Crossing gate 2 while gate 1 is next does nothing.
  env.drone.pos = v.sub(g2.center, v.scale(g2.normal, 0.3));
  env.apply({ velocity: v.scale(g2.normal, 3) });
  for (let i = 0; i < 30; i++) env.tick(env.P.dt);
  assert.equal(env.next, 0);
  // Gate 1 then counts.
  env.drone.pos = v.sub(g.center, v.scale(g.normal, 0.3));
  env.drone.vel = [0, 0, 0];
  env.apply({ velocity: v.scale(g.normal, 3) });
  for (let i = 0; i < 30; i++) env.tick(env.P.dt);
  assert.equal(env.next, 1);
  assert.equal(env.result().gatesPassed, 1);
  assert.equal(env.result().gatesMissed, N_GATES - 1);
});

test("command cleanup is idempotent at every level (exact replay)", () => {
  const sc = sets.dev[0];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 20 - 10;
  for (let i = 0; i < 200; i++) {
    const raw = { velocity: [rnd(), rnd(), rnd()], target: [rnd() * 6, rnd(), rnd() * 6], speed: rnd(), turn_deg: rnd() * 40, forward_mps: rnd(), climb_mps: rnd(), waypoint: i % 3 ? "gate" : i % 2 ? world.nodeIds[i % world.nodeIds.length] : "nowhere" };
    for (const level of LEVELS) {
      const once = new GateRun(world, sc, 1, level).apply(raw);
      assert.deepEqual(new GateRun(world, sc, 1, level).apply(once), once, `${level} ${JSON.stringify(raw)}`);
    }
  }
  assert.equal(new GateRun(world, sc, 1, "C1").apply({ waypoint: "nowhere" }).waypoint, "gate");
  assert.deepEqual(new GateRun(world, sc, 1, "C3").apply({ velocity: [100, 0, 0] }), { velocity: [5.49, 0, 0] });
});

test("observations follow the perception rules: C4 has no coordinates, C2/C3 no map", () => {
  const sc = sets.dev[0];
  const o4 = new GateRun(world, sc, 1, "C4").observe();
  assert.equal(o4.position, undefined);
  assert.equal(o4.next_gate.center, undefined);
  assert.ok(Number.isFinite(o4.next_gate.bearing_deg));
  const o3 = new GateRun(world, sc, 1, "C3").observe();
  assert.equal(o3.nearest_waypoint, undefined);
  assert.equal(o3.next_gate.gate, 1);
  assert.ok(!gateMessages(world, sc, "C3", o3, []).some((m) => m.content.includes("Waypoint graph")));
  assert.ok(gateMessages(world, sc, "C1", new GateRun(world, sc, 1, "C1").observe(), [])[1].content.includes("Waypoint graph"));
});

test("planner baselines finish dev laps through every gate", async () => {
  let astar = 0, wp = 0;
  for (const sc of sets.dev.slice(0, 4)) {
    const a = await runEpisode(new GateRun(world, sc, sc.seeds[0], "C2"), astarGate(world, sc), { dt: 0.25 });
    const w = await runEpisode(new GateRun(world, sc, sc.seeds[0], "C1"), waypointGate(world, sc));
    if (a.result.outcome === "finished" && a.result.gatesMissed === 0) astar++;
    if (w.result.outcome === "finished") wp++;
  }
  assert.ok(astar >= 4, `A* finished ${astar}/4`);
  assert.ok(wp >= 3, `waypoint planner finished ${wp}/4`);
});

test("feedback: split per gate, contacts with a wall direction, reference time", async () => {
  const sc = sets.dev[1];
  const ep = await runEpisode(new GateRun(world, sc, sc.seeds[0], "C3"), reactiveGate(world, sc));
  const fb = gateFeedback(world, ep, { referenceLapTime: 31.4 });
  assert.equal(fb.splits.length, N_GATES);
  assert.equal(fb.splits.filter((s) => s.missed).length, ep.result.gatesMissed);
  assert.equal(fb.wall_contacts.length, ep.result.contacts);
  for (const c of fb.wall_contacts) assert.match(c.nearest_wall, /^(east|west|north|south)(-(east|west))?$|^north-|^south-/);
  assert.equal(fb.reference, "The course can be done in 31.4 s.");
});

test("Ripple controller plugs in at every level (fake chat, no network)", async () => {
  const sc = sets.dev[0];
  for (const level of LEVELS) {
    const seen = [];
    const chat = async (msgs) => {
      seen.push(msgs[1].content);
      return { content: JSON.stringify({ waypoint: "gate", target: sc.gates[0].center, velocity: [1, 0, 0], turn_deg: 10, forward_mps: 2, speed: 3, say: "go" }) };
    };
    const env = new GateRun(world, sc, 1, level);
    const ctl = rippleGate(world, sc, level, chat);
    const rec = await ctl(env.observe(), env);
    assert.equal(rec.invalid, undefined, level);
    const cmd = env.apply(rec.command);
    assert.deepEqual(new GateRun(world, sc, 1, level).apply(cmd), cmd);
    assert.equal(seen.length, 1);
  }
});
