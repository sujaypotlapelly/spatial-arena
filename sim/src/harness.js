// Harness I/O (harness.html): one recorded Ripple decision shown as
// input JSON -> output JSON -> what the simulator flies. Read-only view of a
// saved recording; nothing is re-asked of the model.
//   harness.html?recording=recordings/ripple-demo-36.json&harness=structured_feedback&scenario=H26

import { World, routeLabel } from "./world.js";
import { HARNESSES, defenderState, defenderMessages } from "./agents.js";

const q = new URLSearchParams(location.search);
const REC = q.get("recording") || "recordings/ripple-demo-36.json";
const MAP = q.get("map") || "maps/building.json";
const ORDER = ["raw", "think", "tools", "structured", "feedback", "tools_structured", "tools_feedback", "structured_feedback"];
const SHORT = {
  raw: "Raw",
  think: "Thinking",
  tools: "Tools",
  structured: "Structured",
  feedback: "Raw + strategy",
  tools_structured: "Tools + structured",
  tools_feedback: "Tools + strategy",
  structured_feedback: "Structured + strategy",
};
const FLY = new Set(["route_id", "cruise_speed", "corner_slowdown", "avoidance_distance", "evade_strength", "replan_when_bird_nearby"]);
const SCORE = new Set(["bird_behavior_guess", "predicted_bird_position", "danger_point"]);
const STEP = new Set(["bird_velocity_estimate", "bird_moving_toward_drone"]);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const num = (n) => (n === null || n === undefined ? "–" : Math.round(n).toLocaleString("en-US"));

// JSON with short arrays and objects kept on one line.
function pretty(val, ind = "") {
  const flat = JSON.stringify(val);
  const prims = Array.isArray(val) && val.every((x) => x === null || typeof x !== "object");
  if (val === null || typeof val !== "object" || prims || flat.length + ind.length <= 70) return flat.replace(/,(?=["[{\d-])/g, ", ").replace(/":(?=\S)/g, '": ');
  const next = ind + "  ";
  if (Array.isArray(val)) return `[\n${val.map((x) => next + pretty(x, next)).join(",\n")}\n${ind}]`;
  return `{\n${Object.entries(val).map(([k, x]) => `${next}${JSON.stringify(k)}: ${pretty(x, next)}`).join(",\n")}\n${ind}}`;
}

const [rec, map] = await Promise.all([fetch(REC).then((r) => r.json()), fetch(MAP).then((r) => r.json())]);
const world = new World(map);
const episodes = rec.evaluation?.episodes || [];
const strategy = rec.strategy?.text || null;
const harnesses = ORDER.filter((k) => episodes.some((e) => e.condition === k));
const scenarioIds = [...new Set(episodes.map((e) => e.scenario.id))].sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));

let harness = harnesses.includes(q.get("harness")) ? q.get("harness") : harnesses.includes("structured_feedback") ? "structured_feedback" : harnesses[0];
let scenario = scenarioIds.includes(q.get("scenario")) ? q.get("scenario") : scenarioIds.includes("H26") ? "H26" : scenarioIds[0];

for (const k of harnesses) {
  const b = document.createElement("button");
  b.className = "pill";
  b.dataset.k = k;
  const letter = HARNESSES[k].label.split(" ")[0];
  b.innerHTML = `<b>${letter}</b>${SHORT[k]}`;
  b.title = HARNESSES[k].label;
  b.onclick = () => {
    harness = k;
    render();
  };
  $("pills").appendChild(b);
}
for (const id of scenarioIds) $("scenario").add(new Option(id, id));
$("scenario").onchange = (e) => {
  scenario = e.target.value;
  render();
};

// Thinking tokens: reported reasoning tokens when the host gives them.
// Otherwise, anything generated beyond the visible answer was thinking the
// host did not return (some fast-host calls do this even with thinking off).
function tokenSplit(d) {
  const u = d.usage || {};
  const out = u.completion_tokens ?? null;
  const reasoning = u.completion_tokens_details?.reasoning_tokens || 0;
  if (out === null) return { inTok: u.prompt_tokens ?? null, think: null, answer: null, hidden: false };
  if (reasoning > 0) return { inTok: u.prompt_tokens, think: reasoning, answer: out - reasoning, hidden: false };
  const answer = Math.min(out, Math.round((d.reply || "").length / 3.6));
  const extra = out - answer;
  return extra > 300 ? { inTok: u.prompt_tokens, think: extra, answer, hidden: true } : { inTok: u.prompt_tokens, think: 0, answer: out, hidden: false };
}

function outputHtml(obj) {
  const keys = Object.keys(obj);
  const lines = keys.map((k, i) => {
    const cls = FLY.has(k) ? "fly" : SCORE.has(k) ? "score" : STEP.has(k) ? "step" : "why";
    const val = JSON.stringify(obj[k]).replace(/,(?=\S)/g, ", ");
    return `<span class="ln ${cls}">  "${esc(k)}": ${esc(val)}${i < keys.length - 1 ? "," : ""}</span>`;
  });
  return `{\n${lines.join("")}}`;
}

