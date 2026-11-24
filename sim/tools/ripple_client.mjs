// Shared Ripple client for v2 tools: direct to OpenRouter, one pinned host,
// bounded concurrency, transport retries (429/5xx/network) that are never
// counted as model decisions, and a hard abort on account/auth/request
// errors so they can never be scored as model behavior.
//
// Throughput controls (transport only; they never change what the model sees):
// - Machine-wide slots: every client on this machine using the same key, host
//   and model shares RIPPLE_GLOBAL_SLOTS in-flight requests (default 24, the
//   rate the pinned host sustains; 0 turns it off). Slots are lock files in the
//   OS temp dir; a slot held by a dead process is reclaimed.
// - Adaptive per-process limit: starts at maxInFlight, cuts by 30% on a rate
//   limit (at most once per 2 s), and grows back by 1 after each `limit`
//   successes.
// - Every failed attempt is logged with its reason to retries.jsonl next to
//   the call log (calls.jsonl stays one line per model decision), and counted
//   in ledger.retryReasons. Backoff has jitter and honors Retry-After.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- machine-wide slots (lock files) ----------
const heldSlots = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  const cleanup = () => { for (const f of heldSlots) try { fs.unlinkSync(f); } catch {} heldSlots.clear(); };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { cleanup(); process.exit(sig === "SIGINT" ? 130 : 143); });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

export function makeSlots(dir, n) {
  if (!n) return { acquire: async () => () => {}, n: 0, dir: null };
  fs.mkdirSync(dir, { recursive: true });
  hookExit();
  const tryTake = (i) => {
    const f = path.join(dir, `slot-${i}`);
    try {
      fs.closeSync(fs.openSync(f, "wx"));
      fs.writeFileSync(f, String(process.pid));
      heldSlots.add(f);
      return f;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const pid = Number(fs.readFileSync(f, "utf8") || NaN);
        // An empty file is a slot being written right now, unless it is stale
        // (owner died between create and write). Otherwise reclaim only dead owners.
        const stale = pid ? pid !== process.pid && !alive(pid) : Date.now() - fs.statSync(f).mtimeMs > 10000;
        if (stale) fs.unlinkSync(f);
      } catch {}
      return null;
    }
  };
  async function acquire(stats) {
    const t0 = Date.now();
    for (;;) {
      const start = Math.floor(Math.random() * n);
      for (let k = 0; k < n; k++) {
        const f = tryTake((start + k) % n);
        if (f) {
          if (stats) stats.globalWaitMs += Date.now() - t0;
          return () => { heldSlots.delete(f); try { fs.unlinkSync(f); } catch {} };
        }
      }
      await sleep(20 + Math.random() * 40);
    }
  }
  return { acquire, n, dir };
}

const isRateLimit = (status, msg) => status === 429 || /rate.?limit|too many requests/i.test(msg || "");

