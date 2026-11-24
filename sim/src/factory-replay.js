// Replays recorded Ripple episodes inside the factory scan. The recording
// stores decisions, not motion: every flight is re-simulated here with the
// same deterministic engine and the map built from the scan's collider, so
// positions are in factory.html's world coordinates.
//
// The scan is the "transfer to a real space" shot, so it shows the best
// recorded flights (a held-out decision that got the drone through on most
// seeds, flying the seed with the clearest dodge), labelled as selected
// examples. Every number shown comes from the recording; the arena page and
// findings have the full results, failures included.
import { World, shortRouteLabel as routeLabel } from "./world.js";
import { runEpisode } from "./scenarios.js";
import { showcaseSeed, episodeScore } from "./showcase.js";
import { createCutawayCamera } from "./factory-camera.js";

const OUTCOME = { reached: [0.2, 0.83, 0.6], intercepted: [0.96, 0.25, 0.37], crashed: [0.96, 0.62, 0.04], timeout: [0.58, 0.64, 0.72] };
const OUTCOME_TEXT = { reached: "Reached the goal", intercepted: "Caught by the bird", crashed: "Crashed into a wall", timeout: "Ran out of time" };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const css = (c) => `rgb(${c.map((x) => Math.round(x * 255)).join(",")})`;

const SPEED = 1.25; // playback speed of the flight itself
const INTRO = 2.4; // seconds of overview before the camera picks up the drone
const HOLD = 6; // seconds the end card stays before the next flight
const SPEEDS = [0.5, 1, 2]; // presenter playback factors (panel, keys)
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---- the chase camera as a smooth function of flight time ----
// Built once per flight (and roof cut) on a 120 Hz grid, then sampled, so the
// live view and capture renders run the same math and a time always gives
// the same pose. Drone path: cubic Hermite (Catmull-Rom) through the
// recorded frames. Position, heading, eye and look target each pass through
// a critically damped filter run forward and then backward (zero phase), so
// the camera is smooth without trailing the drone. The heading holds while
// the drone is slow, and the eye rises and closes in, smoothly and ahead of
// time, wherever a wall below the roof cut would hide the drone.
export const CHASE = {
  hz: 120,
  back: 3.4, // m behind the drone
  up: 2.5, // m above it, and at least clearRoof above the roof cut
  clearRoof: 1.1,
  ahead: 1.6, // look this far ahead of the drone
  tPos: 0.18, tYaw: 0.3, tEye: 0.35, tLook: 0.2, // filter time constants (s), per pass
  yawFollow: 0.25, // s; how fast the held heading turns toward the motion
  slow: [0.15, 0.6], // m/s; below the first the heading holds, above the second it follows
};
// ?chaseback=6&chaseup=4&chaseahead=2: a wider chase (renders that need the bird in frame).
{
  const qs = new URLSearchParams(globalThis.location?.search || "");
  for (const [k, key] of [["chaseback", "back"], ["chaseup", "up"], ["chaseahead", "ahead"]]) if (qs.get(k)) CHASE[key] = Number(qs.get(k));
}
const southWallZ = (x) => 11.8 - 0.035 * x;

function hermite(frames, key) {
  const n = frames.length;
  const P = (i) => frames[clamp(i, 0, n - 1)][key];
  const T = (i) => frames[clamp(i, 0, n - 1)].t;
  const tangent = (i) => {
    const dt = T(i + 1) - T(i - 1);
    return dt > 1e-9 ? P(i + 1).map((x, j) => (x - P(i - 1)[j]) / dt) : [0, 0, 0];
  };
  let i = 0;
  return (t) => {
    t = clamp(t, frames[0].t, frames[n - 1].t);
    if (i > n - 2 || frames[i].t > t) i = 0;
    while (i < n - 2 && frames[i + 1].t < t) i++;
    const h = Math.max(1e-9, T(i + 1) - T(i));
    const u = clamp((t - T(i)) / h, 0, 1);
    const a = P(i), b = P(i + 1), ma = tangent(i), mb = tangent(i + 1);
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    const d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
    return {
      p: a.map((x, j) => h00 * x + h10 * h * ma[j] + h01 * b[j] + h11 * h * mb[j]),
      v: a.map((x, j) => (d00 * x + d10 * h * ma[j] + d01 * b[j] + d11 * h * mb[j]) / h),
    };
  };
}

