// Spatial Arena V1 prototype: fly, replay, compare and rank flights on this
// device. No server, no model calls, nothing sent anywhere.
import { makeWorld, fly, replay, fingerprint, compareRuns, BUILTIN, MAP_PATH, SCENARIO_PATH } from "./runner.js";
import { CONTROLLERS, EXAMPLE_POLICY, workerProgramController } from "./controllers.js";
import { createView, frameAt } from "./view.js";

const $ = (id) => document.getElementById(id);
const ROOT = new URL("../", import.meta.url);
const WORKER_URL = new URL("./policy_worker.js", import.meta.url);
const STORE_KEY = "spatial-arena.runs.v1";
const CODE_KEY = "spatial-arena.code.v1";
const MAX_RUNS = 400;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

let world, view, routes, rippleCode, fixture = null;
let runs = [];
let current = null; // { rec, data, verified }
let ghost = null; // { rec, data }
let t = 0, playing = false, lastTs = 0;
let boardTab = "route";

// ---------- storage (best effort: the page works without it) ----------
function loadRuns() {
  try { const r = JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); return Array.isArray(r) ? r : []; } catch { return []; }
}
function saveRuns() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(runs.slice(-MAX_RUNS))); return true; } catch { $("board-status").textContent = "This browser would not store the flights (private mode or storage full). They stay until you leave the page; export them to keep them."; return false; }
}
function loadCode() { try { return localStorage.getItem(CODE_KEY); } catch { return null; } }
function saveCode(s) { try { localStorage.setItem(CODE_KEY, s); } catch {} }

