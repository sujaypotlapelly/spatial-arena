// Per-model settings for sim/bench/models.json, and the chat wrapper that
// records how every reply ended.
//
// Settings (each optional; registry "defaults" fill the gaps, then DEFAULTS):
//   maxTokens            reply budget per decision (default 400)
//   programMaxTokens     reply budget for a whole program in program mode (default 8000)
//   thinking             false: ask the host to skip reasoning; true: allow it;
//                        absent: send nothing (the host's default)
//   reasoningMaxTokens   with thinking: true, cap the reasoning (OpenRouter)
//   temperature          default 0.7, the same for every model unless set
//   retry.truncated      extra attempts when a reply is cut off by maxTokens
//                        (default 0). The harness's own rule, one retry for a
//                        reply that can't be used, applies to every model and
//                        is not configurable.
//
// The thinking switch is sent in OpenRouter's form ({ reasoning: { enabled } }).
// Other OpenAI-compatible servers each have their own switch (vLLM and SGLang:
// chat_template_kwargs.enable_thinking; Ollama: think): put it in extraBody,
// which is merged into every request as is.

import { entryExtraBody } from "../ripple_client.mjs";

export const DEFAULTS = { maxTokens: 400, programMaxTokens: 8000, temperature: 0.7, thinking: null, reasoningMaxTokens: null, retry: { truncated: 0 } };

export function resolveSettings(entry, registryDefaults = {}) {
  const pick = (k) => entry[k] ?? registryDefaults[k] ?? DEFAULTS[k];
  const s = {
    maxTokens: pick("maxTokens"),
    programMaxTokens: pick("programMaxTokens"),
    temperature: pick("temperature"),
    thinking: pick("thinking"),
    reasoningMaxTokens: pick("reasoningMaxTokens"),
    retry: { ...DEFAULTS.retry, ...(registryDefaults.retry ?? {}), ...(entry.retry ?? {}) },
  };
  if (!(Number.isInteger(s.programMaxTokens) && s.programMaxTokens > 0)) throw new Error(`${entry.id}: programMaxTokens must be a positive integer`);
  if (!(Number.isInteger(s.maxTokens) && s.maxTokens > 0)) throw new Error(`${entry.id}: maxTokens must be a positive integer`);
  if (!(typeof s.temperature === "number" && s.temperature >= 0 && s.temperature <= 2)) throw new Error(`${entry.id}: temperature must be a number from 0 to 2`);
  if (![true, false, null].includes(s.thinking)) throw new Error(`${entry.id}: thinking must be true, false or left out`);
  if (!(Number.isInteger(s.retry.truncated) && s.retry.truncated >= 0 && s.retry.truncated <= 3)) throw new Error(`${entry.id}: retry.truncated must be 0 to 3`);
  // What goes into each request besides model, messages, temperature,
  // max_tokens: the same rule every tool uses (ripple_client.mjs entryExtraBody).
  const extraBody = entryExtraBody({ ...entry, thinking: s.thinking, reasoningMaxTokens: s.reasoningMaxTokens });
  const warnings = [];
  if (s.thinking !== null && entry.baseUrl && !entry.extraBody) warnings.push(`${entry.id}: "thinking": ${s.thinking} is recorded but not sent, because ${entry.baseUrl} is not OpenRouter. Put that server's own switch in extraBody.`);
  const nonStandard = [];
  if (s.temperature !== DEFAULTS.temperature) nonStandard.push(`temperature ${s.temperature}`);
  if (s.retry.truncated) nonStandard.push(`${s.retry.truncated} extra attempt(s) on cut-off replies`);
  return { ...s, extraBody, warnings, nonStandard };
}

const isCut = (r) => r?.finish === "length";

// Wraps chat(messages, meta, opts) -> { content, finish, usage, latencyMs }.
// Re-asks up to retryTruncated times when the reply was cut off, and records
// every call: finish reasons, cut-offs, tokens (reasoning tokens too, when the
// host reports them), cost when the host reports it, latency.
export function instrumentChat(chat, { retryTruncated = 0 } = {}) {
  const stats = { calls: 0, finishes: {}, truncatedCalls: 0, truncationRetries: 0, emptyReplies: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, costUsd: null, latenciesMs: [] };
  const note = (r) => {
    stats.calls++;
    const f = r?.finish ?? "unknown";
    stats.finishes[f] = (stats.finishes[f] || 0) + 1;
    if (isCut(r)) stats.truncatedCalls++;
    if (!r?.content) stats.emptyReplies++;
    const u = r?.usage ?? {};
    stats.promptTokens += u.prompt_tokens || 0;
    stats.completionTokens += u.completion_tokens || 0;
    stats.reasoningTokens += u.completion_tokens_details?.reasoning_tokens || u.reasoning_tokens || 0;
    if (typeof u.cost === "number") stats.costUsd = (stats.costUsd ?? 0) + u.cost;
    if (typeof r?.latencyMs === "number") stats.latenciesMs.push(r.latencyMs);
  };
  const wrapped = async (messages, meta = {}, opts) => {
    let r = await chat(messages, meta, opts);
    note(r);
    for (let k = 0; k < retryTruncated && isCut(r); k++) {
      stats.truncationRetries++;
      r = await chat(messages, { ...meta, truncationRetry: k + 1 }, opts);
      note(r);
    }
    return r;
  };
  return { chat: wrapped, stats };
}

export function summarizeStats(stats, price = null) {
  const L = [...stats.latenciesMs].sort((a, b) => a - b);
  const q = (p) => (L.length ? L[Math.min(L.length - 1, Math.floor(p * L.length))] : null);
  const estimated = price && (stats.promptTokens || stats.completionTokens) ? (stats.promptTokens * price.in + stats.completionTokens * price.out) / 1e6 : null;
  const { latenciesMs, ...rest } = stats;
  return {
    ...rest,
    costUsd: stats.costUsd ?? estimated,
    costSource: stats.costUsd != null ? "reported by the host" : estimated != null ? "estimated from models.json prices" : null,
    latencyMs: { median: q(0.5), p90: q(0.9), max: L.length ? L[L.length - 1] : null },
  };
}
