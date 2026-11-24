import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeClient, makeSlots } from "../tools/ripple_client.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-client-test-"));
  // A unique fake key gives each test its own machine-wide slot directory.
  fs.writeFileSync(path.join(root, ".env"), `OPENROUTER_API_KEY=test-${Math.random()}\n`);
  return root;
}
const ok = (content = "{}") => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ provider: "PrimeIntellect", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) });
const fail = (status, message) => ({ ok: false, status, headers: new Headers(), json: async () => ({ error: { message } }) });

test("failed attempts are logged by reason in retries.jsonl, never in calls.jsonl", async (t) => {
  const root = tmpRoot();
  const replies = [fail(429, "Rate limit exceeded"), fail(502, "Bad gateway"), ok()];
  t.mock.method(globalThis, "fetch", async () => replies.shift());
  const client = makeClient({ root, logFile: path.join(root, "calls.jsonl"), backoffBaseMs: 1, globalSlots: 4 });
  await client.chat([{ role: "user", content: "go" }], { scenario: "D1" });
  client.close();
  await sleep(20);
  assert.deepEqual(client.ledger.retryReasons, { 429: 1, 502: 1 });
  assert.equal(client.ledger.transportRetries, 2);
  assert.equal(client.ledger.calls, 1);
  assert.equal(fs.readFileSync(path.join(root, "calls.jsonl"), "utf8").trim().split("\n").length, 1);
  const retries = fs.readFileSync(path.join(root, "retries.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(retries.map((r) => r.reason), ["429", "502"]);
  assert.equal(retries[0].meta.scenario, "D1");
});

test("network errors are recorded with their error code", async (t) => {
  const root = tmpRoot();
  let n = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (n++ === 0) throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    return ok();
  });
  const client = makeClient({ root, backoffBaseMs: 1, globalSlots: 4 });
  await client.chat([]);
  assert.deepEqual(client.ledger.retryReasons, { ECONNRESET: 1 });
});

test("a rate limit cuts the in-flight limit, and successes grow it back", async (t) => {
  const root = tmpRoot();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    await sleep(2);
    return calls++ < 3 ? fail(429, "Too Many Requests") : ok();
  });
  const client = makeClient({ root, maxInFlight: 10, backoffBaseMs: 1, globalSlots: 0 });
  await Promise.all(Array.from({ length: 200 }, () => client.chat([])));
  assert.equal(client.ledger.limiter.minLimit, 7);
  assert.equal(client.ledger.limiter.finalLimit, 10);
});

test("clients sharing a key share the machine-wide slots", async (t) => {
  const root = tmpRoot();
  let live = 0;
  let peak = 0;
  t.mock.method(globalThis, "fetch", async () => {
    peak = Math.max(peak, ++live);
    await sleep(5);
    live--;
    return ok();
  });
  const a = makeClient({ root, maxInFlight: 10, globalSlots: 3 });
  const b = makeClient({ root, maxInFlight: 10, globalSlots: 3 });
  await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).chat([])));
  assert.equal(peak, 3);
  assert.equal(a.ledger.calls + b.ledger.calls, 30);
});

test("a slot held by a dead process is reclaimed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-slots-test-"));
  fs.writeFileSync(path.join(dir, "slot-0"), "999999");
  const slots = makeSlots(dir, 1);
  const release = await Promise.race([slots.acquire(), sleep(1000).then(() => null)]);
  assert.ok(release, "slot was not reclaimed");
  assert.equal(fs.readFileSync(path.join(dir, "slot-0"), "utf8"), String(process.pid));
  release();
  assert.equal(fs.existsSync(path.join(dir, "slot-0")), false);
});
