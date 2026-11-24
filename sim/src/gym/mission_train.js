// Training-set evaluation and the feedback text for the mission coding loop
// (sim/tools/mission_cap.mjs), shared with the replay check
// (sim/tools/mission_replay_check.mjs) so both run exactly the same code.
//
// Options whose defaults here reproduce the v4 recordings exactly:
//   random "legacy"  a program's Math.random uses the wind's seed (v4, v5 pilot);
//                    "separate" gives it its own seed (programRandomSeed).
//   select "legacy"  feedback text as in v4; "earned" adds, for search, the
//                    ground the drone's own detector looked at (the measure
//                    selection now breaks ties on; see mission_select.js).
// mission_cap.mjs passes separate / earned for new runs.
import { v } from "../world.js";
import { runEpisode } from "./core.js";
import { RescueMission } from "./rescue_tasks.js";
import { compilePolicy, programController, programRandomSeed } from "./policy_sandbox.js";
import { sensedCoverage, checkSelectMode } from "./mission_select.js";

const r1 = (p) => p.map((x) => Math.round(x * 10) / 10);

// A model-written controller for any mission kind. Every kind except
// package-drop goes through programController unchanged; package-drop also
// passes an explicit { release: true } through to the mission.
export function missionProgram(code, { seed, randomSeed = seed, kind }) {
  if (kind !== "package-drop") return programController(code, { seed, randomSeed });
  const p = compilePolicy(code, { seed, randomSeed });
  if (p.error) return async () => ({ command: { velocity: [0, 0, 0] }, error: p.error, say: "" });
  p.newMemory();
  return async (obs) => {
    try {
      const out = p.call(obs);
      const vel = out?.velocity;
      if (!Array.isArray(vel) || vel.length !== 3 || !vel.every((x) => Number.isFinite(Number(x)))) throw new Error(`policy returned ${JSON.stringify(out)?.slice(0, 120)} (expected { velocity: [vx, vy, vz] })`);
      return { command: { velocity: vel.map(Number), ...(out.release === true ? { release: true } : {}) }, say: typeof out.say === "string" ? out.say.slice(0, 80) : "" };
    } catch (err) {
      return { command: { velocity: [0, 0, 0] }, error: String(err.message || err).slice(0, 200), say: "" };
    }
  };
}

export function makeTrainer({ world: W, task, dt: DT = 1, sensors: SENSORS = "basic", feedback: FEEDBACK = "basic", trainSeeds: TRAIN_SEEDS = 1, random = "legacy", select = "legacy" }) {
  checkSelectMode(select);
  const SUCCESS = task === "search" ? "found" : "delivered";
  const EARNED_SEARCH = select === "earned" && task === "search";

  // Progress (analysis, and legacy selection; the model sees it only as a
  // number): 1 - closest approach / launch distance, to the hiker or the hover
  // point. For package-drop the goal is the pad itself.
  const goalOf = (m) => (task === "search" ? m.targetPosition : m.kind === "package-drop" ? m.targetPosition : v.add(m.targetPosition, [0, m.releaseHeight, 0]));

  async function evaluate(code, missions) {
    const compiled = compilePolicy(code);
    if (compiled.error) return { compileError: compiled.error, eps: [], success: 0, progress: 0, coverage: 0 };
    const eps = [];
    for (const m of missions) for (const seed of m.seeds.slice(0, TRAIN_SEEDS)) {
      const inner = missionProgram(code, { seed, randomSeed: programRandomSeed(seed, random), kind: m.kind });
      const ctl = async (obs) => ({ ...(await inner(obs)), obsSnap: obs });
      const ep = await runEpisode(new RescueMission(W, m, seed, { sensors: SENSORS }), ctl, { dt: DT });
      const g = goalOf(m), d0 = v.dist(m.start, g);
      const closest = Math.min(...ep.frames.map((f) => v.dist([f[1], f[2], f[3]], g)));
      const coverage = task === "search" ? sensedCoverage(W, ep.frames, m.detectionRange, { area: m.searchArea }) : null;
      eps.push({ m, ep, progress: Math.max(0, 1 - closest / d0), coverage });
    }
    const minutes = eps.reduce((a, e) => a + e.ep.result.time / 60, 0);
    return {
      eps,
      success: eps.filter((e) => e.ep.result.outcome === SUCCESS).length,
      progress: eps.reduce((a, e) => a + e.progress, 0) / eps.length,
      coverage: task === "search" ? eps.reduce((a, e) => a + e.coverage, 0) / eps.length : null,
      contactsPerMin: eps.reduce((a, e) => a + e.ep.result.contacts, 0) / Math.max(minutes, 1e-9),
      errors: eps.reduce((a, e) => a + e.ep.decisions.filter((d) => d.error).length, 0),
    };
  }

  // What the model gets back. Search feedback never reveals where the hiker
  // was: only whether it was found, when, and the drone's own sensor readings
  // (and, under earned selection, how much ground its own detector covered).
  function report(res) {
    if (res.compileError) return `The program failed to load: ${res.compileError}`;
    const lines = res.eps.map((e, i) => {
      const r = e.ep.result;
      const where = task === "search" ? `from ${JSON.stringify(r1(e.m.start))}` : `from ${JSON.stringify(r1(e.m.start))} to the pad at ${JSON.stringify(r1(e.m.targetPosition))}`;
      const verdict = r.outcome === SUCCESS
        ? `${SUCCESS.toUpperCase()} in ${r.time} s`
        : task === "search"
          ? `not found in time`
          : dropVerdict(r) ?? (r.outcome === "misdelivered" ? `parcel released but landed outside the pad` : r.outcome === "payload_collision" ? `parcel hit something on release` : `not delivered (longest stable hold ${r.continuousHoldSeconds} s)`);
      const cov = EARNED_SEARCH ? `, your detector looked at ${e.coverage} m2 of ground${e.m.searchArea ? " inside the search area" : ""}` : "";
      return `${i + 1}. ${where}: ${verdict}, ${r.contacts} contacts, touching geometry ${Math.round(r.touchFraction * 100)}% of the time, flew ${Math.round(r.pathLength)} m${cov}`;
    });
    const details = [];
    let sketches = 0;
    for (const [i, e] of res.eps.entries()) {
      if (e.ep.result.outcome === SUCCESS) continue;
      const D = e.ep.decisions;
      const per = Math.max(1, Math.round(5 / DT));
      let stuck = null;
      for (let k = per; k < D.length && !stuck; k++) if (v.dist(D[k - per].obsSnap.position, D[k].obsSnap.position) < 1) stuck = D[k];
      const err = D.find((d) => d.error);
      const parts = [];
      if (stuck) {
        const o = stuck.obsSnap;
        parts.push(`stuck from about t=${stuck.t}s at ${JSON.stringify(o.position)}; sensors there: ${JSON.stringify({ free_space_m: o.free_space_m, velocity: o.velocity, ...(o.goal ? { goal: o.goal } : {}), ...(o.delivery ? { continuous_hold_s: o.delivery.continuous_hold_s } : {}) })}; your program returned ${JSON.stringify(stuck.command)}`);
      }
      if (err) parts.push(`runtime error at t=${err.t}s: ${err.error}`);
      if (FEEDBACK === "rich" && sketches < 3) { parts.push(`\n${sketch(e)}`); sketches++; }
      if (parts.length && details.length < 6) details.push(`Flight ${i + 1}: ${parts.join("; ")}`);
    }
    const covAll = EARNED_SEARCH ? ` Your detector looked at ${Math.round(res.coverage)} m2 of ground per flight on average; versions are compared on hikers found, then on that area.` : "";
    return `${lines.join("\n")}\n\nOverall: ${SUCCESS} ${res.success}/${res.eps.length}, ${res.contactsPerMin.toFixed(1)} contacts per minute, ${res.errors} runtime errors.${covAll}${details.length ? `\n\nDetails on failed flights:\n${details.join("\n")}` : ""}`;
  }

  return { evaluate, report, SUCCESS };
}