function render() {
  for (const b of $("pills").children) b.setAttribute("aria-pressed", String(b.dataset.k === harness));
  $("scenario").value = scenario;
  history.replaceState(null, "", `?${new URLSearchParams({ recording: REC, harness, scenario })}`);

  const ep = episodes.find((e) => e.condition === harness && e.scenario.id === scenario);
  const h = HARNESSES[harness];
  if (!ep) {
    $("output").textContent = "No recorded decision for this harness and scenario.";
    return;
  }
  const sc = ep.scenario;
  const d = ep.defender;

  // ① Input
  const useStrategy = !!h.useStrategy && !!strategy;
  $("input").textContent = pretty(defenderState(world, sc));
  const msgs = defenderMessages(world, sc, { strategy: useStrategy ? strategy : null, style: h.style });
  $("prompt").textContent = msgs.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
  const tags = ["map, routes and 2 s of bird sightings"];
  if (useStrategy) tags.push("+ learned strategy");
  if (h.style.includes("tools")) tags.push("+ 6 geometry tools");
  if (h.style.includes("structured")) tags.push("+ fixed answer steps");
  if (h.reasoning) tags.push("+ thinking on");
  $("extras").innerHTML =
    `<div class="tags">${tags.map((x, i) => `<span class="tag${i ? " on" : ""}">${esc(x)}</span>`).join("")}</div>` +
    (useStrategy ? `<details><summary>Learned strategy text (pasted into the prompt)</summary><pre>${esc(strategy)}</pre></details>` : "");

  // Tokens
  const t = tokenSplit(d);
  $("tIn").textContent = num(t.inTok);
  $("tThink").textContent = t.think === null ? "–" : (t.hidden ? "≈ " : "") + num(t.think);
  $("tThinkL").textContent = t.hidden ? "tokens spent thinking (hidden, not returned)" : "tokens spent thinking";
  $("tOut").textContent = t.answer === null ? "–" : (t.hidden ? "≈ " : "") + num(t.answer);
  $("tTime").textContent = d.latencyMs ? (d.latencyMs / 1000).toFixed(1) : "–";

  // ② Output
  const tools = d.toolCalls || [];
  $("tools").innerHTML = tools.length
    ? `<h3 style="margin-top:0">Tool calls (${tools.length}), then the answer</h3>${tools
        .map((c) => `<div class="tool"><b>${esc(c.name)}</b>(${esc(JSON.stringify(c.args))}) → ${esc(JSON.stringify(c.result ?? c.error))}</div>`)
        .join("")}<div style="height:10px"></div>`
    : "";
  const parsed = d.raw && typeof d.raw === "object" ? d.raw : null;
  if (parsed) $("output").innerHTML = outputHtml(parsed);
  else $("output").innerHTML = `<span class="err">${esc(d.invalid || d.error || "No usable reply")}</span>\n\n${esc(d.reply || "")}`;
  $("stepLegend").hidden = !(parsed && Object.keys(parsed).some((k) => STEP.has(k)));
  $("thinkBox").hidden = !d.reasoning;
  $("thinking").textContent = d.reasoning || "";

  // ③ Simulator
  const p = d.policy || {};
  $("drone").textContent = d.invalid
    ? `Invalid decision: nothing is flown (scored −1).\n${d.invalid}`
    : pretty({
        route: `${p.route_id}: ${(p.route || []).join(" → ")}`,
        passes: routeLabel(world, p.route || []),
        cruise_speed: p.cruise_speed,
        corner_slowdown: p.corner_slowdown,
        avoidance_distance: p.avoidance_distance,
        evade_strength: p.evade_strength,
        replan_when_bird_nearby: p.replan_when_bird_nearby,
      });
  const { rationale, ...bird } = sc.bird;
  $("bird").textContent = pretty({ start: bird.start, behavior: bird.strategy, home_or_waiting_point: bird.ambush_node, speed: bird.speed, lead_time: bird.lead_time, trigger_distance: bird.trigger_distance });
  $("seeds").innerHTML = ep.results
    .map((r) => `<span class="muted">seed ${r.seed}</span><span class="badge ${r.outcome}">${r.outcome}</span><span class="muted">${r.time ? `${r.time} s` : ""}</span>`)
    .join("");
  const b = ep.belief;
  $("belief").innerHTML = b
    ? `Belief check: guessed <b>${esc(b.guess)}</b>, bird was <b>${esc(b.actual)}</b>${b.predictionError !== null ? `; 3 s position off by <b>${b.predictionError} m</b>` : ""}. Reached the goal on <b>${ep.summary.reached}/${ep.summary.trials}</b> seeds.`
    : "";
  $("source").textContent = `Recording: ${REC}. Output, tokens and results are as recorded; the prompt text is rebuilt from the current code with the same scenario and strategy.${t.hidden ? " Hidden thinking ≈ tokens generated minus the visible answer (estimated at 3.6 characters per token)." : ""}`;
}

render();
