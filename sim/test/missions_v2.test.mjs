import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { World, v } from "../src/world.js";
import { RescueMission } from "../src/gym/rescue_tasks.js";
import { runEpisode, replayEpisode, lineOfSight } from "../src/gym/core.js";
import { better, pickFrozen, tieKey, sensedCoverage } from "../src/gym/mission_select.js";
import { makeTrainer } from "../src/gym/mission_train.js";
import { programRandomSeed } from "../src/gym/policy_sandbox.js";
import { coverageSweep, laneSweep, randomWalk } from "../src/gym/mission_agents.js";

const read = (f) => JSON.parse(fs.readFileSync(new URL(f, import.meta.url), "utf8"));
const physics = { dt: 1 / 60, droneRadius: 0.25, droneMaxSpeed: 5.5, droneMaxAccel: 7, gust: 0 };
const floor = { min: [-40, -1, -40], max: [40, 0, 40] };
const boxWorld = (extra = []) => new World({ physics, bounds: { min: [-40, -2, -40], max: [40, 10, 40] }, waypoints: {}, edges: [], boxes: [floor, ...extra] });
const wall = { min: [-0.2, 0, -2], max: [0.2, 3, 2] };

// ---------- defect 1: selection ----------
test("legacy selection is the v4 rule; earned search selection never uses progress", () => {
  // The v4 inline rule, verbatim, as the reference.
  const v4Better = (a, b) => !b || a.success > b.success || (a.success === b.success && a.progress > b.progress);
  const v4Frozen = (curve) => { const u = curve.filter((c) => !c.compileError && c.finish !== "length"); return [...(u.length ? u : curve)].sort((a, b) => b.success - a.success || b.progress - a.progress || a.version - b.version)[0]; };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 300; i++) {
    const curve = Array.from({ length: 6 }, (_, k) => ({ version: k + 1, success: Math.floor(rnd() * 3), progress: Math.round(rnd() * 4) / 4, coverage: Math.floor(rnd() * 3), compileError: rnd() < 0.1 ? "x" : null, finish: "stop" }));
    for (const task of ["search", "delivery"]) {
      assert.equal(pickFrozen(curve, "legacy", task).version, v4Frozen(curve).version);
      for (const a of curve) for (const b of [null, ...curve]) assert.equal(better(a, b, "legacy", task), v4Better(a, b));
    }
    // Earned search: changing progress (closeness to the hidden hiker) never changes the choice.
    const shuffled = curve.map((c) => ({ ...c, progress: rnd() }));
    assert.equal(pickFrozen(shuffled, "earned", "search").version, pickFrozen(curve, "earned", "search").version);
  }
  assert.equal(tieKey("earned", "search"), "coverage");
  assert.equal(tieKey("earned", "delivery"), "progress"); // the pad position is given to the program
  const a = { version: 1, success: 1, progress: 0.9, coverage: 100 }, b = { version: 2, success: 1, progress: 0.1, coverage: 300 };
  assert.equal(pickFrozen([a, b], "legacy", "search").version, 1);
  assert.equal(pickFrozen([a, b], "earned", "search").version, 2);
  assert.throws(() => pickFrozen([a], "closest", "search"), /--select/);
});

test("sensed coverage depends only on where the drone flew, and respects the sector", () => {
  const W = boxWorld([wall]);
  const frames = [[0, -5, 1.3, 0, 0], [1, -3, 1.3, 0, 0], [2, -1, 1.3, 0, 0]];
  const all = sensedCoverage(W, frames, 5);
  assert.ok(all > 20);
  assert.ok(sensedCoverage(W, frames, 5, { area: { min: [-4, -4], max: [0, 4] } }) < all);
  assert.equal(sensedCoverage(W, frames.slice(0, 1), 5), sensedCoverage(W, [frames[0], [0.5, -5, 1.3, 0, 0]], 5)); // once per second
});

// ---------- defect 2: program random seed ----------
test("a program's Math.random is separate from the wind by default and the wind's seed under legacy", async () => {
  const W = boxWorld([wall]);
  const m = { kind: "find-beacon", start: [-3, 1, 0], targetPosition: [3, 1, 0], detectionRange: 4, timeLimitSeconds: 2, seeds: [12345] };
  const code = "function policy(obs, memory) { return { velocity: [0, 0, 0], say: String(Math.random()) }; }";
  const says = async (random) => (await makeTrainer({ world: W, task: "search", random }).evaluate(code, [m])).eps[0].ep.decisions.map((d) => d.say);
  const legacy = await says("legacy"), separate = await says("separate");
  const { rng } = await import("../src/engine.js");
  const wind = rng(12345);
  assert.equal(legacy[0], String(wind.next()).slice(0, 80));
  assert.notEqual(separate[0], legacy[0]);
  assert.notEqual(programRandomSeed(12345, "separate"), 12345);
  assert.throws(() => programRandomSeed(1, "shared"), /--random/);
});

