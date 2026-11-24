// Scenario grid: four scenarios flown side by side, so the audience sees how
// start, goal, bird start and hidden bird behavior vary. Held-out scenarios
// can be flown with a recording's real decisions (re-simulated); random
// scenarios are flown by the labelled non-LLM baselines only.
import { World, shortRouteLabel as routeLabel } from "./world.js";
import { validateDefender, shortestPathPolicy } from "./policy.js";
import { heuristicDefender } from "./agents.js";
import { runEpisode, randomScenario } from "./scenarios.js";
import { Viewer, RecordedSource, OUTCOME_COLORS } from "./render.js";
import { showcaseSeed, episodeScore } from "./showcase.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;
const params = new URLSearchParams(location.search);
// Presentation mode is the default (see app.js); ?full=1 shows every detail.
const SIMPLE = !params.get("full");
if (SIMPLE) document.body.classList.add("simple");
const status = $("gridStatus");
const say = (t) => {
  status.textContent = t;
  status.hidden = !t;
};

// ---- environment, recording, scenarios ----
let rec = null;
if (params.get("recording")) {
  try {
    rec = await (await fetch(params.get("recording"))).json();
  } catch {}
}
const mapFile = params.get("map") || rec?.mapFile || "maps/building.json";
if (rec && (rec.mapFile || "maps/building.json") !== mapFile) rec = null;
const map = await (await fetch(mapFile)).json();
const world = new World(map);
const heldoutFile = mapFile.endsWith("building.json") ? "scenarios/heldout.json" : `scenarios/${mapFile.split("/").pop().replace(".json", "")}-heldout.json`;
const fileScenarios = (await (await fetch(heldoutFile)).json()).scenarios;
const ev = rec?.evaluation || null;
// With a recording, page through the scenarios it was evaluated on.
const heldout = ev
  ? [...new Map(ev.episodes.map((e) => [e.scenario.id, e.scenario])).values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
  : fileScenarios;

const envSelect = $("envSelect");
if (![...envSelect.options].some((o) => o.value === mapFile)) envSelect.add(new Option(map.name || mapFile, mapFile));
envSelect.value = mapFile;
envSelect.onchange = () => (location.search = new URLSearchParams({ map: envSelect.value }).toString());
$("backLink").href = `./?${new URLSearchParams({ map: mapFile, ...(params.get("recording") && rec ? { recording: params.get("recording") } : {}) })}`;

// ---- who flies ----
// Condition labels already say "Ripple …" or "Heuristic stand-in …".
const flyers = [
  ...(ev ? ev.conditions.filter((c) => c.key !== "shortest").map((c) => ({ key: `rec:${c.key}`, label: rec.usingModel ? c.label : `${c.label} (offline, not Ripple)`, recorded: true })) : []),
  { key: "heuristic", label: "Bird-aware heuristic (not Ripple)" },
  { key: "shortest", label: "Shortest path, no avoidance (not Ripple)" },
];
const flyerSelect = $("flyerSelect");
for (const f of flyers) flyerSelect.add(new Option(f.label, f.key));
// Default: the recording's best-known condition (after feedback), else heuristic.
const pref = ev && (rec.demoPairKeys?.[1] || ["strategy", "structured_feedback", "feedback"].find((k) => ev.conditions.some((c) => c.key === k)));
flyerSelect.value = pref ? `rec:${pref}` : "heuristic";
// ?flyer=<condition key>|heuristic|shortest preselects who flies (for demo tabs).
const askFlyer = params.get("flyer");
if (askFlyer) {
  const want = flyers.find((f) => f.key === askFlyer || f.key === `rec:${askFlyer}`);
  if (want) flyerSelect.value = want.key;
}

function decide(sc, flyerKey) {
  if (flyerKey.startsWith("rec:")) {
    const ep = ev?.episodes.find((e) => e.condition === flyerKey.slice(4) && e.scenario.id === sc.id);
    if (!ep) return { none: "No recorded decision for this scenario" };
    if (ep.defender.invalid) return { none: `Recorded decision was invalid (${ep.defender.invalid})` };
    return { policy: ep.defender.policy, recorded: ep };
  }
  if (flyerKey === "shortest") return { policy: shortestPathPolicy(world, sc) };
  return { policy: validateDefender(heuristicDefender(world, sc, { strategy: "bird-aware" }), world, sc).policy };
}

// ---- cells ----
const cells = [];
for (let i = 0; i < 4; i++) {
  const el = document.createElement("section");
  el.className = "grid-cell";
  el.innerHTML = `<div class="cell-stage"></div><div class="cell-info"><div class="cell-title"></div><div class="cell-row"></div></div><div class="cell-result" hidden></div>`;
  $("cells").appendChild(el);
  cells.push({ el, stage: el.querySelector(".cell-stage"), title: el.querySelector(".cell-title"), row: el.querySelector(".cell-row"), result: el.querySelector(".cell-result") });
}
for (const c of cells) {
  c.viewer = new Viewer(c.stage, world);
  c.viewer.overview();
}
say("Loading flight models…");
await Promise.all(cells.map((c) => c.viewer.loadFlightModels().catch(() => {})));

// ---- run four ----
let page = 0;
let current = [];
let runId = 0;
const speed = () => Number($("speed").value);
$("speed").onchange = () => cells.forEach((c) => c.viewer.setSpeed(speed()));

async function fly(scenarios) {
  const id = ++runId;
  current = scenarios;
  const flyerKey = flyerSelect.value;
  const flyer = flyers.find((f) => f.key === flyerKey);
  const runs = scenarios.map((sc, i) => {
    const c = cells[i];
    c.result.hidden = true;
    c.viewer.clearTrails();
    c.viewer.clearAgents();
    if (!sc) {
      c.title.textContent = "—";
      c.row.textContent = "";
      return Promise.resolve();
    }
    const d = decide(sc, flyerKey);
    const where = `${esc(sc.start)} → ${esc(sc.goal)}`;
    c.title.innerHTML = SIMPLE ? `<b>${esc(sc.id)}</b>` : `<b>${esc(sc.id)}</b>${sc.random ? " · random" : ""} · ${where}`;
    c.viewer.setTask(sc.start, sc.goal, sc.bird.start, (SIMPLE ? "BIRD" : "BIRD · behavior hidden"));
    if (d.none) {
      c.row.textContent = d.none;
      return Promise.resolve();
    }
    const p = d.policy;
    const short = flyerKey.startsWith("rec:") ? (rec.usingModel ? "Ripple" : "Stand-in") : flyerKey === "shortest" ? "Shortest path" : "Heuristic";
    c.row.innerHTML = `${short}: ${p.bird_behavior_guess && p.bird_behavior_guess !== "unknown" ? `guessed <b>${esc(p.bird_behavior_guess)}</b>, ` : ""}${esc(p.route_id)} (${esc(routeLabel(world, p.route))})`;
    c.viewer.setBeliefOwner(short);
    c.viewer.setBelief(p.danger_point || null, null);
    const out = runEpisode(world, sc, p);
    const mismatch = d.recorded && d.recorded.results.map((r) => r.outcome).join() !== out.results.map((r) => r.outcome).join();
    // The solid flight is the best seed (a success past the bird when there
    // is one); the other seeds fly as ghosts and the card counts all four.
    const lead = showcaseSeed(out.results);
    const sources = out.frames.map((frames, k) => ({ source: new RecordedSource(frames), outcome: () => out.results[k].outcome, primary: k === lead }));
    return c.viewer.play(sources, { speed: speed(), keepTrails: false, birdRange: sc.bird.trigger_distance }).then((why) => {
      if (why !== "done" || id !== runId) return;
      const r0 = out.results[lead];
      const guess = p.bird_behavior_guess;
      const truth = sc.bird.strategy;
      c.viewer.setBirdText(`BIRD · was ${truth}`);
      c.viewer.setBelief(p.danger_point || null, r0.closest ? { drone: r0.closest.drone, dist: r0.minSeparation } : null);
      const good = out.summary.reached >= out.summary.trials / 2;
      c.result.hidden = false;
      c.result.style.borderColor = good ? hex(OUTCOME_COLORS.reached) : hex(OUTCOME_COLORS.intercepted);
      if (SIMPLE) c.result.innerHTML = `<b>${out.summary.reached}/${out.summary.trials}</b> reached`;
      else c.result.innerHTML = `<b>${out.summary.reached}/${out.summary.trials}</b> reached · bird was <b>${esc(truth)}</b>${
        guess && guess !== "unknown" ? (guess === truth ? " (read correctly)" : ` (guessed ${esc(guess)})`) : ""
      }${mismatch ? ' · <span class="warn">differs from recording</span>' : ""}`;
    });
  });
  await Promise.all(runs);
  if (id === runId && $("auto").checked) setTimeout(() => id === runId && next(), 3000);
}

// Best flights first: with a recorded flyer, scenarios are ordered by how
// well that flyer did (all are still there on later pages). ?ids=H9,H5,…
// puts named scenarios first for flyers without a recording.
function ordered() {
  const flyerKey = flyerSelect.value;
  if (flyerKey.startsWith("rec:")) {
    const score = (sc) => episodeScore(ev.episodes.find((e) => e.condition === flyerKey.slice(4) && e.scenario.id === sc.id));
    return { list: [...heldout].sort((a, b) => score(b) - score(a)), note: " · best first" };
  }
  const ids = (params.get("ids") || "").split(",").filter(Boolean);
  if (!ids.length) return { list: heldout, note: "" };
  const rank = (sc) => (ids.includes(sc.id) ? ids.indexOf(sc.id) : ids.length);
  return { list: [...heldout].sort((a, b) => rank(a) - rank(b)), note: " · best first" };
}

function showHeldout() {
  const { list, note } = ordered();
  const pages = Math.ceil(list.length / 4);
  page = ((page % pages) + pages) % pages;
  const slice = list.slice(page * 4, page * 4 + 4);
  $("pageNote").textContent = `${page * 4 + 1}–${page * 4 + slice.length} of ${list.length}${note}`;
  fly([0, 1, 2, 3].map((i) => slice[i] || null));
}

let shuffleSeed = Math.floor(Math.random() * 1e6);
async function showRandom() {
  say("Drawing 4 solvable random scenarios…");
  $("pageNote").textContent = "";
  await new Promise((r) => setTimeout(r, 20));
  const behaviors = ["pursue", "intercept", "ambush", "patrol"].sort(() => Math.random() - 0.5);
  const scs = [];
  for (let i = 0; i < 4; i++) {
    shuffleSeed += 1;
    scs.push(randomScenario(world, shuffleSeed, { id: `R${i + 1}`, strategy: behaviors[i] }));
    await new Promise((r) => setTimeout(r, 0));
  }
  say("");
  fly(scs);
}

function syncControls() {
  const random = $("sourceSelect").value === "random";
  $("btnPrev").hidden = $("btnNext").hidden = $("pageNote").hidden = random;
  $("btnShuffle").hidden = !random;
  // Recorded decisions exist only for the held-out scenarios they were made on.
  for (const o of flyerSelect.options) o.disabled = random && o.value.startsWith("rec:");
  if (random && flyerSelect.value.startsWith("rec:")) flyerSelect.value = "heuristic";
}
const next = () => ($("sourceSelect").value === "random" ? showRandom() : (page++, showHeldout()));
$("sourceSelect").onchange = () => {
  syncControls();
  if ($("sourceSelect").value === "random") showRandom();
  else showHeldout();
};
$("btnPrev").onclick = () => (page--, showHeldout());
$("btnNext").onclick = () => (page++, showHeldout());
$("btnShuffle").onclick = showRandom;
$("btnReplay").onclick = () => fly(current);
flyerSelect.onchange = () => ($("sourceSelect").value === "random" ? fly(current) : ((page = 0), showHeldout()));

if (params.get("source") === "random") $("sourceSelect").value = "random";
syncControls();
say(
  ev
    ? `${rec.usingModel ? "Recorded Ripple" : "Recorded offline stand-in (NOT Ripple)"} decisions from ${String(rec.exportedAt || "").slice(0, 16).replace("T", " ")} UTC, re-simulated on 4 seeds each. Random scenarios use the labelled baselines only.`
    : "No recording loaded: scenarios are flown by the labelled non-LLM baselines.",
);
setTimeout(() => say(""), 6000);
if ($("sourceSelect").value === "random") showRandom();
else showHeldout();
window.cells = cells;
