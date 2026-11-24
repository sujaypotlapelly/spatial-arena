import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.js';
import { RescueMission, normalizeMission } from '../src/gym/rescue_tasks.js';
import { runEpisode, replayEpisode } from '../src/gym/core.js';

const physics = { dt: 1 / 60, droneRadius: .25, droneMaxSpeed: 5.5, droneMaxAccel: 7, gust: 0 };
const floor = { min: [-20, -1, -20], max: [20, 0, 20] };
function world(extraBoxes = []) {
  return new World({ physics, bounds: { min: [-20, -2, -20], max: [20, 10, 20] },
    waypoints: {}, edges: [], boxes: [floor, ...extraBoxes] });
}
function advance(env, frames) { for (let i = 0; i < frames; i++) env.tick(physics.dt); }
const searchSpec = { kind: 'find-beacon', start: [-3, 1, 0], targetPosition: [3, 1, 0], detectionRange: 8 };
const wall = { min: [-.2, 0, -2], max: [.2, 3, 2] };
const deliverySpec = { kind: 'delivery-checkpoint', start: [-3, 1, 0], targetPosition: [3, 1, 0] };
const packageSpec = { kind: 'package-delivery', start: [-3, 1, 0], targetPosition: [3, 0, 0], timeLimitSeconds: 30 };

test('hidden hiker position cannot change observations or initial heading', () => {
  const a = new RescueMission(world([wall]), searchSpec, 1);
  const b = new RescueMission(world([wall]), { ...searchSpec, targetPosition: [3, 1, 1] }, 1);
  assert.deepEqual(a.observe(), b.observe());
  assert.equal(Object.hasOwn(a.observe(), 'goal'), false);
  assert.equal(a.observe().search.target, null);
  assert.equal(a.observe().search.target_location_known, false);
  assert.equal(a.heading, 0);
});

test('search requires line of sight as well as range', () => {
  const env = new RescueMission(world([wall]), searchSpec, 1);
  env.apply({ velocity: [0, 0, 0] });
  advance(env, 30);
  assert.equal(env.done, false, 'A nearby target behind a wall is not found');
  assert.equal(env.foundAt, null);
  // Move the fixture past the wall to test the sensor rule, not a flight policy.
  env.drone.pos = [1, 1, 0];
  advance(env, 1);
  assert.equal(env.result().outcome, 'found');
  assert.deepEqual(env.observe().search.target.position, [3, 1, 0]);
  assert.equal(env.observe().search.target_location_known, true);
});

test('clear but distant targets remain unknown, and unfound episodes time out', () => {
  const spec = { ...searchSpec, targetPosition: [8, 1, 0], detectionRange: 6, timeLimitSeconds: .5 };
  const env = new RescueMission(world(), spec, 1);
  env.apply({ velocity: [0, 0, 0] });
  advance(env, 30);
  assert.equal(env.result().outcome, 'timeout');
  assert.equal(env.result().targetFound, false);
  assert.equal(env.observe().search.target, null);
});

test('invalid definitions and trivially visible search launches are rejected', () => {
  assert.throws(() => normalizeMission({ ...searchSpec, kind: 'reach-but-call-it-search' }), /Unknown/);
  assert.throws(() => normalizeMission({ ...searchSpec, detectionRange: 0 }), /positive/);
  assert.throws(() => normalizeMission({ ...searchSpec, start: [NaN, 0, 0] }), /finite triples/);
  assert.throws(() => new RescueMission(world(), searchSpec, 1), /hidden at launch/);
  assert.throws(() => new RescueMission(world(), { ...packageSpec, releaseHeight: .1 }, 1), /no space/);
});

test('delivery hold must be continuous and resets after leaving the pad', () => {
  const env = new RescueMission(world(), deliverySpec, 1);
  env.drone.pos = [3, 1, 0];
  env.apply({ velocity: [0, 0, 0] });
  advance(env, 60);
  assert.equal(env.done, false);
  assert.ok(Math.abs(env.holdSeconds - 1) < 1e-9);
  env.drone.pos = [4, 1, 0]; advance(env, 1);
  assert.equal(env.holdSeconds, 0);
  env.drone.pos = [3, 1, 0]; advance(env, 119);
  assert.equal(env.done, false);
  advance(env, 1);
  assert.equal(env.result().outcome, 'delivery_checkpoint');
  assert.equal(env.result().payload, null, 'Checkpoint completion is not parcel placement');
});

