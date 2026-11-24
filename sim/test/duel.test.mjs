import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { World } from "../src/world.js";
import { Duel, playMatch, replayMatch } from "../src/duel.js";
import { shortestDrone, evaderDrone, greedyBird, parseJson, rippleDrone } from "../src/duel_agents.js";

const world = new World(JSON.parse(readFileSync(new URL("../maps/building.json", import.meta.url))));
const scenarios = JSON.parse(readFileSync(new URL("../scenarios/heldout-36.json", import.meta.url))).scenarios;

test("closed-loop matches replay exactly from recorded commands", async () => {
  for (const sc of scenarios.slice(0, 8)) {
    for (const [d, b] of [[shortestDrone, null], [evaderDrone, null], [evaderDrone, greedyBird], [shortestDrone, greedyBird]]) {
      const m = await playMatch(world, sc, sc.seeds[0], { drone: d(world, sc), bird: b ? b(world, sc) : null });
      const r = replayMatch(world, sc, sc.seeds[0], m.decisions, { birdMode: b ? "command" : "script" });
      assert.deepEqual([r.outcome, r.time, r.endPos], [m.result.outcome, m.result.time, m.result.endPos], `${sc.id} ${d.name}/${b?.name}`);
      assert.ok(m.decisions.length >= 1);
    }
  }
});

test("re-issuing the same command every second flies exactly like issuing it once", async () => {
  for (const sc of scenarios.slice(0, 12)) {
    const once = async (obs, duel) => ({ command: duel.droneCmd ?? { via: "atrium_lo", speed: 5 } });
    const every = async () => ({ command: { via: "atrium_lo", speed: 5 } });
    const a = await playMatch(world, sc, sc.seeds[0], { drone: once });
    const b = await playMatch(world, sc, sc.seeds[0], { drone: every });
    assert.deepEqual([a.result.outcome, a.result.time, a.result.endPos], [b.result.outcome, b.result.time, b.result.endPos], sc.id);
  }
});

test("bad commands are sanitized, never thrown", () => {
  const sc = scenarios[0];
  const m = new Duel(world, sc, 1, { birdMode: "command" });
  assert.deepEqual(m.applyDrone({ via: "nowhere", speed: 99 }), { via: sc.goal, speed: world.physics.droneMaxSpeed, hold: false });
  assert.equal(m.applyBird({ mode: "teleport" }).mode, "wait");
  assert.equal(m.applyBird({ mode: "goto", target: "nope" }).target, sc.goal);
  assert.equal(m.applyBird({ mode: "chase", lead_s: 9 }).lead_s, 2);
});

test("the drone only sees the bird with line of sight", () => {
  const m = new Duel(world, scenarios[0], 1);
  m.drone.pos = [1.5, 1.8, 3];
  m.bird.pos = [1.5, 1.8, -5]; // outside, behind solid south wall (the door is at x 3-6)
  assert.equal(m.visible(m.drone.pos, m.bird.pos), false);
  m.bird.pos = [6, 1.8, 12];
  assert.equal(m.visible(m.drone.pos, m.bird.pos), true);
});

test("an unparseable Ripple reply falls back to the previous command and is flagged", async () => {
  const sc = scenarios[0];
  const chat = async () => ({ content: "I think we should go north.", provider: "test" });
  const ctl = rippleDrone(world, sc, chat);
  const m = new Duel(world, sc, 1);
  const rec = await ctl(m.droneObservation(), m);
  assert.equal(rec.invalid, "unparseable reply");
  assert.equal(rec.meta.attempts, 2);
  assert.deepEqual(rec.command, { hold: true });
  assert.deepEqual(parseJson('ok ```json\n{"via":"goal"}\n```'), { via: "goal" });
});