// ---------- legacy observations are unchanged ----------
// Hashes of a scripted flight's observations, result and frames, computed
// with the pre-v2 rescue_tasks.js (commit e77d2ad) and pinned here. The v5
// pilot's "map" is now "map-v5pilot".
test("v4 and v5 pilot mission observations are byte-identical to the pre-v2 code", async () => {
  const cases = [["factory-full.json", "mission-factory-search.json", "basic", "11a401b745bd4d03"], ["residential.json", "mission-residential-delivery.json", "lidar", "a0d110cc73a4da97"], ["canyon-v5.json", "mission-canyon5-search.json", "map-v5pilot", "0b5058108da1861d"]];
  for (const [map, set, sensors, hash] of cases) {
    const W = new World(read(`../maps/${map}`));
    const m = read(`../scenarios/${set}`).train[0];
    const obs = [];
    let k = 0;
    const ep = await runEpisode(new RescueMission(W, m, m.seeds[0], { sensors }), async (o) => { obs.push(o); k++; return { command: { velocity: [Math.cos(k * 0.7) * 3, Math.sin(k * 0.3), Math.sin(k * 0.7) * 3] } }; });
    assert.equal(crypto.createHash("sha256").update(JSON.stringify({ obs, result: ep.result, frames: ep.frames })).digest("hex").slice(0, 16), hash, `${set} ${sensors}`);
  }
});

// ---------- defect 3: senses-only onboard map ----------
test("the onboard map reads only the drone's own scans: unscanned geometry and the hiker change nothing", () => {
  const spec = { kind: "find-beacon", start: [0, 1, 0], targetPosition: [30, 0.3, 30], detectionRange: 5, searchArea: { min: [-12, -12], max: [12, 12] } };
  // A box 25+ units away is beyond the 20-unit lidar: it must not appear.
  const a = new RescueMission(boxWorld(), spec, 1, { sensors: "map" }).observe();
  const b = new RescueMission(boxWorld([{ min: [24, 0, -2], max: [26, 3, 2] }]), { ...spec, targetPosition: [-30, 0.3, -30] }, 1, { sensors: "map" }).observe();
  assert.deepEqual(a, b);
  assert.equal("nearest_unsearched" in a.map, false);
  assert.ok(a.map.rows.join("").includes("?"), "unscanned cells stay unknown");
  // known_clear_m stops at unknown cells, never trusting true geometry.
  for (const d of Object.values(a.map.known_clear_m)) assert.ok(["unknown", "obstacle", "range"].includes(d.stops_at));
  // A wall the drone has seen shows as an obstacle and stops known_clear_m.
  const w = new RescueMission(boxWorld([{ min: [3, 0, -4], max: [3.5, 4, 4] }]), spec, 1, { sensors: "map" }).observe();
  assert.equal(w.map.known_clear_m.east.stops_at, "obstacle");
  assert.ok(w.map.known_clear_m.east.m <= 3);
  // The v5 pilot map is still available, unchanged, under its own name.
  assert.ok("nearest_unsearched" in new RescueMission(boxWorld(), spec, 1, { sensors: "map-v5pilot" }).observe().map);
  assert.throws(() => new RescueMission(boxWorld(), spec, 1, { sensors: "radar" }), /unknown sensors/);
});

// ---------- missions v2 search ----------
test("v2 search sets: disjoint train and dev, targets in their sector, hidden and away from launch", () => {
  const W = new World(read("../maps/factory-full.json"));
  const S = read("../scenarios/mission-v2-factory-search.json");
  assert.equal(S.train.length, 12);
  assert.equal(S.dev.length, 24);
  assert.equal("test" in S, false);
  const all = [...S.train, ...S.dev];
  for (const t of S.train) for (const d of S.dev) assert.ok(Math.hypot(t.targetPosition[0] - d.targetPosition[0], t.targetPosition[2] - d.targetPosition[2]) >= 4);
  for (const m of all) {
    const a = m.searchArea, t = m.targetPosition;
    assert.ok(t[0] >= a.min[0] && t[0] <= a.max[0] && t[2] >= a.min[1] && t[2] <= a.max[1], m.id);
    assert.ok(m.start[0] >= a.min[0] && m.start[0] <= a.max[0] && m.start[2] >= a.min[1] && m.start[2] <= a.max[1], m.id);
    assert.ok(Math.hypot(m.start[0] - t[0], m.start[2] - t[2]) >= 8, m.id);
    assert.equal(lineOfSight(W, m.start, t, Infinity), false, m.id);
    assert.ok(lineOfSight(W, m.oracleViewpoint, t, m.detectionRange), m.id);
    const obs = new RescueMission(W, m, m.seeds[0], { sensors: "map" }).observe();
    assert.deepEqual(obs.search.area.min, a.min);
    assert.equal(obs.search.target, null);
  }
  assert.equal(new Set(all.map((m) => m.id)).size, 36);
  assert.equal(new Set(all.flatMap((m) => m.seeds)).size, 72);
});