// Critically damped (two equal first-order stages), forward then backward.
function zeroPhase(series, T, dt) {
  const a = 1 - Math.exp(-dt / T);
  const pass = (src) => {
    const out = new Array(src.length);
    let s1 = src[0].slice(), s2 = src[0].slice();
    for (let i = 0; i < src.length; i++) {
      for (let j = 0; j < s1.length; j++) {
        s1[j] += (src[i][j] - s1[j]) * a;
        s2[j] += (s1[j] - s2[j]) * a;
      }
      out[i] = s2.slice();
    }
    return out;
  };
  return pass(pass(series).reverse()).reverse();
}

// Does a wall below the cut hide the drone (p) from the eye (e)?
function hidden(grid, roof, p, e) {
  if (!grid) return false;
  const { origin: o, cell: c, dims: [nx, ny, nz], occ } = grid;
  const L = Math.hypot(e[0] - p[0], e[1] - p[1], e[2] - p[2]);
  for (let s = 0.45; s < L; s += c * 0.5) {
    const k = s / L;
    const x = p[0] + (e[0] - p[0]) * k, y = p[1] + (e[1] - p[1]) * k, z = p[2] + (e[2] - p[2]) * k;
    if (y > roof || z > southWallZ(x)) continue; // cut away in the scan
    const ix = Math.floor((x - o[0]) / c), iy = Math.floor((y - o[1]) / c), iz = Math.floor((z - o[2]) / c);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
    if (occ[ix + nx * (iy + ny * iz)]) return true;
  }
  return false;
}

export function buildChaseTrack(frames, { roof = 2.3, grid = null, goal = null } = {}) {
  const C = CHASE;
  const dt = 1 / C.hz;
  const end = frames[frames.length - 1].t;
  const n = Math.max(2, Math.ceil(end * C.hz) + 1);
  const path = hermite(frames, "d");
  const D = [], V = [];
  for (let i = 0; i < n; i++) {
    const s = path(Math.min(i * dt, end));
    D.push(s.p);
    V.push(s.v);
  }
  const P = zeroPhase(D, C.tPos, dt);
  // Heading: yaw tracks the smoothed velocity, weighted by speed, so it holds
  // while the drone hovers or reverses; it starts on the first real motion.
  const Vs = zeroPhase(V, C.tYaw, dt);
  const speed = Vs.map((v) => Math.hypot(v[0], v[2]));
  let first = Vs.findIndex((v, i) => speed[i] > C.slow[1]);
  let yaw;
  if (first >= 0) yaw = Math.atan2(Vs[first][0], Vs[first][2]);
  else if (goal) yaw = Math.atan2(goal[0] - D[0][0], goal[2] - D[0][2]);
  else yaw = 0;
  const yaws = [];
  for (let i = 0; i < n; i++) {
    const w = clamp((speed[i] - C.slow[0]) / (C.slow[1] - C.slow[0]), 0, 1);
    if (w > 0) {
      const target = Math.atan2(Vs[i][0], Vs[i][2]);
      let d = target - yaw;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      yaw += d * (1 - Math.exp((-dt * w) / C.yawFollow));
    }
    yaws.push([yaw]);
  }
  const Y = zeroPhase(yaws, C.tYaw, dt).map((y) => y[0]);
  // Desired eye: behind and above; steeper and closer where a wall would
  // hide the drone. Look target ahead of it.
  const steps = [[1, 0], [0.78, 0.5], [0.58, 1.0], [0.4, 1.5], [0.24, 2.0], [0.12, 2.5]];
  const E = [], Lk = [];
  for (let i = 0; i < n; i++) {
    const p = P[i], hx = Math.sin(Y[i]), hz = Math.cos(Y[i]);
    const base = Math.max(p[1] + C.up, roof + C.clearRoof);
    // Under a ceiling below the cut nothing above it can see the drone:
    // then keep the usual pose rather than dive for nothing.
    const pose = ([k, lift]) => [p[0] - hx * C.back * k, base + lift, p[2] - hz * C.back * k];
    E.push(pose(steps.find((st) => !hidden(grid, roof, p, pose(st))) || steps[0]));
    Lk.push([p[0] + hx * C.ahead, p[1] - 0.25, p[2] + hz * C.ahead]);
  }
  const eyes = zeroPhase(E, C.tEye, dt);
  const looks = zeroPhase(Lk, C.tLook, dt);
  // Sample between grid points with the same Hermite scheme.
  const grid120 = (arr) => hermite(arr.map((p, i) => ({ t: Math.min(i * dt, end), p })), "p");
  const eyeAt = grid120(eyes), lookAt = grid120(looks);
  return { end, at: (t) => ({ eye: eyeAt(t).p, look: lookAt(t).p }) };
}

