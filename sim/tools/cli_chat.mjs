// Chat backends that call the locally authenticated Claude Code and Codex
// CLIs as plain text generators, so frontier models can run through the same
// harness as the OpenRouter models. Same interface as makeClient():
// { chat(messages, meta, opts) -> { content, provider, usage, latencyMs, finish }, ledger, model, provider, close }.
//
// claude: our system prompt REPLACES Claude Code's, all tools are off, no MCP
//   servers, no settings files (so no user hooks), no session saved. The model
//   sees only our prompt.
// codex: Codex keeps its own agent instructions (~26k tokens) around our
//   prompt; it runs read-only in an empty scratch directory with no session
//   saved. Report this as a known confound.
// Neither CLI exposes temperature; reasoning effort is recorded instead.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function runCmd(cmd, args, stdin, { timeoutMs = 300000, cwd } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
    p.stdin.end(stdin);
  });
}

export function makeCliClient({ backend, model = null, effort = null, maxInFlight = 4, logFile = null, timeoutMs = 300000 }) {
  if (!["claude", "codex"].includes(backend)) throw new Error(`unknown CLI backend ${backend}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${backend}-`)); // empty cwd: no CLAUDE.md / AGENTS.md / repo
  let inFlight = 0;
  const queue = [];
  const acquire = () => (inFlight < maxInFlight ? (inFlight++, Promise.resolve()) : new Promise((r) => queue.push(r)));
  const release = () => { inFlight--; if (queue.length) { inFlight++; queue.shift()(); } };
  const ledger = { calls: 0, transportRetries: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, providers: {}, retryReasons: {}, backend, effort };
  const log = logFile ? fs.createWriteStream(logFile, { flags: "a" }) : null;
  const retryLog = logFile ? fs.createWriteStream(path.join(path.dirname(logFile), "retries.jsonl"), { flags: "a" }) : null;

  async function once(messages) {
    const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const user = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");
    if (backend === "claude") {
      const args = ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--system-prompt", sys];
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      const r = await runCmd("claude", args, user, { timeoutMs, cwd: work });
      let d = null;
      try { d = JSON.parse(r.out); } catch {}
      if (!d || d.is_error || r.code !== 0) throw Object.assign(new Error((d?.result || r.err || `exit ${r.code}`).slice(0, 300)), { reason: d?.is_error ? "cli_error" : `exit_${r.code ?? r.signal}` });
      const u = d.usage || {};
      return { content: d.result || "", provider: `claude-cli:${model || "default"}`, usage: { prompt_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), completion_tokens: u.output_tokens || 0, reasoning_tokens: u.output_tokens_details?.thinking_tokens || 0 }, finish: d.stop_reason === "max_tokens" ? "length" : "stop", apiMs: d.duration_api_ms };
    }
    const outFile = path.join(work, `last-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    const args = ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-C", work, "--json", "-o", outFile];
    if (model) args.push("-m", model);
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    args.push("-");
    const r = await runCmd("codex", args, `${sys}\n\n${user}`, { timeoutMs, cwd: work });
    let usage = {}, content = null;
    for (const line of r.out.split("\n")) {
      try {
        const o = JSON.parse(line);
        if (o.type === "turn.completed") usage = o.usage || {};
        if (o.type === "item.completed" && o.item?.type === "agent_message") content = o.item.text;
      } catch {}
    }
    try { content ??= fs.readFileSync(outFile, "utf8"); fs.unlinkSync(outFile); } catch {}
    if (r.code !== 0 || content == null) throw Object.assign(new Error((r.err || `exit ${r.code}`).slice(-300)), { reason: `exit_${r.code ?? r.signal}` });
    return { content, provider: `codex-cli:${model || "default"}`, usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, reasoning_tokens: usage.reasoning_output_tokens || 0 }, finish: "stop" };
  }

  async function chat(messages, meta = {}) {
    await acquire();
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const t0 = Date.now();
        try {
          const out = await once(messages);
          out.latencyMs = Date.now() - t0;
          ledger.calls++;
          ledger.promptTokens += out.usage.prompt_tokens;
          ledger.completionTokens += out.usage.completion_tokens;
          ledger.reasoningTokens += out.usage.reasoning_tokens;
          ledger.providers[out.provider] = (ledger.providers[out.provider] || 0) + 1;
          log?.write(JSON.stringify({ ...meta, provider: out.provider, latencyMs: out.latencyMs, finish: out.finish, usage: out.usage, content: out.content }) + "\n");
          return out;
        } catch (err) {
          const reason = err.reason || "error";
          ledger.transportRetries++;
          ledger.retryReasons[reason] = (ledger.retryReasons[reason] || 0) + 1;
          retryLog?.write(JSON.stringify({ ts: new Date().toISOString(), reason, error: String(err.message).slice(0, 300), attempt, latencyMs: Date.now() - t0, meta }) + "\n");
          // Usage limits and auth problems must not be scored as model behaviour.
          if (/usage limit|rate limit|log ?in|authenticat|credit|quota/i.test(err.message)) {
            console.error(`\nFATAL (${backend} CLI): ${err.message}. Aborting; no results written for this call.`);
            process.exit(2);
          }
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        }
      }
      throw Object.assign(new Error(`${backend} CLI failed after 4 attempts`), { transport: true });
    } finally {
      release();
    }
  }
  return { chat, ledger, model: model || `${backend}-default`, provider: `${backend}-cli`, temperature: null, effort, close: () => { log?.end(); retryLog?.end(); try { fs.rmSync(work, { recursive: true, force: true }); } catch {} } };
}