// ---------- helpers ----------
const routeOf = (id) => routes.find((r) => r.id === id);
const progOf = (id) => CONTROLLERS.find((c) => c.id === id);
const kindClass = (k) => (k === "hand-written" ? "hand-written" : k.startsWith("written by Ripple") ? "ripple" : k === "yours" ? "yours" : "imported");
const badge = (kind, imported) => `<span class="badge ${kindClass(kind)}">${esc(kind)}</span>${imported ? ' <span class="badge imported">imported</span>' : ""}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// JSON spaced out for reading: arrays and flat objects (such as free_space_m)
// on one line each, everything else indented.
const pretty = (o) => (o === undefined || o === null ? "(none)" : JSON.stringify(o, null, 2)
  .replace(/\[\s+([^\[\]{}]*?)\s+\]/g, (m, inner) => `[${inner.split(/,\s*/).join(", ")}]`)
  .replace(/\{\n\s+([^{}\[\]]*?)\n\s*\}/g, (m, inner) => `{ ${inner.split(/,\n\s*/).join(", ")} }`));
const J = (x) => JSON.parse(JSON.stringify(x));
const sameResult = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const selectedRoute = () => routeOf($("route").value);
const selectedSeed = () => selectedRoute().seeds[Number($("wind").value)];
const windName = (sc, seed) => `wind ${sc.seeds.indexOf(seed) + 1}`;
const outcomeText = (r) => (r.outcome === "reached" ? `reached in ${r.time} s` : `not reached (closest ${r.minGoalDist} m)`);

// ---------- start ----------
async function start() {
  const status = $("status");
  status.textContent = "Loading the factory map...";
  const t0 = performance.now();
  const [map, sets, code] = await Promise.all([
    fetch(new URL(MAP_PATH, ROOT)).then((r) => r.json()),
    fetch(new URL(SCENARIO_PATH, ROOT)).then((r) => r.json()),
    fetch(new URL("programs/ripple-cap2-run3-v7.js", import.meta.url)).then((r) => r.text()),
  ]);
  world = makeWorld(map);
  rippleCode = code;
  routes = [...sets.train.map((r) => ({ ...r, group: "practice" })), ...sets.dev.map((r) => ({ ...r, group: "development" }))];
  const sel = $("route");
  for (const [group, label] of [["practice", "Practice routes (Ripple practiced on these)"], ["development", "Development routes"]]) {
    const og = document.createElement("optgroup");
    og.label = label;
    for (const r of routes.filter((x) => x.group === group)) og.append(new Option(`${r.id}: ${r.straight_m} m apart`, r.id));
    sel.append(og);
  }
  sel.value = "D1";

  const list = $("programs");
  for (const c of CONTROLLERS) {
    const lab = document.createElement("label");
    lab.className = "program";
    lab.innerHTML = `<input type="radio" name="program" value="${c.id}"${c.id === "ripple-v7" ? " checked" : ""}><strong>${esc(c.name)}</strong> ${badge(c.kind)}<p>${esc(c.blurb)}</p>`;
    list.append(lab);
  }
  $("code").value = loadCode() || EXAMPLE_POLICY;
  $("animate").checked = !reduceMotion.matches;

  view = createView($("view"), world);
  runs = loadRuns();
  bind();
  window.__arena = { loadMs: performance.now() - t0 }; // read by the verification notes
  // First visit from the article: show a flight straight away, without
  // saving it. With reduced motion it opens at its end instead of playing.
  $("route").value = DEMO.route;
  $("wind").value = String(DEMO.wind);
  onRouteChange();
  await flyNow({ demo: true });
  window.__arena.firstFlightMs = performance.now() - t0;
  setTimeout(() => browserCheck(false), 1200);
}

// D21 wind 1: Ripple's flight program reaches it in 9.45 s with 3 wall
// contacts, and the hand-written program also reaches it (16.62 s), so the
// first flight shows turns and contacts without picking a route the
// comparison fails.
const DEMO = { route: "D21", wind: 0 };

function bind() {
  $("route").addEventListener("change", onRouteChange);
  $("wind").addEventListener("change", onRouteChange);
  $("programs").addEventListener("change", () => { $("editor").hidden = selectedProgram() !== "custom"; });
  $("code").addEventListener("input", () => saveCode($("code").value));
  $("code").addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); document.execCommand("insertText", false, "  "); }
  });
  $("reset-code").addEventListener("click", () => { $("code").value = EXAMPLE_POLICY; saveCode(EXAMPLE_POLICY); });
  $("fly").addEventListener("click", flyNow);
  $("play").addEventListener("click", () => (playing ? pause() : play()));
  $("prev").addEventListener("click", () => { pause(); setT(Math.ceil(t - 1e-6) - 1); });
  $("next").addEventListener("click", () => { pause(); setT(Math.floor(t + 1e-6) + 1); });
  $("t").addEventListener("input", (e) => { pause(); setT(Number(e.target.value)); });
  $("slice").addEventListener("change", render);
  $("ghost").addEventListener("change", onGhostChange);
  $("tab-route").addEventListener("click", () => setTab("route"));
  $("tab-all").addEventListener("click", () => setTab("all"));
  $("export").addEventListener("click", () => download("spatial-arena-flights.json", { format: "spatial-arena-flights", v: 1, flights: runs }));
  $("import").addEventListener("change", onImport);
  $("clear").addEventListener("click", () => {
    if (!runs.length || !confirm(`Delete all ${runs.length} saved flights from this browser? This cannot be undone.`)) return;
    runs = [];
    saveRuns();
    refreshLists();
  });
  $("selfcheck").addEventListener("click", () => browserCheck(true));
  $("board").addEventListener("click", onBoardClick);
  window.addEventListener("resize", () => { view.resize(); render(); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { view.repaint(); render(); });
}

const selectedProgram = () => document.querySelector('input[name="program"]:checked')?.value;

function onRouteChange() {
  const sc = selectedRoute();
  $("route-info").textContent = `${sc.straight_m} m in a straight line, which is blocked; the shortest way around through the waypoint graph is ${sc.graph_m} m.`;
  if (current && (current.rec.route !== sc.id || current.rec.seed !== selectedSeed())) {
    current = null;
    ghost = null;
    $("demo-note").textContent = "";
    pause();
    setT(0);
    $("result").innerHTML = "";
  }
  refreshLists();
  render();
}

// ---------- fly ----------
async function flyNow({ demo = false } = {}) {
  const sc = selectedRoute();
  const seed = selectedSeed();
  const pid = selectedProgram();
  const p = progOf(pid);
  const btn = $("fly");
  btn.disabled = true;
  if (!demo) $("demo-note").textContent = "";
  $("status").textContent = "Flying...";
  pause();
  let dispose = () => {};
  try {
    let controller;
    let code = null;
    if (BUILTIN[pid]) controller = BUILTIN[pid].make(world, sc);
    else {
      code = pid === "ripple-v7" ? rippleCode : $("code").value;
      const w = await workerProgramController(code, seed, WORKER_URL);
      dispose = w.dispose;
      if (w.compileError) {
        $("status").innerHTML = `<span class="bad">Your program did not compile: ${esc(w.compileError)}</span>`;
        return;
      }
      controller = w.controller;
    }
    const data = await fly(world, sc, seed, p.level, controller);
    const rec = {
      format: "spatial-arena-flight", v: 1, id: newId(), savedAt: new Date().toISOString(),
      route: sc.id, seed, level: p.level,
      program: { id: p.id, name: pid === "custom" ? ($("custom-name").value.trim() || "My flight program").slice(0, 40) : p.name, kind: p.kind, ...(pid === "custom" ? { code, codeHash: fingerprint(code) } : {}) },
      commands: J(data.steps.map((s) => s.command)),
      notes: data.steps.map((s) => ({ reply: s.reply ?? null, say: s.say || "", error: s.error || null })),
      result: data.result,
    };
    if (demo) {
      $("status").textContent = "";
      $("demo-note").textContent = `A first flight to start with: Ripple's flight program on route ${sc.id}, which it reaches. It does not reach every route; on this page it reaches 43 of the 72 route and wind pairs. Try another route, or another flight program, below.`;
      show(rec, data, true);
      return;
    }
    // Flights are deterministic, so flying the same program again on the same
    // route and wind repeats a saved flight: keep the one already saved.
    const same = runs.find((r) => r.route === rec.route && r.seed === rec.seed && r.program.id === rec.program.id && r.program.name === rec.program.name && (r.program.codeHash || "") === (rec.program.codeHash || "") && fingerprint(r.commands) === fingerprint(rec.commands));
    if (same) {
      $("status").textContent = `Flight computed in ${Math.round(data.ms)} ms: identical, command for command, to a flight already saved, so it was not saved twice.`;
      show(same, data, true);
      document.querySelector(".stage").scrollIntoView({ block: "start", behavior: $("animate").checked ? "smooth" : "auto" });
      return;
    }
    runs.push(rec);
    saveRuns();
    const errors = data.steps.filter((s) => s.error).length;
    $("status").textContent = `Flight computed in ${Math.round(data.ms)} ms and saved.${errors ? ` The program failed on ${errors} of ${data.steps.length} seconds (the drone hovered); see the panel.` : ""}`;
    show(rec, data, true);
    document.querySelector(".stage").scrollIntoView({ block: "start", behavior: $("animate").checked ? "smooth" : "auto" });
  } catch (e) {
    $("status").innerHTML = `<span class="bad">${esc(e.message || e)}</span>`;
  } finally {
    dispose();
    btn.disabled = false;
  }
}

