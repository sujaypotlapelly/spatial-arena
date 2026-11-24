import { World, routeLabel } from "./world.js";
import { Episode } from "./engine.js";
import { Arena, TRAINING_EPISODES } from "./arena.js";
import { ModelClient } from "./agents.js";
import { runEpisode } from "./scenarios.js";
import { Viewer, RecordedSource, LiveSource, OUTCOME_COLORS } from "./render.js";
import { showcaseSeed, showcaseEpisodes, seedScore } from "./showcase.js";

const $ = (id) => document.getElementById(id);
const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;
const pct = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const params = new URLSearchParams(location.search);
// Presentation mode is the default: the 3D view, one short caption, and the
// three result panels. ?full=1 brings back every control and number.
const SIMPLE = !params.get("full");
if (SIMPLE) document.body.classList.add("simple");
const S = (full, short) => (SIMPLE ? short : full);

// A recording names the map it was flown on; load that map first.
let preloaded = null;
if (params.get("recording")) {
  try {
    preloaded = await (await fetch(params.get("recording"))).json();
  } catch {}
}
const mapFile = params.get("map") || preloaded?.mapFile || "maps/building.json";
const map = await (await fetch(mapFile)).json();
if (params.get("splat")) map.splat = { ...map.splat, url: params.get("splat") };
const heldoutFile = mapFile.endsWith("building.json") ? "scenarios/heldout.json" : `scenarios/${mapFile.split("/").pop().replace(".json", "")}-heldout.json`;
const heldout = (await (await fetch(heldoutFile)).json()).scenarios;
// Scenarios actually present in an evaluation, in id order.
const evScenarios = (ev) => {
  const byId = new Map();
  for (const e of ev.episodes) if (!byId.has(e.scenario.id)) byId.set(e.scenario.id, e.scenario);
  return [...byId.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
};
const world = new World(map);
const viewer = new Viewer($("stage"), world);

let llm = { llm: false, model: null };
try {
  const r = await fetch("/api/status");
  if (r.ok) llm = await r.json();
} catch {}
const client = new ModelClient({ enabled: llm.llm });
viewer.setBeliefOwner(client.enabled ? "Ripple" : "The stand-in");
const arena = new Arena(world, heldout, client);
const status = $("status");
if (llm.llm) {
  status.className = "status";
  status.textContent = "Ripple is configured. Generate an attack to run the model.";
} else {
  status.className = "status off";
  status.textContent =
    "No OPENROUTER_API_KEY on the server. Attacker, defender and strategy come from rule-based stand-ins, labelled “heuristic”. These are not Ripple results.";
}
try {
  await viewer.loadFlightModels();
} catch (error) {
  status.textContent += ` Flight models unavailable. Using procedural actors. ${error.message}`;
}
if (map.splat?.url) {
  viewer
    .loadSplat(map.splat)
    .then(() => ($("splatToggle").hidden = false))
    .catch((e) => (status.textContent += ` Splat failed to load: ${e.message}`));
}

let busy = false;
let follow = false;
let recorded = false;

// ---------- small UI helpers ----------
function hud(title, row = "") {
  $("hudTitle").textContent = title;
  $("hudRow").textContent = row;
}
const OUTCOME_WORDS = { reached: "Reached the goal", intercepted: "Caught by the bird", crashed: "Crashed into a wall", timeout: "Ran out of time" };
function banner(text, color) {
  const b = $("banner");
  b.textContent = text;
  b.style.background = "rgba(10,14,28,.9)";
  b.style.border = `1px solid ${color}`;
  b.style.color = color;
  b.classList.add("show");
  clearTimeout(banner.t);
  banner.t = setTimeout(() => b.classList.remove("show"), 1800);
}
const progress = (t) => ($("progress").textContent = t);
// hidden: don't show the bird's internal state (it would give away its behavior).
const tickHud = (title, { hidden = false } = {}) => (t, st) => {
  if (!st) return;
  const sep = Math.hypot(st.d[0] - st.b[0], st.d[1] - st.b[1], st.d[2] - st.b[2]);
  hud(title, `t ${t.toFixed(1)} s   drone ${Math.hypot(...st.dv).toFixed(1)} m/s\n${hidden ? "bird behavior hidden" : `bird ${st.bs}`.padEnd(21)} gap ${sep.toFixed(1)} m`);
};

function badge(side) {
  if (!side) return "";
  if (recorded) return `<span class="src recorded">recorded</span>`;
  if (side.source === "ripple") return `<span class="src ripple" title="${esc(side.model)}">Ripple${side.latencyMs ? ` · ${(side.latencyMs / 1000).toFixed(1)}s` : ""}</span>`;
  if (side.source === "comparator") return `<span class="src comparator">shortest path</span>`;
  if (side.source === "default" || side.source === "fallback") return `<span class="src heuristic">default</span>`;
  if (side.error) return `<span class="src fallback" title="${esc(side.error)}">heuristic (model failed)</span>`;
  return `<span class="src heuristic">heuristic</span>`;
}

function kv(obj, skip = []) {
  return Object.entries(obj)
    .filter(([k]) => !skip.includes(k))
    .map(([k, v]) => `<tr><td>${k}</td><td>${esc(Array.isArray(v) ? v.join(" → ") : JSON.stringify(v))}</td></tr>`)
    .join("");
}

function details(label, text) {
  return text ? `<details><summary>${label}</summary><pre>${esc(text)}</pre></details>` : "";
}

function beliefHtml(bl) {
  if (!bl) return "";
  const verdict = bl.behaviorCorrect ? `<span class="ok">✓ correct</span>` : bl.familyCorrect ? `<span class="ok">✓ right family</span>` : `<span class="no">✗ wrong</span>`;
  return `<div class="belief">Ripple's read of the bird: <b>${esc(bl.guess)}</b> · actually <b>${esc(bl.actual)}</b> ${verdict}${bl.dangerError !== null ? ` · predicted danger point off by <b>${bl.dangerError} m</b>` : " · no danger point given"}</div>`;
}

function showDetail(ep) {
  const d = ep.defender;
  $("detailNote").textContent = ep.kind === "eval" ? `${ep.scenario.id} · ${ep.condition}` : ep.kind === "baseline" ? "baseline" : `training ${ep.scenario.id}`;
  const pol = d.policy || {};
  $("detailDefender").innerHTML = `<h3>Defender ${badge(d)}</h3>
    ${d.invalid ? `<div class="err">Invalid action: ${esc(d.invalid)} (reward −1, not flown)</div>` : ""}
    <div class="why">${esc(pol.rationale || "")}</div>
    ${beliefHtml(ep.belief)}
    ${pol.route ? `<div class="small-text">Route <b>${esc(pol.route_id)}</b>: ${esc(routeLabel(world, pol.route))}</div>` : ""}
    <div class="muted small-text">${d.harness ? `harness ${esc(d.harness)}` : ""}${d.provider ? ` · served by ${esc(d.provider)}` : ""}${d.toolCalls?.length ? ` · ${d.toolCalls.length} tool calls` : ""}</div>
    <table>${kv(pol, ["rationale", "route", "route_id"])}</table>
    ${d.warnings?.length ? `<div class="warn">Clamped by validator: ${esc(d.warnings.join("; "))}</div>` : ""}
    ${d.error ? `<div class="err">${esc(d.error)}</div>` : ""}
    ${details("Tool calls", d.toolCalls?.map((c) => `${c.name}(${JSON.stringify(c.args)}) → ${JSON.stringify(c.result)}`).join("\n"))}${details("Model reasoning", d.reasoning)}${details("Model reply", d.reply)}${details("Prompt", d.prompt?.map((m) => `[${m.role}]\n${m.content}`).join("\n\n"))}`;
  const b = ep.scenario.bird;
  const a = ep.attack;
  const w = a?.solvability?.witness;
  $("detailAttack").innerHTML = `<h3>Bird scenario ${a ? badge(a) : `<span class="src heuristic">held-out (fixed)</span>`}</h3>
    <div class="why">${esc(b.rationale || a?.raw?.rationale || "")}</div>
    <table>${kv(b, ["rationale"])}</table>
    ${w ? `<div class="small-text">Solvability check: reference route ${esc(w.route_id)} (${esc(w.label)}) reached ${w.reached}/${ep.scenario.seeds.length}.</div>` : ""}
    ${ep.scenario.witness ? `<div class="small-text">Solvability check: reference route ${esc(ep.scenario.witness.route_id)} reached ${ep.scenario.witness.reached}/4.</div>` : ""}
    ${a?.rejected?.length ? `<div class="warn">Rejected as unsolvable first: ${esc(a.rejected.join("; "))}</div>` : ""}
    ${a?.warnings?.length ? `<div class="warn">Clamped by validator: ${esc(a.warnings.join("; "))}</div>` : ""}
    ${details("Model reasoning", a?.reasoning)}${details("Model reply", a?.reply)}${details("Prompt", a?.prompt?.map((m) => `[${m.role}]\n${m.content}`).join("\n\n"))}`;
}

function addEpisodeRow(ep) {
  const s = ep.summary;
  const li = document.createElement("li");
  const chips = ep.results
    .map((r, i) => `<button class="chip" data-trial="${i}" title="Seed ${r.seed}: ${r.outcome}${r.time ? ` at ${r.time}s` : ""}" style="background:${hex(OUTCOME_COLORS[r.outcome] ?? 0x475569)}"></button>`)
    .join("");
  const b = ep.scenario.bird;
  li.innerHTML = `<div class="top"><span><span class="kind">${ep.kind === "baseline" ? "Baseline" : `Training ${ep.scenario.id}`}</span>
      <span class="route">${ep.defender.invalid ? "invalid action" : `${esc(ep.defender.policy.route_id)} · ${esc(routeLabel(world, ep.defender.policy.route))}`}</span></span>
      <span class="score" style="color:${s.successRate >= 0.5 ? "var(--good)" : "var(--bad)"}">${s.reached}/${s.trials}</span></div>
    <div class="muted">bird ${b.strategy} from ${esc(b.start)}${b.strategy === "ambush" ? ` → ${esc(b.ambush_node)}` : ""} · ${b.speed} m/s ${ep.attack ? badge(ep.attack) : ""} · defender ${badge(ep.defender)}</div>
    <div class="chips">${chips}</div>`;
  li.addEventListener("click", (e) => {
    document.querySelectorAll("#episodes li").forEach((x) => x.classList.remove("sel"));
    li.classList.add("sel");
    showDetail(ep);
    const chip = e.target.closest(".chip");
    if (!busy) playEpisode(ep, chip ? Number(chip.dataset.trial) : null, { speed: chip ? Math.min(3, speed()) : speed() });
  });
  $("episodes").prepend(li);
  $("epNote").textContent = `${arena.training.length}/${TRAINING_EPISODES} training`;
  drawCurve();
}

// ---------- playback ----------
const speed = () => Number($("speed").value);

async function playEpisode(ep, only = null, { speed: sp = speed(), title, keep = ep.kind === "training", clear = false } = {}) {
  if (!ep.frames) return;
  if (clear) viewer.clearTrails();
  const pol = ep.defender.policy || {};
  const hidden = ep.kind !== "baseline";
  viewer.setTask(ep.scenario.start, ep.scenario.goal, ep.scenario.bird.start, hidden ? (SIMPLE ? "BIRD" : "BIRD · behavior hidden") : `BIRD · ${ep.scenario.bird.strategy}`);
  viewer.setBelief(pol.danger_point || null, null);
  // With all seeds on screen, the solid (primary) flight is the best one:
  // a success with a visible dodge when there is one. The others play as
  // ghosts and the banner still counts all of them.
  const lead = only ?? showcaseSeed(ep.results);
  const sources = ep.frames
    .map((frames, i) => ({ i, source: new RecordedSource(frames), outcome: () => ep.results[i].outcome, primary: i === lead }))
    .filter((s) => only === null || s.i === only);
  const label = title || `${ep.kind === "eval" ? `Held-out ${ep.scenario.id} · ${ep.condition}` : ep.kind === "baseline" ? "Baseline" : `Training ${ep.scenario.id}`}${only === null ? ` · ${sources.length} seeds` : ` · seed ${ep.results[only].seed}`}`;
  hud(label);
  const why = await viewer.play(sources, { speed: sp, follow, keepTrails: keep, onTick: tickHud(label, { hidden }), birdRange: ep.scenario.bird.trigger_distance });
  if (why === "done") {
    // Reveal: what the bird really was, and where it actually got closest.
    const r = ep.results[lead];
    viewer.setBirdText(`BIRD · was ${ep.scenario.bird.strategy}`);
    viewer.setBelief(pol.danger_point || null, r.closest ? { drone: r.closest.drone, dist: r.minSeparation } : null);
    if (only === null) banner(`${ep.summary.reached}/${ep.summary.trials} reached`, ep.summary.successRate >= 0.5 ? "#34d399" : "#f43f5e");
    else banner(OUTCOME_WORDS[ep.results[only].outcome] || ep.results[only].outcome, hex(OUTCOME_COLORS[ep.results[only].outcome]));
  }
  return why;
}

// ---------- evaluation view ----------
function renderEval(ev) {
  const M = ev.metrics;
  let keys = ev.conditions.map((c) => c.key);
  // Presentation mode: shortest path, the first Ripple condition, and the
  // best one by success. ?full=1 shows every harness.
  if (SIMPLE && keys.length > 3) {
    const ripple = keys.filter((k) => k !== "shortest");
    const best = ripple.reduce((b, k) => ((M[k].successRate ?? -1) > (M[b].successRate ?? -1) ? k : b), ripple[0]);
    keys = [...new Set(["shortest", ripple[0], best].filter((k) => keys.includes(k)))];
  }
  const nScen = evScenarios(ev).length;
  const rows = [
    ["Success rate", (m) => m.successRate, pct, "max"],
    ["…caught by the bird", (m) => m.interceptRate, pct, "min"],
    ["…crashed into walls", (m) => m.crashRate, pct, "min"],
    ["Mean reward", (m) => m.meanReward, (x) => x.toFixed(2), "max"],
    ["Scenarios solved (≥2/4)", (m) => m.scenariosSolved, (x) => `${x}/${nScen}`, "max"],
    ["Path length ÷ reference", (m) => m.pathEfficiency, (x) => (x === null ? "—" : x.toFixed(2)), null],
    ["Bird behavior identified", (m) => m.behaviorAccuracy, pct, "max"],
    ["…right behavior family", (m) => m.familyAccuracy, pct, "max"],
    ["Danger-point error (m)", (m) => m.meanDangerError, (x) => (x === null || x === undefined ? "—" : x.toFixed(1)), "min"],
    ["Bird position in 3 s, error (m)", (m) => m.meanPredictionError, (x) => (x === null || x === undefined ? "—" : x.toFixed(1)), "min"],
    ["Tool calls per decision", (m) => m.toolCallsPerDecision, (x) => (x === null || x === undefined ? "—" : String(x)), null],
    ["Median decision time (s)", (m) => m.medianLatencyS, (x) => (x === null || x === undefined ? "—" : x.toFixed(1)), null],
    ["Invalid actions", (m) => m.invalidActions, String, "min"],
    ["Clamped parameters", (m) => m.constraintViolations, String, "min"],
  ];
  const head = `<tr><th></th>${keys.map((k) => `<th>${esc(M[k].label)}</th>`).join("")}</tr>`;
  const body = (SIMPLE ? rows.slice(0, 3) : rows)
    .map(([label, get, f, better]) => {
      const vals = keys.map((k) => get(M[k]));
      const nums = vals.filter((x) => typeof x === "number");
      const best = better && nums.length ? (better === "max" ? Math.max(...nums) : Math.min(...nums)) : null;
      return `<tr><td>${label}</td>${vals.map((x) => `<td class="${best !== null && x === best && new Set(nums).size > 1 ? "best" : ""}">${f(x)}</td>`).join("")}</tr>`;
    })
    .join("");
  const q = ev.quiz.results;
  const qcell = (r) => (r?.skipped ? "n/a" : r?.error ? "error" : `${r.correct}/${r.total}${r.meanTimeError !== null ? ` · Δt ${r.meanTimeError}s` : ""}`);
  const quizRow = Object.keys(q || {}).length
    ? `<tr><td title="Separate constant-velocity questions with analytic answers; ${Math.round(ev.quiz.collideShare * 100)}% of answers are 'collide'">Spatial prediction quiz</td>${keys.map((k) => `<td>${q[k] ? qcell(q[k]) : "—"}</td>`).join("")}</tr>`
    : "";
  $("evalTable").innerHTML = SIMPLE ? `<table class="metrics">${head}${body}</table>` : `<table class="metrics">${head}${body}${quizRow}</table>
    <div class="muted small-text" style="margin-top:6px">Path length is measured on the flown path; below 1.0 means corners were cut relative to the waypoint polyline. ${nScen} scenarios × 4 seeds is a demonstration, not a statistically strong result.</div>`;
  $("evalNote").textContent = `${nScen} unseen scenarios × 4 seeds · ${ev.at.slice(11, 16)} UTC`;

  const scenarios = evScenarios(ev);
  const grid = [`<div></div>`, ...scenarios.map((s) => `<div class="hdr" title="${esc(`${s.start} → ${s.goal}, bird ${s.bird.strategy}`)}">${s.id.slice(1)}</div>`)];
  for (const c of ev.conditions) {
    grid.push(`<div class="rowlbl" title="${esc(c.label)}">${esc(c.key)}</div>`);
    for (const s of scenarios) {
      const ep = ev.episodes.find((e) => e.condition === c.key && e.scenario.id === s.id);
      const f = ep.summary.successRate;
      const col = ep.defender.invalid ? "#475569" : `hsl(${Math.round(f * 140)}, 70%, ${f === 0 ? 45 : 42}%)`;
      grid.push(`<button class="cell" data-cond="${c.key}" data-sc="${s.id}" style="background:${col}" title="${esc(`${s.id} ${c.key}: ${ep.summary.reached}/${ep.summary.trials} reached${ep.defender.invalid ? " (invalid)" : ""}`)}"></button>`);
    }
  }
  $("evalGrid").innerHTML = `<div class="grid">${grid.join("")}</div>`;
  $("evalGrid").querySelectorAll(".cell").forEach((cell) =>
    cell.addEventListener("click", () => {
      const ep = ev.episodes.find((e) => e.condition === cell.dataset.cond && e.scenario.id === cell.dataset.sc);
      showDetail(ep);
      if (!busy) playEpisode(ep);
    }),
  );
}

function drawCurve(upto = Infinity) {
  const svg = $("curve");
  const T = arena.training;
  if (!T.length) {
    svg.innerHTML = `<text x="160" y="55" fill="#64748b" font-size="11" text-anchor="middle">Training episodes appear here</text>`;
    return;
  }
  const cols = [...T.map((ep) => ({ label: `T${ep.index}`, ep })), ...(arena.rematch ? [{ label: "R", ep: arena.rematch.after, rematch: true }] : [])];
  const n = Math.max(cols.length, 9);
  const w = 320 / n;
  svg.innerHTML =
    cols
      .map(({ label, ep, rematch }, i) => {
        const h = ep.summary.successRate * 70;
        const x = i * w;
        const fam = ep.belief ? (ep.belief.familyCorrect ? "#fbbf24" : "#475569") : "none";
        const op = i > upto ? 0.15 : 1;
        const ring = i === upto ? `<rect x="${x + 1}" y="10" width="${w - 2}" height="74" fill="none" stroke="#7dd3fc" stroke-width="1.5" rx="2"/>` : "";
        return `${ring}<rect x="${x + 3}" y="${82 - h}" width="${w - 6}" height="${Math.max(h, 1)}" fill="${rematch ? "#a78bfa" : "#34d399"}" opacity="${op}"><title>${label}: reached ${ep.summary.reached}/${ep.summary.trials}${ep.belief ? `; guessed ${ep.belief.guess}, actual ${ep.belief.actual}` : ""}</title></rect>
          <circle cx="${x + w / 2}" cy="6" r="3.5" fill="${fam}" stroke="#78350f" opacity="${op}"><title>${ep.belief ? (ep.belief.familyCorrect ? "behavior family identified" : "behavior misidentified") : "no belief stated"}</title></circle>
          <text x="${x + w / 2}" y="95" fill="#64748b" font-size="8" text-anchor="middle">${label}</text>`;
      })
      .join("") + `<line x1="0" x2="320" y1="47" y2="47" stroke="#334155" stroke-dasharray="3 3"/>`;
  $("curveNote").textContent = "· bars: goal reached · dots: bird behavior identified · R: rematch";
}

function renderRematch() {
  const rm = arena.rematch;
  if (!rm) return;
  const before = arena.training.find((e) => e.index === rm.beforeIndex);
  const after = rm.after;
  const box = (title, ep) => `<div><div class="muted">${title}</div>
    <div class="big" style="color:${ep.summary.successRate >= 0.5 ? "var(--good)" : "var(--bad)"}">${ep.summary.reached}/${ep.summary.trials}</div>
    <div>${ep.defender.invalid ? "invalid" : `${esc(ep.defender.policy.route_id)} · ${esc(routeLabel(world, ep.defender.policy.route))}`}</div>
    <div class="muted">guessed ${esc(ep.belief?.guess ?? "—")}</div></div>`;
  $("rematch").innerHTML = `<div class="small-text">Same bird (${esc(before.scenario.bird.strategy)}) and same 4 seeds as training ${before.scenario.id}. Click to replay both.</div>
    <div class="rematch-row" style="cursor:pointer">${box(`Before feedback (${before.scenario.id})`, before)}${box("After feedback (frozen strategy)", after)}</div>`;
  $("rematch").querySelector(".rematch-row").onclick = () => !busy && task("Rematch…", () => playRematch());
}

async function playRematch() {
  const rm = arena.rematch;
  const before = arena.training.find((e) => e.index === rm.beforeIndex);
  showDetail(before);
  await playEpisode(before, 0, { keep: true, clear: true, title: `Before feedback · ${before.scenario.id}` });
  if (stopRequested) return;
  showDetail(rm.after);
  await playEpisode(rm.after, 0, { keep: true, title: `After feedback · same bird, same seed` });
}

function renderStrategy() {
  const s = arena.strategy;
  if (!s) return;
  $("strategy").className = "strategy frozen small-text";
  $("strategy").innerHTML = `${badge(s)} <span class="muted">frozen ${esc(s.frozenAt.slice(11, 19))} UTC from ${s.fromEpisodes} training episodes</span>
    <div style="margin-top:6px">${esc(s.text)}</div>${s.error ? `<div class="err">Model call failed: ${esc(s.error)}</div>` : ""}`;
}

function renderLedger() {
  if (recorded) {
    const R = arena.recordedLedger;
    status.className = "status ok";
    status.textContent = `Replaying a recorded ${arena.recordedUsingModel ? "Ripple" : "offline stand-in (NOT Ripple)"} session from ${String(arena.recordedAt || "").slice(0, 16).replace("T", " ")} UTC. Every flight is re-simulated from the saved decisions; no model calls are made.`;
    $("ledger").textContent = R ? `Recorded run: ${R.calls} model calls (${R.failures} retried), ${(R.promptTokens + R.completionTokens).toLocaleString()} tokens.` : "";
    return;
  }
  const L = client.ledger;
  if (client.enabled) {
    status.className = `status ${client.lastError ? "off" : L.calls > L.failures ? "ok" : ""}`;
    status.textContent = client.lastError
      ? `Ripple call failed: ${client.lastError} Any stand-in decisions are labelled heuristic. Try Generate attack again.`
      : L.calls > L.failures
        ? "Ripple connected via OpenRouter. Attacker and defender decisions are labelled below."
        : "Ripple is configured. Generate an attack to run the model.";
  }
  $("ledger").textContent = client.enabled
    ? `${L.calls} model calls (${L.failures} failed) · ${L.promptTokens.toLocaleString()} prompt + ${L.completionTokens.toLocaleString()} completion tokens · ${(L.ms / 1000).toFixed(1)} s total latency`
    : "No model calls (offline stand-ins).";
}

function refresh() {
  const t = arena.training.length;
  $("btnBaseline").disabled = busy;
  $("btnAttack").disabled = busy || t >= TRAINING_EPISODES || recorded;
  $("btnAdapt").disabled = busy || recorded || (!!arena.strategy && t >= TRAINING_EPISODES);
  $("btnEval").disabled = busy || !arena.strategy || recorded;
  $("btnLive").disabled = busy || (!arena.evaluation && !t);
  $("btnStop").disabled = !busy;
  $("btnDemo").disabled = busy || !(arena.rematch || arena.evaluation);
  $("btnLearn").disabled = busy || !arena.training.length;
  $("btnReset").disabled = busy;
  $("btnExport").disabled = busy || (!arena.baseline && !t);
  $("btnAdapt").innerHTML = `<b>3</b> Adapt strategy${t < TRAINING_EPISODES ? ` (${t}/${TRAINING_EPISODES})` : ""}`;
  const next = !arena.baseline ? "btnBaseline" : !arena.strategy ? (t ? "btnAdapt" : "btnAttack") : !arena.evaluation ? "btnEval" : null;
  for (const id of ["btnBaseline", "btnAttack", "btnAdapt", "btnEval"]) $(id).classList.toggle("next", id === next);
  renderLedger();
}

let stopRequested = false;
async function task(label, fn) {
  if (busy) return;
  busy = true;
  stopRequested = false;
  refresh();
  progress(label);
  try {
    await fn();
  } catch (e) {
    console.error(e);
    progress(`Error: ${e.message}`);
    busy = false;
    refresh();
    return;
  }
  busy = false;
  progress("");
  refresh();
}

// ---------- controls ----------
$("btnBaseline").onclick = () =>
  task("Running shortest-path baseline…", async () => {
    const ep = arena.runBaseline();
    addEpisodeRow(ep);
    showDetail(ep);
    await playEpisode(ep);
  });

async function oneTrainingEpisode() {
  progress(`Training ${arena.training.length + 1}/${TRAINING_EPISODES}: ${client.enabled ? "Ripple attacker proposing, simulator checking solvability, Ripple defender planning…" : "stand-ins proposing…"}`);
  const ep = await arena.trainingEpisode();
  addEpisodeRow(ep);
  showDetail(ep);
  renderLedger();
  return ep;
}

$("btnAttack").onclick = () =>
  task("Generating attack…", async () => {
    const ep = await oneTrainingEpisode();
    await playEpisode(ep);
  });

$("btnAdapt").onclick = () =>
  task("Adapting…", async () => {
    // Compute the next episode while the current one plays back.
    let pending = arena.training.length < TRAINING_EPISODES ? oneTrainingEpisode() : null;
    while (pending && !stopRequested) {
      const ep = await pending;
      pending = arena.training.length < TRAINING_EPISODES ? oneTrainingEpisode() : null;
      await playEpisode(ep);
    }
    if (pending) await pending;
    if (stopRequested) return;
    progress(client.enabled ? "Ripple is writing the general strategy from the training failures…" : "Writing stand-in strategy…");
    await arena.freezeStrategy();
    renderStrategy();
    banner("Strategy frozen", "#a78bfa");
    progress(client.enabled ? "Rematch: Ripple re-decides the first failed episode with its frozen strategy…" : "Rematch…");
    await arena.runRematch();
    renderRematch();
    drawCurve();
    renderLedger();
    await playRematch();
  });

$("btnEval").onclick = () =>
  task("Evaluating…", async () => {
    viewer.clearTrails();
    const ev = await arena.evaluate((d, n) => progress(`Held-out evaluation: ${d}/${n} episodes (${client.enabled ? "Ripple decisions + simulation" : "simulation"})…`));
    renderEval(ev);
    renderLedger();
    // Show the scenario where the strategy changed the outcome most.
    const diffs = evScenarios(ev).map((s) => {
      const o = ev.episodes.find((e) => e.condition === "original" && e.scenario.id === s.id);
      const st = ev.episodes.find((e) => e.condition === "strategy" && e.scenario.id === s.id);
      return { o, st, d: st.summary.successRate - o.summary.successRate };
    });
    const best = diffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
    if (best && best.d !== 0 && !stopRequested) {
      progress(`Largest difference: ${best.o.scenario.id}. Playing without the strategy, then with it.`);
      showDetail(best.o);
      await playEpisode(best.o);
      if (!stopRequested) {
        showDetail(best.st);
        await playEpisode(best.st);
      }
    }
  });

$("btnLive").onclick = () =>
  task("Live run…", async () => {
    let sc;
    let policy;
    hideCaption();
    viewer.clearTrails();
    if (arena.evaluation) {
      // One of the learned policy's strongest held-out decisions (rotating
      // through the top few so repeated clicks vary).
      const key = demoPair()?.aKey || arena.evaluation.conditions.find((c) => c.key !== "shortest")?.key;
      const ranked = showcaseEpisodes(arena.evaluation.episodes, (e) => e.condition === key);
      const strong = ranked.filter((e) => e.summary.reached >= 3).slice(0, 5);
      const top = strong.length ? strong : ranked.slice(0, 1);
      const ep = top[(liveTurn++) % top.length];
      sc = ep.scenario;
      policy = ep.defender.policy;
      showDetail(ep);
    } else {
      const ep = showcaseEpisodes(arena.training)[0] || arena.training.at(-1);
      sc = ep.scenario;
      policy = ep.defender.policy;
    }
    // A fresh seed (new wind and bird jitter). Try a few and fly one that
    // reaches the goal past the bird; the simulator still decides everything.
    let seed = Math.floor(Math.random() * 1e9);
    for (let k = 0, best = -1; k < 12; k++) {
      const s = Math.floor(Math.random() * 1e9);
      const trial = new Episode(world, sc, policy, s);
      trial.run();
      const score = seedScore(trial.result);
      if (score > best) [best, seed] = [score, s];
      if (score > 2.5) break; // reached after a visible dodge
    }
    const live = new Episode(world, sc, policy, seed);
    viewer.setTask(sc.start, sc.goal, sc.bird.start);
    const title = `LIVE · ${sc.id} · seed ${seed}`;
    progress("Re-flying one of the learned policy's recorded decisions live with a new seed (wind and bird jitter differ), chosen from seeds where it gets through. No model call is made.");
    if (recorded) $("recordedTag").textContent = "LIVE SIMULATION of a recorded Ripple decision · new seed";
    const why = await viewer.play([{ source: new LiveSource(live), outcome: () => live.result?.outcome ?? "timeout", primary: true }], {
      speed: 1,
      follow,
      keepTrails: false,
      onTick: tickHud(title),
    });
    if (why === "done") banner(OUTCOME_WORDS[live.result.outcome] || live.result.outcome, hex(OUTCOME_COLORS[live.result.outcome]));
    if (recorded) $("recordedTag").textContent = "RECORDED SESSION · re-simulated from saved decisions";
  });

let liveTurn = 0;

// ---------- demo mode: the three beats ----------
function caption(step, html) {
  const c = $("caption");
  c.innerHTML = `<span class="step">${step}</span>${html}`;
  c.hidden = false;
}
function hideCaption() {
  $("caption").hidden = true;
}
const pause = (ms) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (stopRequested || Date.now() - t0 >= ms ? resolve() : setTimeout(tick, 100));
    tick();
  });