// Model and host are parameters so the same client serves the multi-model
// benchmark (sim/tools/bench.mjs). Defaults are unchanged: Ripple, pinned to
// PrimeIntellect with no fallbacks. provider: null sends no pin (OpenRouter
// routes; the host is still logged per call). quantizations restricts hosts
// by precision (e.g. ["bf16"]). extraBody is merged into every request (e.g.
// { reasoning: { enabled: false } } for hybrid-thinking models).
// baseUrl: any OpenAI-compatible endpoint (a local server such as Ollama or
// vLLM, or another provider). The host pin and precision filter are
// OpenRouter routing options and are not sent to other endpoints. apiKeyEnv
// names the variable holding that endpoint's key (in .env or the
// environment); leave it out for a local server that needs none.
export function makeClient({ root, model = null, provider = "PrimeIntellect", quantizations = null, extraBody = null, temperature = 0.7, maxInFlight = 24, logFile = null, maxTokens = 400, globalSlots = undefined, backoffBaseMs = 500, baseUrl = null, apiKeyEnv = null }) {
  // ARENA_ENV_FILE points at a key file elsewhere (a git worktree has no .env).
  const envFile = process.env.ARENA_ENV_FILE ? path.resolve(process.env.ARENA_ENV_FILE) : path.join(root, ".env");
  const env = !fs.existsSync(envFile) ? {} : Object.fromEntries(
    fs.readFileSync(envFile, "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
  );
  const URL_ = `${(baseUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, "")}/chat/completions`;
  const keyName = baseUrl ? apiKeyEnv : "OPENROUTER_API_KEY";
  const KEY = keyName ? env[keyName] ?? process.env[keyName] : "none";
  const MODEL = model || env.RIPPLE_MODEL || "ricursiveai/ripple-65b-preview";
  if (baseUrl) provider = null;
  const routing = baseUrl ? null : provider
    ? { only: [provider], allow_fallbacks: false, ...(quantizations ? { quantizations } : {}) }
    : quantizations ? { quantizations } : null;

  // Machine-wide slots, keyed by account + host + model (the key is hashed, never written out).
  const nGlobal = Number(globalSlots ?? process.env.RIPPLE_GLOBAL_SLOTS ?? 24);
  const slotKey = crypto.createHash("sha256").update(`${KEY}|${provider}|${MODEL}`).digest("hex").slice(0, 12);
  const slots = makeSlots(path.join(os.tmpdir(), `ripple-slots-${slotKey}`), nGlobal);

  // Adaptive per-process limit (AIMD).
  let limit = maxInFlight;
  let inFlight = 0;
  let okSinceGrow = 0;
  let lastCut = 0;
  const queue = [];
  const acquire = () => (inFlight < limit ? (inFlight++, Promise.resolve()) : new Promise((r) => queue.push(r)));
  const pump = () => { while (queue.length && inFlight < limit) { inFlight++; queue.shift()(); } };
  const release = () => { inFlight--; pump(); };
  const onOk = () => {
    if (limit < maxInFlight && ++okSinceGrow >= limit) { limit++; okSinceGrow = 0; pump(); }
  };
  const onRateLimit = () => {
    const now = Date.now();
    if (now - lastCut < 2000) return;
    lastCut = now;
    okSinceGrow = 0;
    limit = Math.max(1, Math.floor(limit * 0.7));
    ledger.limiter.minLimit = Math.min(ledger.limiter.minLimit, limit);
  };

  const ledger = {
    calls: 0, transportRetries: 0, promptTokens: 0, completionTokens: 0, providers: {},
    retryReasons: {},
    limiter: { maxInFlight, minLimit: maxInFlight, finalLimit: maxInFlight, globalSlots: slots.n, globalWaitMs: 0 },
  };
  const log = logFile ? fs.createWriteStream(logFile, { flags: "a" }) : null;
  const retryLog = logFile ? fs.createWriteStream(path.join(path.dirname(logFile), "retries.jsonl"), { flags: "a" }) : null;

  async function chat(messages, meta = {}, { max_tokens = maxTokens } = {}) {
    if (!KEY) throw Object.assign(new Error(`${keyName} missing in .env`), { transport: true });
    await acquire();
    try {
      // Rate limits (429) are expected under load: keep waiting (up to ~25 min)
      // instead of failing the whole run. Other transport errors get 7 tries.
      let hardFailures = 0;
      for (let attempt = 0; hardFailures < 7 && attempt < 60; attempt++) {
        const releaseSlot = await slots.acquire(ledger.limiter);
        const t0 = Date.now();
        let status = null;
        let retryAfterMs = 0;
        try {
          let res;
          try {
            res = await fetch(URL_, {
              method: "POST",
              headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ ...(extraBody || {}), model: MODEL, messages, temperature, max_tokens, ...(routing ? { provider: routing } : {}) }),
            });
          } finally {
            releaseSlot();
          }
          status = res.status;
          const ra = Number(res.headers?.get?.("retry-after"));
          if (ra > 0) retryAfterMs = ra * 1000;
          const body = await res.json().catch(() => ({}));
          if (!res.ok || !body.choices) {
            const msg = body.error?.message || `HTTP ${res.status}`;
            if ([400, 401, 402, 403].includes(res.status)) {
              console.error(`\nFATAL: ${msg}. Aborting; no results written.`);
              process.exit(2);
            }
            // OpenRouter can return an upstream error inside a 200; prefer its code.
            if (res.ok && Number(body.error?.code)) status = Number(body.error.code);
            throw Object.assign(new Error(msg), { status });
          }
          const out = { content: body.choices[0].message?.content || "", provider: body.provider ?? (baseUrl ? new URL(URL_).host : undefined), usage: body.usage, latencyMs: Date.now() - t0, finish: body.choices[0].finish_reason };
          ledger.calls++;
          ledger.promptTokens += body.usage?.prompt_tokens || 0;
          ledger.completionTokens += body.usage?.completion_tokens || 0;
          ledger.providers[out.provider] = (ledger.providers[out.provider] || 0) + 1;
          log?.write(JSON.stringify({ ...meta, provider: out.provider, latencyMs: out.latencyMs, finish: out.finish, usage: body.usage, content: out.content }) + "\n");
          onOk();
          return out;
        } catch (err) {
          const code = err.status ?? status ?? (err.cause?.code || "network");
          const reason = String(code);
          ledger.transportRetries++;
          ledger.retryReasons[reason] = (ledger.retryReasons[reason] || 0) + 1;
          if (isRateLimit(Number(code), err.message)) onRateLimit();
          else hardFailures++;
          const backoff = Math.min(30000, Math.max(retryAfterMs, backoffBaseMs * 2 ** attempt * (0.5 + Math.random())));
          retryLog?.write(JSON.stringify({ ts: new Date().toISOString(), reason, error: String(err.message).slice(0, 300), attempt, latencyMs: Date.now() - t0, backoffMs: Math.round(backoff), limit, meta }) + "\n");
          await sleep(backoff);
        }
      }
      // Marked so the controller rethrows it instead of scoring it as a model decision.
      throw Object.assign(new Error(`transport failed (${hardFailures} non-rate-limit errors)`), { transport: true });
    } finally {
      ledger.limiter.finalLimit = limit;
      release();
    }
  }
  return { chat, ledger, model: MODEL, provider, quantizations, extraBody, temperature, close: () => { log?.end(); retryLog?.end(); } };
}