// Show a flight. With no data, re-fly it from its recorded commands.
function show(rec, data = null, fresh = false) {
  const sc = routeOf(rec.route);
  let verified = true;
  if (!data) {
    data = replay(world, sc, rec.seed, rec.level, rec.commands);
    verified = sameResult(data.result, rec.result);
    data.steps.forEach((s, i) => Object.assign(s, rec.notes?.[i] ?? {}));
  }
  current = { rec, data, verified };
  if ($("route").value !== rec.route) $("route").value = rec.route;
  $("wind").value = String(sc.seeds.indexOf(rec.seed));
  ghost = null;
  refreshLists();
  showResult();
  const end = data.result.time;
  $("t").max = String(end);
  if (fresh && $("animate").checked) { setT(0); play(); }
  else setT(end);
}

function showResult() {
  const { rec, data, verified } = current;
  const r = data.result;
  $("result").innerHTML = `<strong>${esc(rec.program.name)}</strong> ${badge(rec.program.kind, rec.imported)} on ${esc(rec.route)}, ${windName(routeOf(rec.route), rec.seed)}:
    <span class="${r.outcome === "reached" ? "ok" : "bad"}">${outcomeText(r)}</span>
    <dl><div><dt>Time</dt><dd>${r.time} s</dd></div><div><dt>Wall contacts</dt><dd>${r.contacts}</dd></div><div><dt>Path flown</dt><dd>${r.pathLength} m</dd></div><div><dt>Closest to goal</dt><dd>${r.minGoalDist} m</dd></div><div><dt>Commands</dt><dd>${rec.commands.length}</dd></div></dl>
    <p class="hint">${verified ? "Re-flown from its recorded commands: identical result." : '<span class="bad">Re-flying the recorded commands gave a different result from the one stored; the leaderboard uses the re-flown one.</span>'}</p>`;
}

