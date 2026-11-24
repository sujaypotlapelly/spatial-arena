import test from "node:test";
import assert from "node:assert/strict";
import { ModelClient } from "../src/agents.js";

test("the model client reports usage and recovers after a failed request", async (t) => {
  let fails = true;
  t.mock.method(globalThis, "fetch", async () => ({
    ok: !fails,
    status: fails ? 502 : 200,
    json: async () => fails
      ? { error: "Ripple reached its output limit", usage: { prompt_tokens: 10, completion_tokens: 700 } }
      : { content: '{"route_id":"R1"}', model: "ricursiveai/ripple-65b-preview", usage: { prompt_tokens: 12, completion_tokens: 900 } },
  }));
  const client = new ModelClient({ enabled: true });
  await assert.rejects(client.chat([{ role: "user", content: "Plan" }]), /output limit/);
  assert.match(client.lastError, /output limit/);
  assert.equal(client.ledger.completionTokens, 700);
  fails = false;
  const reply = await client.chat([{ role: "user", content: "Plan" }]);
  assert.equal(reply.model, "ricursiveai/ripple-65b-preview");
  assert.equal(client.lastError, null);
  assert.equal(client.ledger.calls, 2);
  assert.equal(client.ledger.failures, 1);
  assert.equal(client.ledger.completionTokens, 1600);
});

test("an empty reply is a failure rather than a connected-model success", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ content: "" }) }));
  const client = new ModelClient({ enabled: true });
  await assert.rejects(client.chat([]), /no final decision/);
  assert.equal(client.ledger.failures, 1);
  assert.match(client.lastError, /no final decision/);
});