function dropVerdict(r) {
  if (!r.drop) return null;
  const d = r.drop;
  if (!d.released) return `parcel never released`;
  if (r.outcome === "released_too_high") return `parcel released ${d.releaseHeight} m above the pad (limit ${d.maxReleaseHeight} m)`;
  if (r.outcome === "missed_pad") return `parcel landed ${d.landingError} m from the pad centre (pad radius ${d.padRadius} m)`;
  if (r.outcome === "payload_collision") return `parcel hit something after release`;
  return null;
}

// Top-down sketch of the drone's OWN path (no map, no target): 2.5 m cells
// relative to the launch point, north up. S launch, E end, o visited, x where
// a contact began. Plus coverage counts. Built only from the recorded track.
function sketch(e) {
  const f = e.ep.frames, c = 2.5, s0 = f[0];
  const cell = (p) => [Math.floor((p[1] - s0[1]) / c), Math.floor((p[3] - s0[3]) / c)];
  const pts = f.map(cell), cs = e.ep.result.contacts;
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  if (x1 - x0 > 60 || z1 - z0 > 40) return `(path spans ${((x1 - x0 + 1) * c).toFixed(0)} x ${((z1 - z0 + 1) * c).toFixed(0)} m; sketch omitted)`;
  const grid = Array.from({ length: z1 - z0 + 1 }, () => Array(x1 - x0 + 1).fill(" "));
  for (const [x, z] of pts) grid[z - z0][x - x0] = "o";
  const contactsAt = [];
  let prev = 0;
  for (const d of e.ep.decisions) { const k = d.obsSnap?.wall_contacts_so_far ?? 0; if (k > prev) contactsAt.push(d.obsSnap.position); prev = k; }
  for (const p of contactsAt) { const x = Math.floor((p[0] - s0[1]) / c), z = Math.floor((p[2] - s0[3]) / c); if (grid[z - z0]?.[x - x0] !== undefined) grid[z - z0][x - x0] = "x"; }
  const [ex, ez] = pts.at(-1), [sx, sz] = pts[0];
  grid[ez - z0][ex - x0] = "E"; grid[sz - z0][sx - x0] = "S";
  const visited = new Set(pts.map((p) => p.join(","))).size;
  const ys = f.map((p) => p[2]);
  return `  Own path, top-down, north up, 2.5 m cells (S launch, E end, o visited, x contact began); ${visited} cells visited, height range ${Math.min(...ys).toFixed(1)} to ${Math.max(...ys).toFixed(1)} m, ${cs} contacts:\n${grid.slice().reverse().map((r) => "  |" + r.join("")).join("\n")}`;
}