test("v2 search observations do not depend on where the hiker is", () => {
  const W = new World(read("../maps/factory-full.json"));
  const m = read("../scenarios/mission-v2-factory-search.json").train[0];
  const other = read("../scenarios/mission-v2-factory-search.json").train.find((x) => JSON.stringify(x.searchArea) !== JSON.stringify(m.searchArea));
  // Same start, area and seed; only the hidden target differs.
  const a = new RescueMission(W, m, 5, { sensors: "map" }), b = new RescueMission(W, { ...m, targetPosition: other.targetPosition }, 5, { sensors: "map" });
  for (let k = 0; k < 20; k++) {
    assert.deepEqual(a.observe(), b.observe());
    for (const e of [a, b]) { e.apply({ velocity: [1, 0, 1] }); for (let i = 0; i < 60; i++) e.tick(1 / 60); }
  }
  assert.equal(a.heading === b.heading, true);
});

test("sensor-only search references fly and replay exactly", async () => {
  const W = new World(read("../maps/factory-full.json"));
  const m = read("../scenarios/mission-v2-factory-search.json").train[11];
  for (const make of [() => coverageSweep(W, m), () => laneSweep(W, m), () => randomWalk(W, m, 3)]) {
    const env = new RescueMission(W, m, m.seeds[0], { sensors: "map" });
    const ep = await runEpisode(env, make(), { dt: 1 });
    const re = new RescueMission(W, m, m.seeds[0], { sensors: "map" });
    assert.deepEqual(replayEpisode(re, ep.decisions, { dt: 1 }), ep.result);
    assert.ok(["found", "timeout"].includes(ep.result.outcome));
  }
});

// ---------- missions v2 delivery ----------
const drop = { kind: "package-drop", start: [-4, 1, 0], targetPosition: [3, 0, 0], timeLimitSeconds: 20, padRadius: 0.5, maxReleaseHeight: 2 };
async function flyDrop(spec, { releaseAt = 1, heightOffset = 0, dx = 0, never = false } = {}) {
  const env = new RescueMission(boxWorld([wall]), spec, 1);
  const go = async (o) => {
    const hover = [spec.targetPosition[0] + dx, spec.targetPosition[1] + releaseAt + heightOffset, spec.targetPosition[2]];
    const to = v.sub(hover, o.position);
    if (o.delivery.parcel_status !== "carried") return { command: { velocity: [0, 0, 0] } };
    if (v.len(to) > 0.15 || v.len(o.velocity) > 0.1) {
      // Over the wall, then down to the hover point.
      const via = o.position[0] < 0.5 ? [o.position[0] < -0.5 ? 0 : 1, 4, 0] : hover;
      return { command: { velocity: v.clampLen(v.scale(v.sub(via, o.position), 1.5), 3) } };
    }
    return { command: { velocity: [0, 0, 0], ...(never ? {} : { release: true }) } };
  };
  const ep = await runEpisode(env, go, { dt: 0.25 });
  const re = new RescueMission(boxWorld([wall]), spec, 1);
  assert.deepEqual(replayEpisode(re, ep.decisions, { dt: 0.25 }), ep.result, "release replays exactly");
  return ep;
}

test("package-drop: release over the pad delivers and records the landing error", async () => {
  const ep = await flyDrop(drop);
  assert.equal(ep.result.outcome, "delivered");
  assert.ok(ep.result.drop.released);
  assert.ok(ep.result.drop.landingError < 0.5);
  assert.ok(Math.abs(ep.result.drop.releaseHeight - 1) < 0.2);
  assert.ok(ep.decisions.some((d) => d.command.release === true));
  const obs = new RescueMission(boxWorld([wall]), drop, 1).observe();
  assert.deepEqual(obs.delivery.pad_position, [3, 0, 0]);
  assert.equal(obs.delivery.max_release_height, 2);
});

test("package-drop: too high, off the pad, and never released all fail with the reason recorded", async () => {
  assert.equal((await flyDrop(drop, { heightOffset: 2 })).result.outcome, "released_too_high");
  const off = await flyDrop(drop, { dx: 0.9 });
  assert.equal(off.result.outcome, "missed_pad");
  assert.ok(Math.abs(off.result.drop.landingError - 0.9) < 0.2);
  const never = await flyDrop(drop, { never: true });
  assert.equal(never.result.outcome, "timeout");
  assert.equal(never.result.drop.released, false);
  // Earlier delivery kinds keep their result shape (no drop field).
  const old = new RescueMission(boxWorld([wall]), { kind: "package-delivery", start: [-3, 1, 0], targetPosition: [3, 0, 0] }, 1);
  assert.equal("drop" in old.result(), false);
});

test("v2 delivery sets: disjoint train and dev pads, explicit release, no test set", () => {
  const W = new World(read("../maps/factory-full.json"));
  const S = read("../scenarios/mission-v2-factory-delivery.json");
  assert.equal("test" in S, false);
  const pads = new Set();
  for (const m of [...S.train, ...S.dev]) {
    assert.equal(m.kind, "package-drop");
    assert.equal(m.padRadius, 0.5);
    assert.equal(m.maxReleaseHeight, 2);
    const k = m.targetPosition.join(",");
    assert.equal(pads.has(k), false);
    pads.add(k);
    new RescueMission(W, m, m.seeds[0]);
  }
});