// ---------- timeline ----------
// The timeline runs to the end of the longer of the flight and its ghost.
const endTime = () => Math.max(current ? current.data.result.time : 0, ghost ? ghost.data.result.time : 0);
function setT(x) {
  const end = endTime();
  t = Math.max(0, Math.min(end, x));
  $("t").value = String(t);
  $("tlabel").textContent = `${t.toFixed(1)} s`;
  render();
}
function play() {
  if (!current) return;
  if (t >= endTime() - 1e-6) t = 0;
  playing = true;
  $("play").textContent = "Pause";
  $("play").setAttribute("aria-label", "Pause");
  lastTs = performance.now();
  requestAnimationFrame(tick);
}
function pause() {
  playing = false;
  $("play").textContent = "Play";
  $("play").setAttribute("aria-label", "Play");
}
function tick(ts) {
  if (!playing) return;
  const dt = Math.min(0.5, (ts - lastTs) / 1000); // wall-clock time, so slow frames do not slow the flight
  lastTs = ts;
  setT(t + dt * Number($("speed").value));
  if (t >= endTime() - 1e-6) return pause();
  requestAnimationFrame(tick);
}

function render() {
  if (!view) return;
  const sc = selectedRoute();
  view.draw({
    start: world.nodes[sc.start], goal: world.nodes[sc.goal], t,
    run: current ? current.data : null,
    ghost: ghost ? ghost.data : null,
    showSlice: $("slice").checked,
  });
  renderPanel();
  renderCompare();
}

function stepAt(data, time) {
  let k = 0;
  for (let i = 0; i < data.steps.length; i++) if (data.steps[i].t <= time + 1e-6) k = i;
  return k;
}

function renderPanel() {
  if (!current) {
    $("sec").textContent = "0";
    $("who").textContent = "no flight yet";
    $("obs").textContent = "Fly a program to see the readings it received each second.";
    $("reply").textContent = $("applied").textContent = $("dock-cmd").textContent = "";
    $("note").textContent = $("obs-hint").textContent = "";
    return;
  }
  const { rec, data } = current;
  const k = stepAt(data, t);
  const s = data.steps[k];
  $("sec").textContent = String(Math.round(s.t));
  $("who").textContent = rec.program.name;
  $("obs").textContent = pretty(s.obs);
  $("reply").textContent = s.reply === undefined || s.reply === null ? "(not recorded for this flight; only the applied commands are stored)" : pretty(s.reply);
  $("dock-cmd").textContent = `${Math.round(s.t)} s: ${s.command.velocity ? `velocity [${s.command.velocity.join(", ")}] m/s` : s.command.target ? `target [${s.command.target.join(", ")}] at ${s.command.speed} m/s` : "hover"}${s.error ? " (program error, hovered)" : ""}`;
  $("applied").textContent = `${pretty(s.command)}\n(held for 1 s; ${rec.level === "C2" ? "a target point, flown straight at" : "a velocity in m/s, capped at 5.5"})`;
  const bits = [];
  if (s.say) bits.push(`It said: "${esc(s.say)}"`);
  if (s.error) bits.push(`<span class="err">Program error, so the drone hovered: ${esc(s.error)}</span>`);
  const f = frameAt(data.frames, t);
  if (f) bits.push(`Drone now at [${f[1].toFixed(1)}, ${f[2].toFixed(1)}, ${f[3].toFixed(1)}], ${data.contacts.filter((c) => c.t <= t).length} wall contacts so far.`);
  $("note").innerHTML = bits.join("<br>");
  $("obs-hint").textContent = rec.program.id === "straight" || rec.program.id === "reactive"
    ? "The hand-written program reads the same readings as a JavaScript object."
    : "The flight program receives exactly this as one line of JSON text; it is spaced out here for reading. Free space is in metres, up to 12, along each direction.";
}

// ---------- ghost comparison ----------
function onGhostChange() {
  const id = $("ghost").value;
  const rec = runs.find((r) => r.id === id);
  ghost = rec ? { rec, data: replay(world, routeOf(rec.route), rec.seed, rec.level, rec.commands) } : null;
  $("t").max = String(endTime());
  setT(t);
}