// What the defender changed between two decisions, in plain words.
function changes(before, after) {
  const b = before.defender.policy || {};
  const a = after.defender.policy || {};
  const out = [];
  if (b.bird_behavior_guess !== a.bird_behavior_guess) out.push(`bird guess ${b.bird_behavior_guess} → <b>${a.bird_behavior_guess}</b>${a.bird_behavior_guess === after.scenario.bird.strategy ? " (correct)" : ""}`);
  if (b.route_id !== a.route_id) out.push(`route ${b.route_id} → <b>${a.route_id}</b> (${esc(routeLabel(world, a.route || []))})`);
  if (b.cruise_speed !== a.cruise_speed) out.push(`speed ${b.cruise_speed} → ${a.cruise_speed} m/s`);
  if (b.avoidance_distance !== a.avoidance_distance) out.push(`starts evading at ${b.avoidance_distance} → ${a.avoidance_distance} m`);
  if (b.replan_when_bird_nearby !== a.replan_when_bird_nearby) out.push(a.replan_when_bird_nearby ? "now re-routes around the bird" : "no longer re-routes");
  return out.length ? out.join("; ") : "nothing in the plan (same decision)";
}

// The demo's before/after pair. Prefer a held-out scenario (never seen in
// training) where the learned strategy changed the outcome most, replaying
// a seed that flipped from failure to success; fall back to the training
// rematch. Returns { before, after, seed, label, gain } or a no-gain pair.
function demoPair() {
  const ev = arena.evaluation;
  if (ev) {
    // Before/after must use the same harness: the one training ran with.
    const keys = ev.conditions.map((c) => c.key);
    const h = arena.defenderHarness || "raw";
    const cand = [
      ...(arena.demoPairKeys ? [arena.demoPairKeys] : []),
      ["original", "strategy"],
      [h, h === "raw" ? "feedback" : `${h}_feedback`],
      ["raw", "feedback"],
    ].find(([b, a]) => keys.includes(b) && keys.includes(a));
    const [bKey, aKey] = cand || [null, null];
    if (bKey && aKey) {
      const pairs = evScenarios(ev)
        .map((s) => ({
          before: ev.episodes.find((e) => e.condition === bKey && e.scenario.id === s.id),
          after: ev.episodes.find((e) => e.condition === aKey && e.scenario.id === s.id),
        }))
        .filter((p) => p.before?.frames && p.after?.frames)
        .map((p) => {
          const flip = p.before.results.findIndex((r, i) => r.outcome !== "reached" && p.after.results[i]?.outcome === "reached");
          return { ...p, seed: Math.max(0, flip), gain: p.after.summary.successRate - p.before.summary.successRate, flip: flip >= 0 };
        })
        .sort((x, y) => y.gain - x.gain || Number(y.flip) - Number(x.flip));
      if (pairs[0] && pairs[0].gain > 0) return { ...pairs[0], bKey, aKey, label: `unseen scenario ${pairs[0].before.scenario.id}`, heldOut: true };
      // No gain anywhere: still show an honest failure from the "before" condition.
      const fail = pairs.find((p) => p.before.summary.successRate < 0.5) || pairs[0];
      if (fail) return { ...fail, bKey, aKey, label: `unseen scenario ${fail.before.scenario.id}`, heldOut: true, gain: fail.gain };
    }
  }
  const rm = arena.rematch;
  if (rm) {
    const before = arena.training.find((e) => e.index === rm.beforeIndex);
    return { before, after: rm.after, seed: 0, label: `training ${before.scenario.id}`, heldOut: false, gain: rm.after.summary.successRate - before.summary.successRate };
  }
  return null;
}