// Fails fast (exit 2) if the account can't serve calls, before any matches run.
export async function preflight(client) {
  const r = await client.chat([{ role: "user", content: 'Reply with {"ok": true}' }], { role: "preflight" }, { max_tokens: 10 });
  return r.provider;
}

// A client for one entry of the model list (sim/bench/models.json), so every
// tool flies a model the same way: same host pin, precision and options.
export function modelEntry(root, id, file = null) {
  const registry = JSON.parse(fs.readFileSync(file ? path.resolve(file) : path.join(root, "sim/bench/models.json"), "utf8"));
  const entry = registry.models.find((m) => m.id === id);
  if (!entry) throw new Error(`unknown model "${id}": add it to sim/bench/models.json (known: ${registry.models.map((m) => m.id).join(", ")})`);
  if (entry.backend) throw new Error(`${id} runs through a local CLI and is only supported by bench.mjs`);
  return entry;
}
// The request extras for an entry: its extraBody, plus the thinking switch
// ("thinking": false or true) in OpenRouter's form. Endpoints given by baseUrl
// carry their own switch in extraBody (sim/tools/arena/model_settings.mjs).
export function entryExtraBody(entry) {
  const t = entry.thinking;
  if (t !== true && t !== false) return entry.extraBody ?? null;
  if (entry.baseUrl) return entry.extraBody ?? null;
  const base = entry.extraBody ?? {};
  return { ...base, reasoning: { ...(base.reasoning ?? {}), enabled: t, ...(t && entry.reasoningMaxTokens ? { max_tokens: entry.reasoningMaxTokens } : {}) } };
}
export const clientFor = (root, entry, extra = {}) => makeClient({
  root, model: entry.model, provider: entry.provider ?? null, quantizations: entry.quantizations ?? null, extraBody: entryExtraBody(entry),
  baseUrl: entry.baseUrl ?? null, apiKeyEnv: entry.apiKeyEnv ?? null, ...extra,
});