function renderCompare() {
  const el = $("cmp-table");
  if (!current) { el.innerHTML = '<p class="hint">Fly or open a flight first.</p>'; return; }
  const rows = [current, ghost].filter(Boolean);
  const cell = (c) => {
    const r = c.data.result;
    const k = stepAt(c.data, t);
    const cmd = c.data.steps[k]?.command;
    return `<td>${esc(c.rec.program.name)}<br>${badge(c.rec.program.kind, c.rec.imported)}</td><td class="${r.outcome === "reached" ? "ok" : "bad"}">${outcomeText(r)}</td><td class="num">${r.contacts}</td><td class="num">${r.pathLength} m</td><td><code>${esc(JSON.stringify(cmd))}</code></td>`;
  };
  el.innerHTML = `<div class="tablewrap"><table><thead><tr><th></th><th>Flight program</th><th>Outcome</th><th>Contacts</th><th>Path</th><th>Command at ${Math.floor(t)} s</th></tr></thead><tbody>
    <tr><th scope="row">This flight</th>${cell(current)}</tr>${ghost ? `<tr><th scope="row">Ghost</th>${cell(ghost)}</tr>` : ""}</tbody></table></div>
    ${ghost ? "" : '<p class="hint">Choose a ghost above to fly a saved flight alongside this one.</p>'}`;
}

// ---------- leaderboard ----------
function setTab(which) {
  boardTab = which;
  $("tab-route").setAttribute("aria-selected", String(which === "route"));
  $("tab-all").setAttribute("aria-selected", String(which === "all"));
  renderBoard();
}

function refreshLists() {
  const sc = selectedRoute();
  const seed = selectedSeed();
  const same = runs.filter((r) => r.route === sc.id && r.seed === seed && r.id !== current?.rec.id).sort(compareRuns);
  const g = $("ghost");
  const keep = g.value;
  g.innerHTML = '<option value="">None</option>' + same.map((r) => `<option value="${r.id}">${esc(r.program.name)}: ${outcomeText(r.result)}, ${r.result.contacts} contacts</option>`).join("");
  g.value = same.some((r) => r.id === keep) ? keep : "";
  if (!g.value) ghost = null;
  renderBoard();
}

function renderBoard() {
  const el = $("board");
  if (boardTab === "route") {
    const sc = selectedRoute();
    const seed = selectedSeed();
    const list = runs.filter((r) => r.route === sc.id && r.seed === seed).sort(compareRuns);
    if (!list.length) { el.innerHTML = `<p class="hint">No saved flights on ${esc(sc.id)}, ${windName(sc, seed)} yet.</p>`; return; }
    el.innerHTML = `<div class="tablewrap"><table><thead><tr><th>#</th><th>Flight program</th><th>Outcome</th><th>Time</th><th>Contacts</th><th>Saved</th><th></th></tr></thead><tbody>${list
      .map((r, i) => `<tr class="${r.id === current?.rec.id ? "current" : ""}"><td class="num">${i + 1}</td><td>${esc(r.program.name)}<br>${badge(r.program.kind, r.imported)}</td><td class="${r.result.outcome === "reached" ? "ok" : "bad"}">${r.result.outcome === "reached" ? "reached" : `not reached, ${r.result.minGoalDist} m short`}</td><td class="num">${r.result.time} s</td><td class="num">${r.result.contacts}</td><td>${esc(r.savedAt.slice(0, 16).replace("T", " "))}</td><td>
        <button type="button" data-act="view" data-id="${r.id}">Replay</button><button type="button" data-act="ghost" data-id="${r.id}">Ghost</button><button type="button" data-act="export" data-id="${r.id}">Export</button>${r.program.code ? `<button type="button" data-act="code" data-id="${r.id}">Code</button>` : ""}<button type="button" data-act="del" data-id="${r.id}">Delete</button></td></tr>`)
      .join("")}</tbody></table></div>`;
    return;
  }
  // Overall: each flight program's best flight per route and wind.
  const groups = new Map();
  for (const r of runs) {
    const key = `${r.program.id}|${r.program.name}|${r.program.codeHash || ""}`;
    if (!groups.has(key)) groups.set(key, { program: r.program, imported: r.imported, best: new Map() });
    const gr = groups.get(key);
    const slot = `${r.route}|${r.seed}`;
    if (!gr.best.has(slot) || compareRuns(r, gr.best.get(slot)) < 0) gr.best.set(slot, r);
  }
  const rows = [...groups.values()].map((g) => {
    const b = [...g.best.values()];
    const reached = b.filter((r) => r.result.outcome === "reached");
    return { ...g, tried: b.length, reached: reached.length, meanTime: reached.length ? reached.reduce((s, r) => s + r.result.time, 0) / reached.length : Infinity, contacts: b.reduce((s, r) => s + r.result.contacts, 0) };
  }).sort((a, b) => b.reached - a.reached || a.meanTime - b.meanTime || a.contacts - b.contacts);
  if (!rows.length) { el.innerHTML = '<p class="hint">No saved flights yet.</p>'; return; }
  el.innerHTML = `<div class="tablewrap"><table><thead><tr><th>#</th><th>Flight program</th><th>Reached</th><th>Mean time when reached</th><th>Wall contacts</th></tr></thead><tbody>${rows
    .map((g, i) => `<tr><td class="num">${i + 1}</td><td>${esc(g.program.name)}<br>${badge(g.program.kind, g.imported)}</td><td class="num">${g.reached} of ${g.tried} route and wind pairs</td><td class="num">${Number.isFinite(g.meanTime) ? g.meanTime.toFixed(1) + " s" : "none reached"}</td><td class="num">${g.contacts}</td></tr>`)
    .join("")}</tbody></table></div><p class="hint">Counts each program's best flight on each route and wind it has flown, so programs flown on different routes are not directly comparable.</p>`;
}