$("btnDemo").onclick = () =>
  task("Demo…", async () => {
    const pair = demoPair();
    if (!pair) {
      progress("The demo needs a finished training run and evaluation. Load a recording or run steps 3 and 4 first.");
      return;
    }
    const { before, after, seed } = pair;
    const bp = before.defender.policy;
    const route = (ep) => (ep.defender.invalid ? "an invalid plan" : `route ${ep.defender.policy.route_id} (${routeLabel(world, ep.defender.policy.route)})`);
    // About 60 s in total: flights at 1.5x, a longer pause on the reveal.
    const sp = 1.5;
    // Name whoever actually made these decisions.
    const who = (recorded ? arena.recordedUsingModel : client.enabled) ? "Ripple" : "The offline stand-in (not Ripple)";
    const whoShort = who === "Ripple" ? "Ripple" : "the stand-in";
    const nTrain = arena.strategy?.fromEpisodes ?? arena.training.length;

    // Beat 1: Ripple's attempt, in the building, before any feedback.
    showDetail(before);
    caption(
      `1 · ${who === "Ripple" ? "Ripple" : "The stand-in"} flies the building`,
      S(
        `${pair.heldOut ? `An unseen scenario (${esc(before.scenario.id)}), no feedback yet. ` : ""}${who} watched the bird for 2 seconds, guessed it was <b>${esc(bp.bird_behavior_guess ?? "unknown")}</b>, and chose ${esc(route(before))}.`,
        `${who} guesses the bird will <b>${esc(bp.bird_behavior_guess ?? "unknown")}</b> and picks a route.`,
      ),
    );
    const why1 = await playEpisode(before, seed, { speed: sp, keep: true, clear: true, title: `${who === "Ripple" ? "Ripple" : "Stand-in"} without feedback · ${pair.label}` });
    if (stopRequested || why1 !== "done") return hideCaption();
    await pause(1500);

    // Beat 2: how the system actually behaved.
    const b = before.belief;
    const r0 = before.results[seed];
    caption(
      "2 · How the bird actually behaved",
      S(
        `The bird was really <b>${esc(before.scenario.bird.strategy)}</b>${b ? (b.familyCorrect ? ` — ${whoShort} read it right` : ` — ${whoShort} misread it`) : ""}. ${
          bp.danger_point && r0.closest ? `${who} expected trouble at the amber marker; the simulator recorded the bird's closest approach at the red ring.` : `The red ring marks where the bird actually got closest.`
        } Outcome: <b>${esc(r0.outcome)}</b>, verified by the simulator.`,
        `The bird was really <b>${esc(before.scenario.bird.strategy)}</b>. Result: <b>${esc(r0.outcome)}</b>.`,
      ),
    );
    await pause(9000);
    if (stopRequested) return hideCaption();

    // Beat 3: same bird, same seed, after verified feedback.
    showDetail(after);
    caption(
      "3 · After verified feedback",
      S(
        `After ${nTrain} training episodes, ${whoShort} wrote and froze a strategy. Same bird, same seed${pair.heldOut ? ", a scenario it never trained on" : ""}. What changed: ${changes(before, after)}.`,
        `Same bird, after ${whoShort} learned from ${nTrain} episodes of feedback.`,
      ),
    );
    const why3 = await playEpisode(after, seed, { speed: sp, keep: true, title: `${who === "Ripple" ? "Ripple" : "Stand-in"} with learned strategy · ${pair.label}` });
    if (stopRequested || why3 !== "done") return hideCaption();
    const ev = arena.evaluation?.metrics;
    const bK = pair.bKey;
    const aK = pair.aKey;
    caption(
      "3 · After verified feedback",
      SIMPLE
        ? `This scenario: <b>${before.summary.reached}/4 → ${after.summary.reached}/4</b>.${ev?.[bK] && ev?.[aK] ? ` All unseen: ${transferText(bK, aK)}.` : ""}`
        : `This scenario: <b>${before.summary.reached}/4 → ${after.summary.reached}/4</b> reached.${
        ev?.[bK] && ev?.[aK]
          ? ` Across all unseen scenarios: ${transferText(bK, aK, { crashes: true })}${ev.shortest ? ` (shortest path succeeds ${pct(ev.shortest.successRate)})` : ""}.`
          : ""
      }${pair.gain > 0 ? "" : " Feedback did not change the outcome on any unseen scenario."}`,
    );
    drawCurve();
  });


// ---------- before → after, with how sure we are ----------
// Paired by scenario (same 4 seeds each), bootstrap over scenarios with a
// fixed seed, like tools/legacy/report.mjs. A change is "solid" when its 95%
// interval excludes zero; otherwise captions say it is within noise.
function pairedChange(bKey, aKey, outcome) {
  const ev = arena.evaluation;
  const M = ev.metrics;
  const field = { reached: "successRate", intercepted: "interceptRate", crashed: "crashRate" }[outcome];
  const rate = (e) => e.results.filter((r) => r.outcome === outcome).length / e.results.length;
  const diffs = evScenarios(ev)
    .map((s) => [ev.episodes.find((e) => e.condition === bKey && e.scenario.id === s.id), ev.episodes.find((e) => e.condition === aKey && e.scenario.id === s.id)])
    .filter(([b, a]) => b && a)
    .map(([b, a]) => rate(a) - rate(b));
  let seed = 20261113;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const means = [];
  for (let i = 0; i < 2000; i++) {
    let sum = 0;
    for (let j = 0; j < diffs.length; j++) sum += diffs[Math.floor(rnd() * diffs.length)];
    means.push(sum / diffs.length);
  }
  means.sort((x, y) => x - y);
  const lo = means[49];
  const hi = means[1950];
  return { b: M[bKey][field], a: M[aKey][field], solid: diffs.length > 1 && (lo > 0 || hi < 0), n: diffs.length };
}

// "caught by the bird 28% → 13%; success 59% → 69%, within noise at 36
// scenarios": solid changes first and in bold, the rest marked as noise.
function transferText(bKey, aKey, { crashes = false } = {}) {
  const items = [
    ["success", pairedChange(bKey, aKey, "reached")],
    ["caught by the bird", pairedChange(bKey, aKey, "intercepted")],
    ...(crashes ? [["wall crashes", pairedChange(bKey, aKey, "crashed")]] : []),
  ];
  const n = items[0][1].n;
  const fmt = ([label, c], bold) => `${label} ${bold ? "<b>" : ""}${pct(c.b)} → ${pct(c.a)}${bold ? "</b>" : ""}`;
  const solid = items.filter(([, c]) => c.solid);
  const noise = items.filter(([, c]) => !c.solid);
  const parts = solid.map((it) => fmt(it, true));
  if (noise.length) parts.push(`${noise.map((it) => fmt(it, false)).join(", ")}${noise.length === 2 ? ": both" : noise.length > 2 ? ": all" : ","} within noise at ${n} scenarios`);
  return parts.join("; ");
}

// ---------- learning reel: watch the training run in order ----------
// Baseline, then every training episode at speed with a live tally of
// goals reached and bird behaviors read correctly, then the frozen strategy
// and the held-out result. Everything shown is the recorded run, in order.
function reelStrip(upto) {
  const cols = [
    ...(arena.baseline ? [{ label: "B", ep: arena.baseline, base: true }] : []),
    ...arena.training.map((ep) => ({ label: `T${ep.index}`, ep })),
  ];
  const offset = arena.baseline ? 1 : 0;
  return `<div class="reel">${cols
    .map(({ label, ep, base }, i) => {
      const k = i - offset; // training index (−1 = baseline)
      const state = k === upto ? "now" : k > upto ? "later" : "";
      const read = base || !ep.belief ? "" : ep.belief.familyCorrect ? "ok" : "no";
      return `<div class="cell ${base ? "base" : ""} ${state}"><span class="read ${k <= upto ? read : ""}"></span><span class="bar"><i style="height:${Math.round(ep.summary.successRate * 100)}%"></i></span>${label}</div>`;
    })
    .join("")}</div><div class="reel-key">bar: share of 4 seeds that reached the goal · dot: bird behavior read right (amber) or wrong (red)</div>`;
}

$("btnLearn").onclick = () =>
  task("Learning…", async () => {
    const T = arena.training;
    if (!T.length) {
      progress("The learning reel needs a training run. Load a recording or run steps 1–3 first.");
      return;
    }
    const who = (recorded ? arena.recordedUsingModel : client.enabled) ? "Ripple" : "The stand-in";
    const sp = 4;
    $("curve").closest("section")?.scrollIntoView({ behavior: "smooth", block: "start" });

    if (arena.baseline) {
      const b = arena.baseline.summary;
      drawCurve(-1);
      caption("Before learning", S(`Shortest path, ignoring the bird: <b>${b.reached}/${b.trials}</b> reached, caught ${b.intercepted} of ${b.trials}.${reelStrip(-1)}`, `Shortest path, ignoring the bird: <b>${b.reached}/${b.trials}</b> reached.`));
      showDetail(arena.baseline);
      await playEpisode(arena.baseline, null, { speed: sp, clear: true, keep: false, title: "Baseline · shortest path" });
      if (stopRequested) return hideCaption();
      await pause(1500);
    }

    let reads = 0;
    let wins = 0;
    for (const [i, ep] of T.entries()) {
      if (stopRequested) return hideCaption();
      drawCurve(i);
      showDetail(ep);
      const bl = ep.belief;
      const guess = bl?.guess ?? ep.defender.policy?.bird_behavior_guess ?? "unknown";
      caption(
        `Training ${i + 1} of ${T.length}`,
        S(`A new bird, designed by the attacker to beat the drone. ${who} watched it for 2 s and guessed <b>${esc(guess)}</b>…${reelStrip(i - 1)}`, `New bird. ${who} guesses <b>${esc(guess)}</b>.`),
      );
      const why = await playEpisode(ep, null, { speed: sp, clear: true, keep: false, title: `Training ${ep.scenario.id}` });
      if (stopRequested || why !== "done") return hideCaption();
      if (bl?.familyCorrect) reads++;
      wins += ep.summary.reached;
      caption(
        `Training ${i + 1} of ${T.length}`,
        S(
          `The bird was <b>${esc(ep.scenario.bird.strategy)}</b>${bl ? (bl.familyCorrect ? " — read correctly" : " — misread") : ""}. <b>${ep.summary.reached}/${ep.summary.trials}</b> reached. So far: ${reads}/${i + 1} birds read right, ${wins}/${(i + 1) * 4} flights through.${reelStrip(i)}`,
          `It was <b>${esc(ep.scenario.bird.strategy)}</b>. <b>${ep.summary.reached}/${ep.summary.trials}</b> reached.`,
        ),
      );
      await pause(2200);
    }

    if (stopRequested) return hideCaption();
    drawCurve();
    const s = arena.strategy;
    if (s?.text) {
      const first = s.text.split(/(?<=\.)\s/).slice(0, 2).join(" ");
      const h = Math.floor(T.length / 2);
      const readIn = (eps) => eps.filter((e) => e.belief?.familyCorrect).length;
      const trend = T.length >= 4 && T.every((e) => e.belief) ? `Bird read right in ${readIn(T.slice(0, h))} of the first ${h} episodes, ${readIn(T.slice(-h))} of the last ${h}. ` : "";
      caption("What it learned", S(`${trend}After ${s.fromEpisodes ?? T.length} verified episodes, ${who} wrote down and froze a strategy:<br><i>“${esc(first)}…”</i>${reelStrip(T.length - 1)}`, `<i>“${esc(s.text.split(/(?<=\.)\s/)[0])}”</i>`));
      await pause(7000);
      if (stopRequested) return hideCaption();
    }

    const pair = demoPair();
    const M = arena.evaluation?.metrics;
    if (pair && M?.[pair.bKey] && M?.[pair.aKey]) {
      const b = M[pair.bKey];
      const a = M[pair.aKey];
      caption(
        "Does it transfer?",
        S(
          `Unseen scenarios, the same harness without → with the strategy: ${transferText(pair.bKey, pair.aKey, { crashes: true })}. Here is one of them, flown with the strategy.`,
          `Unseen scenarios: ${transferText(pair.bKey, pair.aKey)}.`,
        ),
      );
      showDetail(pair.after);
      await playEpisode(pair.after, null, { speed: 2, clear: true, keep: true, title: `With learned strategy · unseen ${pair.after.scenario.id}` });
    }
  });

$("btnStop").onclick = () => {
  stopRequested = true;
  viewer.playback?.resolve("stopped");
};

$("btnReset").onclick = () => {
  arena.reset();
  recorded = false;
  $("recordedTag").hidden = true;
  viewer.clearTrails();
  viewer.clearAgents();
  for (const id of ["episodes", "evalGrid", "detailDefender", "detailAttack"]) $(id).innerHTML = "";
  $("rematch").textContent = "The rematch runs after training: the first failed episode, re-flown with the frozen strategy.";
  drawCurve();
  hideCaption();
  $("evalTable").textContent = "Not run yet.";
  $("strategy").className = "strategy muted small-text";
  $("strategy").textContent = "Not frozen yet. It is written after the training episodes.";
  $("epNote").textContent = "";
  hud("Ready");
  progress("");
  refresh();
};

// Save: server writes runs/arena/<stamp>/{session.json, episodes.jsonl, metrics.json}; browser also downloads it.
$("btnExport").onclick = async () => {
  const session = arena.exportSession({ includeFrames: false });
  try {
    const r = await fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(session) });
    const body = await r.json();
    progress(r.ok ? `Saved to ${body.dir}` : `Server save failed: ${body.error}`);
  } catch (e) {
    progress(`Server save failed (${e.message}); downloaded only.`);
  }
  const blob = new Blob([JSON.stringify(session)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `arena-session-${session.exportedAt.replace(/[:.]/g, "-")}.json`;
  a.click();
};

// Load a saved session. Trajectories are re-simulated from the saved
// scenario + decision + seed; the engine is deterministic, so outcomes must
// match what was recorded. Mismatches are reported.
$("fileLoad").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  loadSession(JSON.parse(await file.text()));
  e.target.value = "";
};

function loadSession(data) {
  $("btnReset").onclick();
  const { checked, mismatched } = arena.importSession(data);
  viewer.setBeliefOwner(arena.recordedUsingModel ? "Ripple" : "The stand-in");
  recorded = true;
  $("recordedTag").hidden = false;
  if (arena.baseline) addEpisodeRow(arena.baseline);
  arena.training.forEach(addEpisodeRow);
  renderStrategy();
  renderRematch();
  drawCurve();
  if (arena.evaluation) renderEval(arena.evaluation);
  $("ledger").textContent = data.ledger
    ? `Recorded session${data.usingModel ? "" : " (offline stand-ins, not Ripple)"}: ${data.ledger.calls} model calls, ${(data.ledger.promptTokens + data.ledger.completionTokens).toLocaleString()} tokens.`
    : "";
  progress(`Loaded recording from ${data.exportedAt}. Re-simulated ${checked} episodes: ${mismatched ? `${mismatched} did NOT reproduce the recorded outcome` : "all outcomes reproduced exactly"}.`);
  refresh();
}

$("speed").onchange = () => viewer.setSpeed(speed());
document.querySelector('[data-cam="overview"]').onclick = () => {
  follow = false;
  document.querySelector('[data-cam="follow"]').classList.remove("on");
  if (viewer.playback) viewer.playback.follow = false;
  viewer.overview();
};
document.querySelector('[data-cam="follow"]').onclick = (e) => {
  follow = !follow;
  e.target.classList.toggle("on", follow);
  if (viewer.playback) viewer.playback.follow = follow;
  if (!follow) viewer.overview();
};
document.querySelectorAll("[data-layer]").forEach((el) => (el.onchange = () => viewer.setLayer(el.dataset.layer, el.checked)));
// W toggles the waypoint graph (works from the demo controller too).
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|SELECT|TEXTAREA/.test(e.target?.tagName || "")) return;
  if (e.key !== "w" && e.key !== "W") return;
  const box = document.querySelector('[data-layer="waypoints"]');
  box.checked = !box.checked;
  viewer.setLayer("waypoints", box.checked);
});

// ---------- environment + view ----------
// Each environment opens with its demo recording when one is present. Real
// Ripple recordings come first; offline stand-ins are labelled as such.
const ENVIRONMENTS = {
  "maps/building.json": ["recordings/ripple-training.json"],
  "maps/factory.json": ["recordings/ripple-factory.json", "recordings/offline-factory.json"],
  "maps/factory-full.json": ["recordings/ripple-factory-full.json", "recordings/offline-factory-full.json"],
};
const envSelect = $("envSelect");
if (![...envSelect.options].some((o) => o.value === mapFile)) envSelect.add(new Option(map.name || mapFile, mapFile));
envSelect.value = mapFile;
envSelect.onchange = async () => {
  const next = envSelect.value;
  const q = new URLSearchParams({ map: next });
  for (const rec of ENVIRONMENTS[next] || []) {
    try {
      if ((await fetch(rec, { method: "HEAD" })).ok) {
        q.set("recording", rec);
        break;
      }
    } catch {}
  }
  location.search = q.toString();
};

// Scan maps (render.page) can also be watched in the full Gaussian-splat
// scene. That page runs in an iframe and re-simulates this page's session.
const scanPage = map.render?.page;
let scanFrame = null;
function setView(view) {
  document.querySelectorAll("#viewToggle [data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
  if (view === "scan") {
    const want = arena.evaluation ? "parent" : "";
    if (!scanFrame || scanFrame.session !== arena.evaluation) {
      scanFrame?.remove();
      scanFrame = document.createElement("iframe");
      scanFrame.className = "scan-frame";
      scanFrame.title = "Full factory scan";
      scanFrame.session = arena.evaluation;
      scanFrame.src = `${scanPage}?embed=1${want ? `&recording=${want}` : ""}`;
      $("stage").appendChild(scanFrame);
    }
    scanFrame.hidden = false;
  } else if (scanFrame) {
    scanFrame.hidden = true;
  }
}
if (scanPage) {
  $("viewToggle").hidden = false;
  document.querySelectorAll("#viewToggle [data-view]").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
}
// The embedded scan page reads the session from here (same origin).
$("gridLink").href = `grid.html?${new URLSearchParams({ map: mapFile, ...(params.get("recording") ? { recording: params.get("recording") } : {}) })}`;
// usingModel must describe who made the decisions, not whether a key is set now.
window.scanSession = () =>
  arena.evaluation
    ? { ...arena.exportSession({ includeFrames: false }), usingModel: recorded ? arena.recordedUsingModel : arena.usingModel, demoPairKeys: arena.demoPairKeys }
    : null;

$("evalNote").textContent = `${heldout.length} unseen scenarios × 4 seeds`;
hud("Ready", `1 baseline → 2 attack → 3 adapt (8 episodes, then freeze)\n→ 4 evaluate on ${heldout.length} unseen scenarios`);
drawCurve();
refresh();
// ?recording=recordings/<file>.json loads a saved session on page open.
if (params.get("recording")) {
  try {
    const data = preloaded || (await (await fetch(params.get("recording"))).json());
    const flownOn = data.mapFile || "maps/building.json";
    if (flownOn !== mapFile) throw new Error(`it was flown on ${flownOn}, not ${mapFile}`);
    loadSession(data);
  } catch (e) {
    progress(`Could not load recording: ${e.message}`);
  }
}
// ?view=scan opens a scan map straight into the full-scan view (for demo tabs).
if (scanPage && params.get("view") === "scan") setView("scan");
window.arena = arena;
window.viewer = viewer;
