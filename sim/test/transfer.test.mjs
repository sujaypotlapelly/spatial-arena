// Transfer study tooling: failure classes,
// route-clustered intervals, the building's dev routes, and the opt-in mixed
// practice in reach_cap.mjs leaving the default prompt untouched.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFlight, clusterCI } from "../tools/transfer_matrix.mjs";
import { loadEnvironment, devRoutes } from "../tools/benchmark_env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cap = path.join(here, "../tools/reach_cap.mjs");
const prompt = (...a) => execFileSync(process.execPath, [cap, ...a, "--print-prompt"], { encoding: "utf8" });

const S = (t, pos, cmd = [0, 0, 0], down = 5, up = 5) => ({ t, pos, cmd, down, up });
const fail = (endPos) => ({ outcome: "timeout", endPos });

test("classifyFlight: reached, error, altitude, stuck, timeout", () => {
  const goal = [20, 1, 0];
  assert.equal(classifyFlight([], goal, { outcome: "reached" }), "reached");
  const moving = Array.from({ length: 90 }, (_, t) => S(t, [t % 30, 1, Math.floor(t / 30) * 5]));
  assert.equal(classifyFlight(moving, goal, fail([29, 1, 10]), 30), "error");
  // pinned on the ground while commanding down for most of the flight
  const pinned = Array.from({ length: 90 }, (_, t) => S(t, [t / 10, 5, 0], [1, -2, 0], 0));
  assert.equal(classifyFlight(pinned, [20, 1, 0], fail([9, 5, 0])), "altitude");
  // under the goal horizontally, wrong floor
  const under = Array.from({ length: 90 }, (_, t) => S(t, [Math.min(t, 19), 1, 0]));
  assert.equal(classifyFlight(under, [20, 6, 0], fail([19, 1, 0])), "altitude");
  // cruising far outside the start-goal height band
  const band = Array.from({ length: 90 }, (_, t) => S(t, [t / 3, 1, t % 7], [1, 0, 0]));
  assert.equal(classifyFlight([S(0, [0, 10, 0]), ...band.slice(1)], [40, 12, 0], fail([30, 1, 5])), "altitude");
  // in band, hardly moving at the end
  const stuck = Array.from({ length: 90 }, (_, t) => S(t, [Math.min(t, 10), 1, 0]));
  assert.equal(classifyFlight(stuck, goal, fail([10, 1, 0])), "stuck");
  assert.equal(classifyFlight(moving, goal, fail([29, 1, 10])), "timeout");
});

test("clusterCI resamples whole routes and ignores row order", () => {
  const rows = [];
  for (let i = 0; i < 10; i++) for (const seed of [1, 2]) rows.push({ scenario: `r${i}`, seed, ok: i < 6 ? 1 : 0 });
  const stat = (rs) => rs.reduce((a, r) => a + r.ok, 0) / rs.length;
  const a = clusterCI(rows, stat), b = clusterCI(rows.slice().reverse(), stat);
  assert.deepEqual(a, b);
  assert.ok(a[0] < 0.6 && a[1] > 0.6);
});

test("devRoutes: pinned dev sets unchanged; the building gets 24 dev routes disjoint from its test set", () => {
  const F = loadEnvironment("factory");
  assert.equal(devRoutes(F), F.sets.dev);
  const B = loadEnvironment("building");
  const dev = devRoutes(B);
  assert.equal(dev.length, 24);
  const key = (s) => [s.start, s.goal].sort().join("|");
  const testKeys = new Set(B.sets.test.map(key));
  assert.equal(dev.filter((s) => testKeys.has(key(s))).length, 0);
  assert.equal(new Set(dev.map(key)).size, 24);
  assert.deepEqual(devRoutes(B), dev);
});

test("reach_cap default prompts are unchanged; --mix only swaps the scene and route sentences", () => {
  // sha256 of the factory prompt as published (v3/v4), checked with --print-prompt on 2026-11-19
  const factory = prompt();
  assert.equal(crypto.createHash("sha256").update(factory).digest("hex"), FACTORY_PROMPT_SHA256);
  const F = loadEnvironment("factory"), C = loadEnvironment("canyon");
  const mixed = prompt("--mix", "factory,canyon");
  const expected = factory.replace(F.scene, `The program is flown in 2 different places. Place 1: ${F.scene} Place 2: ${C.scene}`);
  assert.equal(mixed, expected);
  assert.throws(() => prompt("--mix", "factory"));
});

const FACTORY_PROMPT_SHA256 = "e78c05442d3546254ea974855fcba8cc1dc39a192ca5660a0a7a85c52c8290b4";