function onBoardClick(e) {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const rec = runs.find((r) => r.id === b.dataset.id);
  if (!rec) return;
  const act = b.dataset.act;
  if (act === "view") { pause(); $("demo-note").textContent = ""; show(rec); }
  else if (act === "ghost") {
    if (!current || current.rec.id === rec.id) { $("board-status").textContent = "Open a different flight on this route first, then add this one as its ghost."; return; }
    $("ghost").value = rec.id;
    onGhostChange();
    $("cmp-h").scrollIntoView({ block: "start", behavior: $("animate").checked ? "smooth" : "auto" });
  } else if (act === "export") download(`flight-${rec.route}-${rec.program.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`, rec);
  else if (act === "code") {
    $("code").value = rec.program.code;
    $("custom-name").value = rec.program.name;
    document.querySelector('input[name="program"][value="custom"]').checked = true;
    $("editor").hidden = false;
    $("board-status").textContent = "Loaded that flight's code into the editor. It runs only when you press Fly.";
  } else if (act === "del") {
    runs = runs.filter((r) => r.id !== rec.id);
    saveRuns();
    if (current?.rec.id === rec.id) { current = null; $("result").innerHTML = ""; setT(0); }
    refreshLists();
    render();
  }
}

// ---------- export / import ----------
function download(name, obj) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Imported flights are re-flown from their commands; the stored result is
// never trusted. Code that comes with a flight is kept but never run unless
// the visitor loads it into the editor and presses Fly.
async function onImport(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  const out = $("board-status");
  if (file.size > 5_000_000) { out.textContent = "That file is larger than 5 MB; flights are small, so it is probably not an export from this page."; return; }
  let data;
  try { data = JSON.parse(await file.text()); } catch { out.textContent = "That file is not JSON."; return; }
  const list = data?.format === "spatial-arena-flights" ? data.flights : [data];
  let added = 0, changed = 0, skipped = 0;
  for (const r of Array.isArray(list) ? list : []) {
    const sc = r && routeOf(r.route);
    const ok = sc && sc.seeds.includes(r.seed) && ["C2", "C3"].includes(r.level) && Array.isArray(r.commands) && r.commands.length <= 100 && r.commands.every((c) => c && typeof c === "object") && r.program && typeof r.program.name === "string";
    if (!ok || runs.some((x) => x.id === r.id)) { skipped++; continue; }
    const re = replay(world, sc, r.seed, r.level, r.commands);
    if (!sameResult(re.result, r.result)) changed++;
    const kind = ["hand-written", "written by Ripple, frozen", "yours"].includes(r.program.kind) ? r.program.kind : "yours";
    runs.push({
      format: "spatial-arena-flight", v: 1, id: String(r.id || newId()).slice(0, 40), savedAt: String(r.savedAt || new Date().toISOString()).slice(0, 30),
      route: sc.id, seed: r.seed, level: r.level, imported: true,
      program: { id: String(r.program.id || "custom").slice(0, 20), name: r.program.name.slice(0, 40), kind, ...(typeof r.program.code === "string" ? { code: r.program.code.slice(0, 100_000), codeHash: fingerprint(r.program.code.slice(0, 100_000)) } : {}) },
      commands: J(re.steps.map((s) => s.command)),
      notes: Array.isArray(r.notes) ? r.notes.slice(0, 100).map((n) => ({ reply: n?.reply ?? null, say: String(n?.say ?? "").slice(0, 80), error: n?.error ? String(n.error).slice(0, 200) : null })) : [],
      result: re.result,
    });
    added++;
  }
  saveRuns();
  refreshLists();
  out.textContent = `Imported ${added} flight${added === 1 ? "" : "s"}, each re-flown from its commands.${changed ? ` ${changed} came out differently from the result in the file; the re-flown result is the one kept.` : ""}${skipped ? ` Skipped ${skipped} (unknown route or wind, malformed, or already saved).` : ""}`;
}

