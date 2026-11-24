// A local stand-in for an OpenAI-compatible chat endpoint, for trying the
// arena without a key or a bill. It answers POST /v1/chat/completions.
//
//   node sim/tools/arena/mock_openai.mjs --mode steady --port 8789
//
// Modes:
//   steady     reads the drone's sensors from the prompt and flies at the goal
//              (a fixed sensible velocity); writes a simple program when asked
//              for one
//   truncate   every reply is cut off halfway (finish_reason "length")
//   malformed  every reply is prose, not JSON (finish_reason "stop")
//   thinker    "thinks" for about 600 tokens before answering, unless the
//              request turns thinking off ({ reasoning: { enabled: false } }
//              or { chat_template_kwargs: { enable_thinking: false } }); a
//              small max_tokens then cuts the reply off, as real reasoning
//              models do
// Token counts are characters / 4. Every reply reports a cost of $1e-6 per
// token so cost reporting can be checked.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tok = (s) => Math.ceil(String(s).length / 4);
const PROGRAM = "```js\n// Fly at the goal at 3 m/s and match its height.\nfunction policy(obs, memory) {\n  const p = obs.position, g = obs.goal.position;\n  const dx = g[0] - p[0], dy = g[1] - p[1], dz = g[2] - p[2];\n  const d = Math.hypot(dx, dz) || 1;\n  return { velocity: [3 * dx / d, Math.max(-1, Math.min(1, dy)), 3 * dz / d] };\n}\n```";

// A sensible live-steering answer from the prompt text.
export function steadyAnswer(messages) {
  const sys = messages[0]?.content ?? "";
  const text = messages[messages.length - 1]?.content ?? "";
  if (sys.includes("```js code block")) return PROGRAM;
  const m = text.match(/What the drone senses now:\n(\{.*\})/) || text.match(/\nNow: (\{.*\})/);
  if (!m) return '{"ok": true}';
  const o = JSON.parse(m[1]);
  const pos = o.position ?? o.pos, goal = o.goal?.position ?? o.goal;
  if (o.goal?.bearing_deg !== undefined) return JSON.stringify({ turn_deg: Math.max(-60, Math.min(60, o.goal.bearing_deg)), forward_mps: 3, climb_mps: 0, predict_goal_distance_in_1s: o.goal.distance_m - 3, say: "turn toward the goal" });
  if (o.goal?.waypoint) return JSON.stringify({ waypoint: o.goal.waypoint, speed: 4, say: "route to the goal" });
  if (!Array.isArray(pos) || !Array.isArray(goal)) return '{"ok": true}';
  const d = [goal[0] - pos[0], goal[1] - pos[1], goal[2] - pos[2]];
  const L = Math.hypot(...d) || 1;
  const vel = d.map((x) => Math.round((3 * x) / L * 10) / 10);
  if (text.includes('"target"')) return JSON.stringify({ target: goal, speed: 3, say: "straight at the goal" });
  return JSON.stringify({ velocity: vel, predict_goal_distance_in_1s: Math.max(0, L - 3), say: "straight at the goal" });
}

function reply(mode, body) {
  const msgs = body.messages ?? [];
  const max = Number(body.max_tokens) || 1e9;
  const answer = steadyAnswer(msgs);
  let content = answer, finish = "stop", reasoning = 0;
  if (mode === "truncate") { content = answer.slice(0, Math.max(1, Math.floor(answer.length / 2))); finish = "length"; }
  else if (mode === "malformed") content = "I would fly toward the goal, carefully.";
  else if (mode === "thinker") {
    const off = body.reasoning?.enabled === false || body.chat_template_kwargs?.enable_thinking === false;
    if (!off) {
      const think = `<think>${"Let me reason about the walls and the goal direction. ".repeat(44)}</think>\n`;
      reasoning = tok(think);
      const full = think + answer;
      if (tok(full) > max) { content = full.slice(0, max * 4); finish = "length"; }
      else content = full;
    }
  }
  if (mode !== "truncate" && tok(content) > max) { content = content.slice(0, max * 4); finish = "length"; }
  const prompt = tok(msgs.map((m) => m.content).join("\n"));
  const completion = tok(content);
  return {
    id: "mock", object: "chat.completion", model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finish }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, completion_tokens_details: { reasoning_tokens: Math.min(reasoning, completion) }, cost: (prompt + completion) * 1e-6 },
  };
}

export function startMockServer({ mode = "steady", port = 0, host = "127.0.0.1" } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.writeHead(404); res.end("{}"); return; }
      const body = JSON.parse(raw || "{}");
      requests.push({ auth: req.headers.authorization ?? null, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(mode, body)));
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({
    url: `http://${host}:${server.address().port}/v1`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const s = await startMockServer({ mode: opt("--mode", "steady"), port: Number(opt("--port", 8789)) });
  console.log(`mock endpoint (${opt("--mode", "steady")}) at ${s.url}; Ctrl-C to stop`);
}