// The after-feedback condition (the learned policy) when the recording has
// one, else whatever the recording evaluated.
function afterKey(rec) {
  const keys = rec.evaluation.conditions.map((c) => c.key);
  const h = rec.defenderHarness || "raw";
  const pair = [rec.demoPairKeys, ["original", "strategy"], [h, h === "raw" ? "feedback" : `${h}_feedback`], ["raw", "feedback"]].find(
    (p) => p && keys.includes(p[0]) && keys.includes(p[1]),
  );
  return pair ? pair[1] : keys.find((k) => k !== "shortest");
}

// Up to three of the best recorded flights: held-out decisions that reached
// the goal on at least 3 of 4 seeds, the learned policy's first.
// ?picks=N (capture/grid use) asks for up to N; past the third, 2 of 4 seeds is enough.
const MAX_PICKS = Math.max(1, Number(new URLSearchParams(globalThis.location?.search || "").get("picks")) || 3);
function pickFlights(rec) {
  const ev = rec.evaluation;
  if (!ev) return [];
  const aKey = afterKey(rec);
  const ranked = ev.episodes
    .filter((e) => e.condition !== "shortest" && !e.defender.invalid)
    .map((e) => ({ ep: e, score: episodeScore(e) + (e.condition === aKey ? 0.5 : 0) }))
    .sort((a, b) => b.score - a.score);
  const seen = new Set();
  const out = [];
  for (const { ep } of ranked) {
    if (seen.has(ep.scenario.id)) continue; // one flight per scenario
    if (out.length && ep.summary.reached < (out.length < 3 ? 3 : 2)) break;
    seen.add(ep.scenario.id);
    out.push({ ep, seed: showcaseSeed(ep.results), label: ev.conditions.find((c) => c.key === ep.condition)?.label || ep.condition });
    if (out.length === MAX_PICKS) break;
  }
  return out;
}