// ---------- browser check ----------
// Flies the fixture through this page's own code path (Web Worker for
// programs) and compares with what Node produced.
const CHECK_KEY = "spatial-arena.browser-check.v1";
// Flies the 22 reference flights through this page's own code path (the Web
// Worker for programs) and compares them with what Node produced. Runs once
// per browser by itself, shortly after the first flight; the result is shown
// under the map, in plain words, and kept so later visits do not repeat it.
async function browserCheck(force) {
  const out = $("check");
  const btn = $("selfcheck");
  if (!force) {
    try {
      const saved = JSON.parse(localStorage.getItem(CHECK_KEY) || "null");
      if (saved && saved.ua === navigator.userAgent && saved.fixture === FIXTURE_ID) return renderCheck(saved);
    } catch {}
  }
  btn.disabled = true;
  out.className = "check-line";
  out.textContent = "Checking that this browser flies exactly like the benchmark...";
  try {
    fixture ??= await fetch(new URL("fixtures/determinism.json", import.meta.url)).then((r) => r.json());
    const all = [...fixture.cases, ...(fixture.published ?? [])];
    let same = 0;
    const diffs = [];
    const t0 = performance.now();
    for (const c of all) {
      await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
      const sc = routes.find((r) => r.id === c.route) ?? (await heldoutRoute(c.route));
      let controller, dispose = () => {};
      if (BUILTIN[c.controller]) controller = BUILTIN[c.controller].make(world, sc);
      else {
        const w = await workerProgramController(c.controller === "jitter" ? fixture.jitterProgram : rippleCode, c.seed, WORKER_URL);
        controller = w.controller;
        dispose = w.dispose;
      }
      const run = await fly(world, sc, c.seed, c.level, controller);
      dispose();
      const ok = sameResult(run.result, c.result) && JSON.stringify(J(run.steps.map((s) => s.command))) === JSON.stringify(c.commands) && fingerprint(run.frames) === c.frames;
      if (ok) same++;
      else diffs.push(`${c.controller} on ${c.route}`);
    }
    const res = { ua: navigator.userAgent, fixture: FIXTURE_ID, same, total: all.length, diffs, ms: Math.round(performance.now() - t0) };
    try { localStorage.setItem(CHECK_KEY, JSON.stringify(res)); } catch {}
    renderCheck(res);
  } catch (e) {
    out.className = "check-line warn";
    out.textContent = `The browser check could not run (${e.message || e}). Flights still work; whether they match the benchmark exactly in this browser is unknown.`;
  } finally {
    btn.disabled = false;
  }
}

const FIXTURE_ID = "2026-11-19"; // bump when arena/fixtures/determinism.json is regenerated

function renderCheck(res) {
  const out = $("check");
  window.__arena.selfCheck = res;
  $("check-banner").hidden = true;
  if (res.same === res.total) {
    out.className = "check-line good";
    out.textContent = `This browser flies exactly like the benchmark: ${res.same} of ${res.total} reference flights came out identical to the published Node results, command for command.`;
  } else {
    out.className = "check-line warn";
    out.textContent = `This browser computes ${res.total - res.same} of the ${res.total} reference flights differently from the benchmark. The rules and flight programs are the same, but this browser's floating-point maths differs in the last digits, so times and scores here can differ from the published results and from the same flight in another browser.`;
    $("check-banner").hidden = false;
  }
}

let heldout = null;
async function heldoutRoute(id) {
  heldout ??= (await fetch(new URL(SCENARIO_PATH, ROOT)).then((r) => r.json())).heldout;
  return heldout.find((r) => r.id === id);
}

start().catch((e) => { $("status").innerHTML = `<span class="bad">The arena failed to load: ${esc(e.message || e)}</span>`; });