test('a fast flyby cannot confirm delivery or trigger parcel release', () => {
  for (const spec of [deliverySpec, packageSpec]) {
    const env = new RescueMission(world(), spec, 1);
    env.drone.pos = [3, 1, 0]; env.drone.vel = [1, 0, 0];
    env.apply({ velocity: [1, 0, 0] }); advance(env, 1);
    assert.equal(env.holdSeconds, 0);
    assert.equal(env.done, false);
    assert.equal(env.events.length, 0);
    if (env.payload) assert.equal(env.payload.status, 'carried');
  }
});

test('package delivery requires release followed by a collision-checked landing', () => {
  const env = new RescueMission(world(), { ...packageSpec, requiredHoldSeconds: .1 }, 1);
  env.drone.pos = [3, 1, 0]; env.apply({ velocity: [0, 0, 0] });
  advance(env, 6);
  assert.equal(env.payload.status, 'falling');
  assert.equal(env.done, false, 'Release alone is not delivery');
  assert.deepEqual(env.events.map(e => e.type), ['payload_released']);
  assert.equal(env.events[0].mode, 'automatic_after_stable_hover');
  advance(env, 60);
  assert.equal(env.result().outcome, 'delivered');
  assert.equal(env.payload.status, 'landed');
  assert.ok(env.payload.position[1] >= packageSpec.targetPosition[1]);
  assert.ok(env.payload.position[1] < .15);
  assert.equal(env.events.at(-1).type, 'payload_landed');
  assert.equal(env.events.at(-1).insidePad, true);
});

test('a parcel that drifts beyond the marked pad is not delivered', () => {
  const env = new RescueMission(world(), { ...packageSpec, requiredHoldSeconds: .1 }, 1);
  env.drone.pos = [3.5, 1, 0]; env.drone.vel = [.3, 0, 0];
  env.apply({ velocity: [.3, 0, 0] }); advance(env, 90);
  assert.equal(env.payload.status, 'landed');
  assert.equal(env.result().outcome, 'misdelivered');
  assert.equal(env.events.at(-1).insidePad, false);
  assert.ok(env.events.at(-1).horizontalDistance > .6);
});

test('landing on an elevated obstruction does not count as landing on the ground pad', () => {
  const platform = { min: [2.5, .1, -.5], max: [3.5, .4, .5] };
  const env = new RescueMission(world([platform]), { ...packageSpec, requiredHoldSeconds: .1 }, 1);
  env.drone.pos = [3, 1, 0]; env.apply({ velocity: [0, 0, 0] }); advance(env, 90);
  assert.equal(env.result().outcome, 'misdelivered');
  assert.equal(env.events.at(-1).insidePad, false);
  assert.ok(env.events.at(-1).heightError > .4);
});

test('saved package commands reproduce the result, parcel events, drone and parcel frames exactly', async () => {
  const env = new RescueMission(world(), packageSpec, 3);
  // A scripted fixture controller, not a model or residential demonstration.
  const episode = await runEpisode(env, async obs => ({ command: {
    velocity: obs.goal.position.map((value, k) => Math.max(-1.5, Math.min(1.5, (value - obs.position[k]) * 1.5))),
  } }));
  assert.equal(episode.result.outcome, 'delivered');
  const replay = new RescueMission(world(), packageSpec, 3);
  assert.deepEqual(replayEpisode(replay, episode.decisions), episode.result);
  assert.deepEqual(replay.frames, episode.frames);
  assert.equal(env.payloadFrames.length, episode.frames.length);
  assert.deepEqual(replay.payloadFrames, env.payloadFrames);
  assert.equal(env.payloadFrames.at(-1).status, 'landed');
  const end = structuredClone(replay.result());
  const payloadFrames = structuredClone(replay.payloadFrames);
  replay.tick(physics.dt);
  assert.deepEqual(replay.result(), end, 'Finished missions do not keep advancing');
  assert.deepEqual(replay.payloadFrames, payloadFrames);
});