export async function startReplay(ctx, url) {
  const { pc, app, actors, setScripted, selectCamera } = ctx;
  const params = new URLSearchParams(location.search);
  // ?capture=1: time only moves through factoryCapture.seek(), so a renderer
  // can step frame by frame and get the same pixels for the same time.
  const capture = !!params.get("capture");
  const rec = url === "parent" ? window.parent?.scanSession?.() : await (await fetch(url)).json();
  if (!rec) throw new Error("the arena has no evaluated session to replay yet");
  const mapFile = rec.mapFile || "maps/building.json";
  if (!mapFile.includes("factory")) throw new Error(`${url} was flown on ${mapFile}, not the factory`);
  const world = new World(await (await fetch(mapFile)).json());
  const picks = pickFlights(rec);
  if (!picks.length) throw new Error("recording has no held-out flights to replay");
  const who = rec.usingModel ? "Ripple" : "The offline stand-in (not Ripple)";

  // Re-simulate every pick; outcomes must match the recording.
  const flights = picks.map((p) => {
    const out = runEpisode(world, p.ep.scenario, p.ep.defender.policy);
    const same = out.results.map((r) => r.outcome + r.time).join() === p.ep.results.map((r) => r.outcome + r.time).join();
    return { ...p, frames: out.frames[p.seed], result: out.results[p.seed], same };
  });
  const reproduced = flights.every((f) => f.same);

  setScripted(false);
  // The scripted chase only knows the north-hall loop; the replay brings its
  // own (placeChase below).
  document.getElementById("chase").disabled = false;
  const [drone, bird] = actors;
  // ?shot=bird|drone|angled|top picks the camera. "drone" (the default)
  // opens each flight on the overview, then eases in behind the drone.
  const shotParam = params.get("shot") || "drone";
  let autoCamera = shotParam === "drone" && !capture;
  selectCamera(autoCamera ? "angled" : ["bird", "angled", "top", "track", "chase"].includes(shotParam) ? shotParam : shotParam === "drone" && capture ? "drone" : "angled");
  // Once the presenter picks a shot, stop moving the camera for them.
  const userPicked = () => (autoCamera = false);
  document.querySelectorAll("[data-shot]").forEach((b) => b.addEventListener("click", userPicked));
  addEventListener("keydown", (e) => {
    if ("otbd".includes(e.key?.toLowerCase())) userPicked();
  });

  // ---- overlay UI ----
  const main = document.querySelector("main");
  const card = document.createElement("div");
  card.className = "replay-card";
  main.appendChild(card);
  const end = document.createElement("div");
  end.className = "replay-end";
  end.hidden = true;
  main.appendChild(end);
  const controls = document.createElement("div");
  controls.className = "replay-controls";
  controls.innerHTML = `<button data-act="replay" title="Fly this flight again (R)">↻ Replay</button><button data-act="next" title="Next recorded flight (N)">Next flight ›</button>`;
  const bar = document.querySelector(".factory-bar");
  bar.prepend(controls);
  controls.querySelector('[data-act="next"]').hidden = flights.length < 2;
  document.querySelector(".factory-header p").textContent = `Replay · ${flights.length} recorded flight${flights.length > 1 ? "s" : ""}`;

  function describe(f) {
    const p = f.ep.defender.policy;
    const s = f.ep.scenario;
    card.innerHTML = `<div class="tag ${rec.usingModel ? "" : "offline"}">${rec.usingModel ? "Recorded Ripple decision" : "Offline stand-in, not Ripple"} · re-simulated ${reproduced ? "exactly" : "— MISMATCH"}</div>
      <div class="title">Unseen scenario ${esc(s.id)}${flights.length > 1 ? ` <span>· flight ${flights.indexOf(f) + 1} of ${flights.length}</span>` : ""}</div>
      <div class="line">${who} watched the bird for 2 s, read it as <b>${esc(p.bird_behavior_guess)}</b>, and flies route ${esc(p.route_id)} at ${p.cruise_speed} m/s.</div>
      <div class="live">&nbsp;</div>`;
  }
  function showEnd(f) {
    const r = f.result;
    const s = f.ep.scenario;
    const p = f.ep.defender.policy;
    const read = p.bird_behavior_guess === s.bird.strategy;
    end.innerHTML = `<div class="outcome" style="color:${css(OUTCOME[r.outcome] || OUTCOME.timeout)}">${OUTCOME_TEXT[r.outcome] || r.outcome}</div>
      <div class="facts"><span><b>${f.ep.summary.reached}/${f.ep.summary.trials}</b> seeds of this decision got through</span>
      <span>closest the bird came: <b>${r.minSeparation.toFixed(1)} m</b></span>
      <span>the bird was really <b>${esc(s.bird.strategy)}</b>${read ? " (read correctly)" : ""}</span></div>
      <div class="note">Selected example: one of the best recorded flights. All results, failures included, are on the Findings tab.</div>`;
    end.hidden = false;
  }

  const trailsBox = document.getElementById("trails");

  // ---- drawing ----
  // Draw on the last layer so the Gaussian splats can't cover the lines.
  const overlay = app.scene.layers.getLayerByName("UI") || app.scene.layers.getLayerByName("Immediate");
  // drawLine is 1 px wide; a 3×3 bundle of offset copies reads as a thick
  // line on a projector.
  const THICK = [];
  for (const dx of [-0.05, 0, 0.05]) for (const dz of [-0.05, 0, 0.05]) THICK.push([dx, Math.abs(dx + dz) > 0.06 ? 0.03 : 0, dz]);
  const THIN = [[0, 0, 0], [0.04, 0, 0], [0, 0, 0.04]];
  const line = (a, b, color, offs = THICK) => {
    for (const [x, y, z] of offs) app.drawLine(new pc.Vec3(a.x + x, a.y + y, a.z + z), new pc.Vec3(b.x + x, b.y + y, b.z + z), color, false, overlay);
  };
  const v3 = (p) => new pc.Vec3(p[0], p[1], p[2]);
  const col = (c, a = 1) => new pc.Color(c[0], c[1], c[2], a);
  const ring = (c, r, color, offs = THIN, n = 28) => {
    let last = null;
    for (let s = 0; s <= n; s++) {
      const a = (s / n) * Math.PI * 2;
      const p = new pc.Vec3(c[0] + r * Math.cos(a), c[1], c[2] + r * Math.sin(a));
      if (last) line(last, p, color, offs);
      last = p;
    }
  };
  const state = (frames, t) => {
    let i = 0;
    while (i < frames.length - 2 && frames[i + 1].t < t) i++;
    const a = frames[i];
    const b = frames[Math.min(i + 1, frames.length - 1)];
    const k = Math.max(0, Math.min(1, (t - a.t) / Math.max(1e-6, b.t - a.t)));
    const L = (p, q) => p.map((x, j) => x + (q[j] - x) * k);
    return { d: L(a.d, b.d), b: L(a.b, b.b), dv: a.dv, i };
  };
  const node = (id) => world.nodes[id];
  const CYAN = [0.49, 0.83, 0.99];
  const GREEN = [0.2, 0.83, 0.6];
  const RED = [0.96, 0.3, 0.35];

  function drawScene(f, st, tSec, done) {
    const s = f.ep.scenario;
    const pulse = 0.5 + 0.5 * Math.sin(tSec * 4);
    // Start and goal: rings on the floor plane of each waypoint, the goal
    // with a beacon post.
    const a = node(s.start);
    const g = node(s.goal);
    if (a) ring(a, 0.8, col(GREEN, 0.8));
    if (g) {
      ring(g, 1.0 + 0.15 * pulse, col(GREEN));
      line(v3([g[0], g[1] - 1, g[2]]), v3([g[0], g[1] + 2.2, g[2]]), col(GREEN, 0.9));
    }
    // The route Ripple chose, faint, ahead of the drone.
    const route = f.ep.defender.policy.route || [];
    let last = null;
    for (const id of route) {
      const p = node(id);
      if (!p) continue;
      const q = v3(p);
      if (last) line(last, q, col(CYAN, 0.35), THIN);
      last = q;
    }
    // Trails: the drone's in the outcome color once it lands, the bird's red.
    const trail = done ? col(OUTCOME[f.result.outcome] || OUTCOME.timeout) : col(CYAN);
    const trails = trailsBox?.checked !== false;
    last = null;
    for (let j = 0; trails && j <= st.i; j += 2) {
      const p = v3(f.frames[j].d);
      if (last) line(last, p, trail);
      last = p;
    }
    last = null;
    for (let j = 0; trails && j <= st.i; j += 3) {
      const p = v3(f.frames[j].b);
      if (last) line(last, p, col(RED, 0.75), THIN);
      last = p;
    }
    // Halos so both actors read at any zoom.
    ring(st.d, 0.7 + 0.1 * pulse, col(CYAN), THICK);
    ring(st.b, 0.7, col(RED, 0.9), THICK);
    // A hunting bird is locked on: a pulsing ring and a dashed line to the drone.
    if (!done && f.frames[st.i].bs === "hunt") {
      ring(st.b, 0.95 + 0.25 * pulse, col(RED), THICK);
      const n = 14;
      const at = (k) => v3(st.b.map((x, j) => x + (st.d[j] - x) * k));
      for (let i = 0; i < n; i += 2) line(at(i / n), at((i + 1) / n), col(RED, 0.9), THIN);
    }
    if (done && f.result.closest) ring(f.result.closest.drone, 0.8, col(RED), THICK);
  }


  // ---- playback ----
  let idx = 0;
  let clock = 0; // seconds since this flight was put on screen
  let phase = "intro"; // intro → fly → end
  let flightT = 0;
  let endAt = 0;
  let paused = false;
  let speed = 1; // presenter factor on top of SPEED
  const duration = (i = idx) => flights[i].frames[flights[i].frames.length - 1].t;
  const playButton = document.getElementById("playback");
  function syncPlayback() {
    ctx.birdVisual.anim.speed = capture || paused ? 0 : speed;
    if (playButton) playButton.textContent = paused ? "Resume flight" : "Pause flight";
  }
  function start(i) {
    idx = ((i % flights.length) + flights.length) % flights.length;
    clock = 0;
    flightT = 0;
    phase = capture ? "fly" : "intro";
    end.hidden = true;
    describe(flights[idx]);
    if (autoCamera) selectCamera("angled");
  }
  function setPaused(on) {
    paused = !!on;
    syncPlayback();
  }
  function setSpeed(x) {
    speed = Number(x) > 0 ? Number(x) : 1;
    syncPlayback();
  }
  // Jump within the current flight; the end card comes back at the end.
  function seek(t) {
    flightT = clamp(Number(t) || 0, 0, duration());
    phase = "fly";
    clock = INTRO + flightT / SPEED;
    end.hidden = true;
    waitFor = 0;
  }
  // A shot picked by the presenter stops the automatic camera.
  function setShot(name) {
    autoCamera = false;
    selectCamera(name);
  }
  // Back to the automatic camera: overview, then in behind the drone.
  function setAuto() {
    autoCamera = !capture;
    selectCamera(phase === "fly" ? "drone" : "angled");
  }
  controls.querySelector('[data-act="replay"]').onclick = () => start(idx);
  controls.querySelector('[data-act="next"]').onclick = () => start(idx + 1);
  if (playButton) playButton.onclick = () => setPaused(!paused);
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target?.matches?.("input:not([type=range]):not([type=checkbox]), select, textarea")) return;
    if (e.key === "r" || e.key === "R") start(idx);
    if (e.key === "n" || e.key === "N") start(idx + 1);
    // Space on a focused control presses it instead.
    if (e.key === " " && !capture && !e.target?.matches?.("button, input")) {
      e.preventDefault();
      setPaused(!paused);
    }
  });

  // The replay's chase: behind and above the drone, above the roof cut
  // (buildChaseTrack). Rebuilt when the flight or the cut changes.
  const cutInput = document.getElementById("cut");
  let chaseTrack = null;
  let chaseKey = "";
  function placeChase() {
    const f = flights[idx];
    const roof = Number(cutInput?.value ?? 2.3);
    const key = `${idx}|${roof}`;
    if (key !== chaseKey) {
      chaseTrack = buildChaseTrack(f.frames, { roof, grid: world.grid, goal: node(f.ep.scenario.goal) });
      chaseKey = key;
    }
    const { eye, look } = chaseTrack.at(flightT);
    ctx.camera.setPosition(eye[0], eye[1], eye[2]);
    ctx.camera.lookAt(look[0], look[1], look[2]);
  }
  ctx.setCameraOverride?.((shot) => {
    if (shot === "chase") {
      placeChase();
      return true;
    }
    return capture; // capture: seek() placed the cutaway camera
  });

  // "Adversary · chasing" over the bird while it chases the drone.
  const huntLabel = document.createElement("div");
  huntLabel.className = "hunt-label";
  huntLabel.textContent = "Adversary · chasing";
  huntLabel.hidden = true;
  main.appendChild(huntLabel);
  const scr = new pc.Vec3();
  const toBird = new pc.Vec3();
  app.on("prerender", () => {
    const cam = ctx.camera;
    const p = bird.getPosition();
    const ahead = cam.camera.projection === pc.PROJECTION_ORTHOGRAPHIC || toBird.sub2(p, cam.getPosition()).dot(cam.forward) > 0;
    huntLabel.hidden = !(ctx.birdHunting && ahead);
    if (huntLabel.hidden) return;
    cam.camera.worldToScreen(p, scr);
    huntLabel.style.transform = `translate(${scr.x.toFixed(1)}px, ${(scr.y - 16).toFixed(1)}px) translate(-50%, -100%)`;
  });

  // Hold on the first frame until the scan has streamed in, so the flight
  // never starts over a black screen.
  const status = document.getElementById("factoryStatus");
  let waitFor = 30;
  app.on("update", (dt) => {
    const f = flights[idx];
    dt = Math.min(dt, 0.1);
    if (!capture && waitFor > 0 && !(status?.hidden)) {
      waitFor -= dt;
      const st = state(f.frames, 0);
      drone.setPosition(v3(st.d));
      bird.setPosition(v3(st.b));
      return;
    }
    waitFor = 0;
    // Pause and speed scale the replay's own clock; capture mode moves only
    // through factoryCapture.seek().
    dt = capture || paused ? 0 : dt * speed;
    clock += dt;
    if (phase === "intro" && clock >= INTRO) {
      phase = "fly";
      if (autoCamera) selectCamera("drone");
    }
    if (phase === "fly") flightT += dt * SPEED;
    const st = state(f.frames, flightT);
    drone.setPosition(v3(st.d));
    if (Math.hypot(st.dv[0], st.dv[2]) > 0.05) drone.setEulerAngles(0, (Math.atan2(st.dv[0], st.dv[2]) * 180) / Math.PI, -4);
    const prevB = f.frames[Math.max(0, st.i - 3)].b;
    bird.setPosition(v3(st.b));
    if (Math.hypot(st.b[0] - prevB[0], st.b[2] - prevB[2]) > 0.02) bird.setEulerAngles(0, (Math.atan2(st.b[0] - prevB[0], st.b[2] - prevB[2]) * 180) / Math.PI, -7);
    const wings = ctx.birdVisual.anim?.baseLayer;
    if (capture && wings) wings.activeStateCurrentTime = flightT % (wings.activeStateDuration || 0.6);
    ctx.setBirdHunting?.(phase !== "end" && f.frames[st.i].bs === "hunt");
    drawScene(f, st, capture ? flightT : clock, phase === "end");
    if (phase === "fly") {
      const sep = Math.hypot(st.d[0] - st.b[0], st.d[1] - st.b[1], st.d[2] - st.b[2]);
      const live = card.querySelector(".live");
      if (live) live.textContent = `t ${flightT.toFixed(1)} s · bird ${sep.toFixed(1)} m away`;
      if (flightT >= f.frames[f.frames.length - 1].t) {
        phase = "end";
        endAt = clock;
        if (!capture) showEnd(f);
        // Pull back to the overview: the whole flight, colored by outcome.
        if (autoCamera) selectCamera("angled");
      }
    } else if (phase === "end" && !capture && clock - endAt >= HOLD) {
      start(idx + 1);
    }
  });

  start(0);
  syncPlayback();
  // For the control panel, and for debugging in the console.
  window.factoryReplay = {
    flights, drone, bird, app, start, capture,
    get current() {
      return { idx, phase, flightT, duration: duration(), paused, speed, auto: autoCamera, shot: ctx.shot };
    },
    speeds: SPEEDS,
    duration,
    setPaused,
    setSpeed,
    seek,
    setShot,
    setAuto,
  };
  if (capture) window.factoryCapture = makeCapture();

  // ---- capture ----
  function makeCapture() {
    // The cutaway camera eases on the wall clock. For a frame, replay its
    // ease on a fixed 60 Hz virtual clock over the last 6 s of flight (the
    // ease settles in well under that), from a fresh camera each time, so
    // a time always gives the same pose.
    const canvasEl = app.graphicsDevice.canvas;
    const stubCanvas = {
      get clientWidth() { return canvasEl.clientWidth; },
      get clientHeight() { return canvasEl.clientHeight; },
      dataset: {},
      addEventListener() {},
      hasPointerCapture: () => false,
      releasePointerCapture() {},
      getBoundingClientRect: () => canvasEl.getBoundingClientRect(),
    };
    function placeCutaway(shot, t) {
      const f = flights[idx];
      const t0 = Math.max(0, t - 6);
      const steps = Math.ceil((t - t0) * 60 - 1e-9);
      const h = steps ? (t - t0) / steps : 1 / 60;
      let now = 0;
      performance.now = () => now;
      try {
        const nav = createCutawayCamera(stubCanvas, ctx.camera, () => {});
        nav.select(shot);
        for (let i = 0; i <= steps; i++) {
          const s = state(f.frames, t0 + i * h);
          nav.update(v3(s.d), v3(s.b));
          now += h * 1000;
        }
      } finally {
        delete performance.now;
      }
    }
    // The splat manager re-picks LOD only after the camera moves 1 m and
    // refreshes view-dependent color after a few degrees, so what is drawn
    // would depend on where the camera was before. Make both follow every
    // move, so a frame depends on its own pose only.
    app.scene.gsplat.lodUpdateDistance = 0;
    app.scene.gsplat.colorUpdateAngle = 0;
    // Every splat pass reports here.
    const splat = { gen: 0, ready: false, pending: 1 };
    app.systems.gsplat.on("frame:ready", (_cam, _layer, ready, pending) => {
      splat.gen++;
      splat.ready = ready;
      splat.pending = pending;
    });
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const shots = ["angled", "top", "track", "drone", "bird", "chase", "auto"];
    // "auto" is the demo's default camera: INTRO s on the overview while the
    // drone waits, then it eases in behind the drone for the flight. Capture
    // time is then video time; the flight starts at INTRO.
    let autoMode = false;
    function placeAuto(tv) {
      const f = flights[idx];
      const steps = Math.ceil(tv * 60 - 1e-9);
      const h = steps ? tv / steps : 1 / 60;
      let now = 0, switched = false;
      performance.now = () => now;
      try {
        const nav = createCutawayCamera(stubCanvas, ctx.camera, () => {});
        nav.select("angled");
        for (let i = 0; i <= steps; i++) {
          const v = i * h;
          if (!switched && v >= INTRO) { nav.select("drone"); switched = true; }
          const s = state(f.frames, Math.max(0, v - INTRO));
          nav.update(v3(s.d), v3(s.b));
          now += h * 1000;
        }
      } finally {
        delete performance.now;
      }
    }
    return {
      flights: flights.map((f, i) => ({
        index: i, scenario: f.ep.scenario.id, condition: f.ep.condition, label: f.label,
        outcome: f.result.outcome, seed: f.seed, duration: duration(i),
      })),
      duration: (i = idx) => duration(i) + (autoMode ? INTRO : 0),
      get flight() { return idx; },
      setFlight(i) {
        start(i);
        return idx;
      },
      setShot(name) {
        if (!shots.includes(name)) throw new Error(`unknown shot ${name}; one of ${shots.join(", ")}`);
        autoMode = name === "auto";
        selectCamera(autoMode ? "angled" : name);
      },
      setSplit: (x) => ctx.voxels?.setSplit(x) ?? Promise.resolve(),
      setView: (name) => ctx.voxels?.setView(name) ?? Promise.resolve(),
      // Show flight time tSec. Resolves once the frame is drawn with every
      // splat tile in view loaded and sorted (or after `budget` ms; the
      // result says whether it settled).
      async seek(tSec, { budget = 60000 } = {}) {
        const tv = Number(tSec) || 0;
        flightT = clamp(autoMode ? tv - INTRO : tv, 0, duration());
        phase = "fly";
        clock = INTRO + flightT;
        end.hidden = true;
        ctx.voxels?.setWipeTime(flightT);
        if (autoMode) { if (ctx.shot !== (tv >= INTRO ? "drone" : "angled")) selectCamera(tv >= INTRO ? "drone" : "angled"); placeAuto(tv); }
        else if (ctx.shot !== "chase") placeCutaway(ctx.shot, flightT);
        // Rebuild LOD, colors and sort order from this pose alone (the
        // flag clears itself after one frame).
        app.scene.gsplat.dirty = true;
        // LOD is re-picked on every 10th frame: let one of those see the new
        // pose before trusting "ready".
        for (let i = 0; i < 12; i++) await frame();
        const t0 = performance.now();
        let settled = false;
        let calm = 0; // consecutive ready frames
        while (performance.now() - t0 < budget) {
          const g = splat.gen;
          await frame();
          calm = splat.gen > g && splat.ready && splat.pending === 0 ? calm + 1 : 0;
          if (calm >= 3) {
            settled = true;
            break;
          }
        }
        await frame();
        await frame();
        return { t: flightT, settled, pending: splat.pending };
      },
    };
  }
}
