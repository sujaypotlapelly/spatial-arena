// Ripple roles: defender (route decision), attacker (bird scenario),
// strategy writer, and a spatial-prediction quiz. Each call goes through
// the local proxy. When no model is configured, a rule-based stand-in is
// used and every result is labelled "heuristic" so it is never mistaken
// for model output.

import { v, routeMenu, routeLabel } from "./world.js";
import { DEFENDER_FIELDS, ATTACKER_FIELDS, BIRD_BEHAVIORS, allowedBirdNodes } from "./policy.js";
import { rng, Episode } from "./engine.js";

const r1 = (x) => Math.round(x * 10) / 10;
const fmt = (p) => p.map(r1);

// ---------- harnesses ----------
// Ways of putting the same spatial problem to Ripple. All use the same
// model (ricursiveai/ripple-65b-preview); they differ in how the problem is
// presented, whether Ripple thinks first, and whether it can call tools.
const FAST_HOSTS = { order: ["PrimeIntellect", "GMICloud"], allow_fallbacks: false };
const THINK_HOSTS = { order: ["PrimeIntellect", "Together"], allow_fallbacks: false };
export const HARNESSES = {
  raw: { key: "raw", label: "A · Raw coordinates", style: "raw", provider: FAST_HOSTS },
  think: { key: "think", label: "B · Raw + thinking", style: "raw", provider: THINK_HOSTS, reasoning: { enabled: true }, max_tokens: 32768 },
  tools: { key: "tools", label: "C · Geometry tools", style: "tools", provider: FAST_HOSTS },
  structured: { key: "structured", label: "D · Structured steps", style: "structured", provider: FAST_HOSTS },
  feedback: { key: "feedback", label: "E · Raw + learned strategy", style: "raw", provider: FAST_HOSTS, useStrategy: true },
  tools_structured: { key: "tools_structured", label: "F · Tools + structured", style: "tools_structured", provider: FAST_HOSTS },
  tools_feedback: { key: "tools_feedback", label: "G · Tools + learned strategy", style: "tools", provider: FAST_HOSTS, useStrategy: true },
  structured_feedback: { key: "structured_feedback", label: "H · Structured + learned strategy", style: "structured", provider: FAST_HOSTS, useStrategy: true },
};

// ---------- model client ----------

export class ModelClient {
  constructor({ endpoint = "/api/chat", enabled = false } = {}) {
    this.endpoint = endpoint;
    this.enabled = enabled;
    this.ledger = { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, ms: 0 };
    this.lastError = null;
  }
  // opts.harness: { provider, reasoning, max_tokens }; opts.tools: tool specs.
  async chat(messages, { temperature = 0.4, tag = "", harness = HARNESSES.raw, tools = null, tool_choice = null } = {}) {
    const t0 = performance.now();
    this.ledger.calls++;
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          temperature,
          tag,
          provider: harness?.provider,
          reasoning: harness?.reasoning,
          max_tokens: harness?.max_tokens,
          tools: tools || undefined,
          tool_choice: tool_choice || undefined,
        }),
      });
      const body = await res.json();
      const ms = Math.round(performance.now() - t0);
      this.ledger.ms += ms;
      this.ledger.promptTokens += body.usage?.prompt_tokens || 0;
      this.ledger.completionTokens += body.usage?.completion_tokens || 0;
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const hasTools = Array.isArray(body.tool_calls) && body.tool_calls.length;
      if (!hasTools && (typeof body.content !== "string" || !body.content.trim())) throw new Error("Ripple returned no final decision.");
      this.lastError = null;
      return { content: body.content || "", toolCalls: hasTools ? body.tool_calls : null, reasoning: body.reasoning || "", model: body.model, provider: body.provider, usage: body.usage, latencyMs: ms };
    } catch (err) {
      this.ledger.failures++;
      this.lastError = err.message;
      throw err;
    }
  }
}

function fieldSpec(fields) {
  return Object.entries(fields)
    .map(([k, spec]) => {
      if (Array.isArray(spec) && typeof spec[0] === "number") return `  "${k}": number in [${spec[0]}, ${spec[1]}] (${spec[2]})`;
      if (Array.isArray(spec)) return `  "${k}": one of ${spec.map((s) => `"${s}"`).join(", ")}`;
      return `  "${k}": ${spec}`;
    })
    .join("\n");
}

function physicsNote(world) {
  const P = world.physics;
  return `Simulator rules: drone top speed ${P.droneMaxSpeed} m/s, max acceleration ${P.droneMaxAccel} m/s^2, random wind gusts; touching any wall, floor or obstacle is a crash. The bird flies up to ${P.birdMaxSpeed} m/s, catches the drone within ${P.catchDistance} m, tires after ${P.birdStamina} s of chasing and then returns to its ambush point to rest ${P.birdRest} s. Episodes time out at ${P.maxTime} s. Building: two floors (ground y 0-4 m, upper y 4.3-8.3 m), 40 x 24 m, with an open atrium, a stairwell shaft, a south ground-floor door and a south upper-floor window.
Coordinates are [x, y, z] in metres: x runs west to east (0 to 40), z runs south to north (0 to 24; the south wall is at z = 0, so z < 0 is outside), y is height.`;
}

// Ripple reasons at length before answering; without this it often uses
// the whole output budget and never writes the JSON.
export const BRIEF =
  "\n\nThink briefly: at most about 150 words of reasoning. Estimate distances roughly instead of computing them exactly, compare the options at a high level, then give the JSON.";

export const BEHAVIOR_HYPOTHESES = `The bird follows one hidden behavior, which you must infer from what you observe:
- pursue: flies straight at the drone's current position
- intercept: flies toward where the drone will be a short time ahead
- ambush: flies to a fixed waiting point, stays there, and attacks when the drone comes near and into view
- patrol: flies back and forth between two points and attacks when the drone comes near and into view
Its speed, waiting point and trigger distance are also hidden.`;

// What an observer sees while the drone hovers at its start before takeoff.
// Independent of the drone's plan, so it can be shown before deciding.
export function observeBird(world, scenario, every = 0.5) {
  const menu = routeMenu(world, scenario.start, scenario.goal);
  const seed = scenario.seeds?.[0] ?? 1;
  const ep = new Episode(world, scenario, { route: menu[0].route, cruise_speed: 3, corner_slowdown: 0.5, avoidance_distance: 0, evade_strength: 0, replan_when_bird_nearby: false }, seed, { recordEvery: 1 });
  const until = ep.hold;
  const out = [];
  let next = 0;
  while (!ep.done && ep.t <= until + 1e-9) {
    if (ep.t >= next - 1e-9) {
      out.push({ t: Math.round(ep.t * 10) / 10, bird_position: fmt(ep.bird.pos) });
      next += every;
    }
    ep.tick();
  }
  return out;
}

// Compact structured state, per the spec's defender contract.
export function defenderState(world, scenario) {
  const N = world.nodes;
  const menu = routeMenu(world, scenario.start, scenario.goal);
  const used = new Set(menu.flatMap((r) => r.route));
  return {
    drone_position: fmt(N[scenario.start]),
    goal_position: fmt(N[scenario.goal]),
    bird_observations: observeBird(world, scenario),
    observation_note: `The drone has hovered at drone_position for ${world.physics.observeSeconds ?? 0} s while the bird was observed. It takes off on your plan now.`,
    available_routes: menu.map((r) => ({ id: r.id, length_m: r.length, passes: r.label, waypoints: r.route })),
    waypoint_positions: Object.fromEntries([...used].map((id) => [id, fmt(N[id])])),
    objective: "Reach the goal without being caught or crashing",
  };
}

// Bird positions sampled from a recorded trial, as an observer would see them.
function birdTrack(frames, every = 1.5, max = 10) {
  if (!frames?.length) return [];
  const out = [];
  let next = 0;
  for (const f of frames) {
    if (f.t >= next - 1e-9) {
      out.push(`t=${Math.round(f.t * 10) / 10}s ${JSON.stringify(fmt(f.b))}`);
      next += every;
      if (out.length >= max) break;
    }
  }
  return out;
}

// Simulator-verified score of the defender's stated belief about the bird.
// pursue and intercept look the same while the drone is still, so the fairer
// score groups behaviors into families.
export const BEHAVIOR_FAMILY = { pursue: "chaser", intercept: "chaser", ambush: "waits", patrol: "patrols", unknown: "unknown" };

export function scoreBelief(policy, scenario, results, frames0 = null, hold = 0) {
  const guess = policy?.bird_behavior_guess ?? "unknown";
  const behaviorCorrect = guess === scenario.bird.strategy;
  const familyCorrect = BEHAVIOR_FAMILY[guess] === BEHAVIOR_FAMILY[scenario.bird.strategy];
  let dangerError = null;
  if (policy?.danger_point) {
    const errs = results.filter((r) => r.closest).map((r) => v.dist(policy.danger_point, r.closest.drone));
    if (errs.length) dangerError = Math.round((errs.reduce((a, b) => a + b, 0) / errs.length) * 10) / 10;
  }
  // Bird position 3 s after takeoff, from the first seed's recorded track.
  let predictionError = null;
  if (policy?.predicted_bird_position && frames0?.length) {
    const tt = (scenario.hold ?? hold) + 3;
    const f = frames0.find((x) => x.t >= tt - 1e-6) || frames0[frames0.length - 1];
    predictionError = Math.round(v.dist(policy.predicted_bird_position, f.b) * 10) / 10;
  }
  return { guess, actual: scenario.bird.strategy, behaviorCorrect, familyCorrect, dangerError, predictionError };
}

// reveal = true shows the bird's hidden parameters (attacker only). The
// defender and the strategy writer see observations, outcomes and the
// verdict on their own belief, never the bird's settings for the episode
// being decided.
function episodeEvidence(world, ep, { reveal = false } = {}) {
  const s = ep.summary;
  const ownEvents = (r) =>
    r.events
      .filter((e) => (reveal ? e.type !== r.outcome : e.type.startsWith("drone_")))
      .slice(0, 3)
      .map((e) => `${e.t}s ${e.type}${e.detail ? ` (${e.detail})` : ""}`)
      .join("; ");
  const trials = ep.results
    .map((r, i) => {
      const c = r.closest;
      const near = c ? `; bird closest ${r.minSeparation} m at t=${c.t}s (drone ${JSON.stringify(fmt(c.drone))}, bird ${JSON.stringify(fmt(c.bird))})` : "";
      const ev = ownEvents(r);
      return `    trial ${i + 1}: ${r.outcome}${r.detail && reveal ? ` [${r.detail}]` : r.outcome === "crashed" ? ` [hit ${r.detail}]` : ""} at ${r.time}s at ${JSON.stringify(fmt(r.endPos))}${near}${ev ? `; ${ev}` : ""}`;
    })
    .join("\n");
  const b = ep.scenario.bird;
  const d = ep.defender;
  const pol = d.policy || {};
  const bird = reveal
    ? `  bird scenario: start ${b.start} ${JSON.stringify(fmt(world.nodes[b.start]))}, strategy ${b.strategy}, ambush/home ${b.ambush_node}, speed ${b.speed}, lead ${b.lead_time}s, trigger ${b.trigger_distance} m`
    : `  bird started at ${JSON.stringify(fmt(world.nodes[b.start]))}; observed track in trial 1: ${birdTrack(ep.frames?.[0]).join(", ") || "n/a"}`;
  const belief = ep.belief
    ? `\n  simulator verdict on the defender's belief: behavior guess "${ep.belief.guess}" was ${ep.belief.behaviorCorrect ? "correct" : `wrong (the bird's behavior was ${ep.belief.actual})`}${ep.belief.dangerError !== null ? `; predicted danger point was ${ep.belief.dangerError} m from where the bird actually got closest` : "; no danger point given"}`
    : "";
  return `${bird}
  defender decision: ${d.invalid ? `INVALID (${d.invalid})` : `guessed bird behavior ${pol.bird_behavior_guess ?? "n/a"}, danger point ${JSON.stringify(pol.danger_point ?? null)}, route ${pol.route_id} (${routeLabel(world, pol.route)}), speed ${pol.cruise_speed}, corner_slowdown ${pol.corner_slowdown}, avoidance ${pol.avoidance_distance} m, evade ${pol.evade_strength}, replan ${pol.replan_when_bird_nearby}`}
  simulator result: reached ${s.reached}/${s.trials}, intercepted ${s.intercepted}, crashed ${s.crashed}, timeout ${s.timeout}${belief}
${trials}`;
}

const STRUCTURED_FIELDS = {
  bird_velocity_estimate: "[vx, vy, vz] in m/s, estimated from the bird observations",
  bird_moving_toward_drone: "true or false, judged from that velocity and the drone's position",
};

export function defenderMessages(world, scenario, { history = [], strategy = null, style = "raw", brief = true } = {}) {
  const state = defenderState(world, scenario);
  let context = "";
  if (strategy) context = `\nYour navigation strategy (learned from earlier episodes; follow it):\n${strategy}\n`;
  if (history.length)
    context += `\nPrevious training episodes in this building (simulator-verified):\n${history
      .slice(-6)
      .map((ep) => `Episode ${ep.index}:\n${episodeEvidence(world, ep)}`)
      .join("\n\n")}\n`;
  return [
    {
      role: "system",
      content:
        "You are the navigation planner for an indoor delivery drone. First work out how the bird behaves from what you have observed, then choose a route and flight parameters. A physics simulator flies your plan; you do not control the drone directly. Reply with one JSON object and nothing else.",
    },
    {
      role: "user",
      content: `${physicsNote(world)}

${BEHAVIOR_HYPOTHESES}
${context}
Current state:
${JSON.stringify(state, null, 1)}

${style.includes("tools") ? "Use the geometry tools to measure what you need (bird velocity, distances, route clearance) instead of estimating by hand. When you are done, return" : "Return"}${
  style.includes("structured")
    ? ` JSON with these keys IN THIS ORDER, working step by step. Each value should follow from the ones before it:
${fieldSpec(STRUCTURED_FIELDS)}
${fieldSpec(DEFENDER_FIELDS)}`
    : ` JSON with exactly these keys:
${fieldSpec(DEFENDER_FIELDS)}`
}
  "rationale": one or two sentences on why${brief ? BRIEF : ""}`,
    },
  ];
}

// ---------- geometry tools (harness C) ----------
// Pure geometry over the state the defender was given. They never expose the
// bird's hidden behavior or settings.
export function geometryTools(world, scenario) {
  const N = world.nodes;
  const menu = routeMenu(world, scenario.start, scenario.goal);
  const obs = observeBird(world, scenario);
  const pt = (x) => {
    if (Array.isArray(x) && x.length === 3) return x.map(Number);
    if (typeof x === "string" && N[x]) return N[x];
    if (typeof x === "string" && x === "bird") return obs[obs.length - 1].bird_position;
    if (typeof x === "string" && x === "drone") return N[scenario.start];
    throw new Error(`unknown point ${JSON.stringify(x)}; use [x,y,z], a waypoint id, "bird" or "drone"`);
  };
  const routeOf = (id) => {
    const r = menu.find((m) => m.id.toLowerCase() === String(id).toLowerCase());
    if (!r) throw new Error(`unknown route ${id}; use one of ${menu.map((m) => m.id).join(", ")}`);
    return r;
  };
  const point = { description: 'A point: [x, y, z], a waypoint id, "bird" (latest observed bird position) or "drone" (drone position).' };
  const specs = [
    ["distance", "Straight-line distance in metres between two points.", { a: point, b: point }, ["a", "b"]],
    ["bird_velocity", "The bird's velocity [vx, vy, vz] (m/s), speed and unit direction, fitted to its last 1 s of observations.", {}, []],
    ["extrapolate", "Where something at `point` moving at constant `velocity` [vx,vy,vz] will be after `seconds`.", { point, velocity: { type: "array", items: { type: "number" } }, seconds: { type: "number" } }, ["point", "velocity", "seconds"]],
    ["heading_check", "Whether something at `from` moving with `velocity` is heading toward `to`: cosine of the angle (1 = straight at it) and the angle in degrees.", { from: point, velocity: { type: "array", items: { type: "number" } }, to: point }, ["from", "velocity", "to"]],
    ["route_clearance", "How close a route passes to a point: minimum distance in metres from the route's path to the point, and the nearest waypoint on the route.", { route_id: { type: "string" }, point }, ["route_id", "point"]],
    ["route_eta", "Seconds for the drone to reach a waypoint along a route at a given speed (approximate, ignores cornering). Omit waypoint for the whole route.", { route_id: { type: "string" }, speed: { type: "number" }, waypoint: { type: "string" } }, ["route_id", "speed"]],
  ];
  const tools = specs.map(([name, description, props, required]) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: Object.fromEntries(Object.entries(props).map(([k, s]) => [k, s.type ? s : { ...s }])), required },
    },
  }));
  const r2 = (x) => Math.round(x * 100) / 100;
  const run = (name, args) => {
    if (name === "distance") return { metres: r2(v.dist(pt(args.a), pt(args.b))) };
    if (name === "bird_velocity") {
      const last = obs[obs.length - 1];
      const prev = obs.find((o) => o.t >= last.t - 1.0) || obs[0];
      const dt = Math.max(0.1, last.t - prev.t);
      const vel = v.scale(v.sub(last.bird_position, prev.bird_position), 1 / dt);
      return { velocity: vel.map(r2), speed: r2(v.len(vel)), direction: v.norm(vel).map(r2), latest_position: last.bird_position, at_t: last.t };
    }
    if (name === "extrapolate") return { position: v.add(pt(args.point), v.scale(args.velocity.map(Number), Number(args.seconds))).map(r2) };
    if (name === "heading_check") {
      const c = v.dot(v.norm(args.velocity.map(Number)), v.norm(v.sub(pt(args.to), pt(args.from))));
      return { cosine: r2(c), angle_deg: Math.round((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI) };
    }
    if (name === "route_clearance") {
      const r = routeOf(args.route_id);
      const p = pt(args.point);
      let best = { d: Infinity, wp: null };
      for (let i = 1; i < r.route.length; i++) {
        const a = N[r.route[i - 1]];
        const b = N[r.route[i]];
        const ab = v.sub(b, a);
        const t = Math.max(0, Math.min(1, v.dot(v.sub(p, a), ab) / Math.max(1e-9, v.dot(ab, ab))));
        const d = v.dist(p, v.add(a, v.scale(ab, t)));
        if (d < best.d) best = { d, wp: t < 0.5 ? r.route[i - 1] : r.route[i] };
      }
      return { route_id: r.id, min_distance: r2(best.d), nearest_waypoint: best.wp };
    }
    if (name === "route_eta") {
      const r = routeOf(args.route_id);
      const upto = args.waypoint ? r.route.indexOf(String(args.waypoint)) : r.route.length - 1;
      if (upto < 0) throw new Error(`waypoint ${args.waypoint} is not on ${r.id}`);
      return { route_id: r.id, seconds: r2(world.routeLength(r.route.slice(0, upto + 1)) / Math.max(0.1, Number(args.speed))) };
    }
    throw new Error(`unknown tool ${name}`);
  };
  return { tools, run };
}

export function attackerMessages(world, task, history, rejected = []) {
  const N = world.nodes;
  const allowed = allowedBirdNodes(world, task);
  const menu = routeMenu(world, task.start, task.goal);
  const hist = history.length
    ? history.slice(-6).map((ep) => `Episode ${ep.index}:\n${episodeEvidence(world, ep, { reveal: true })}`).join("\n\n")
    : "No episodes yet.";
  const rej = rejected.length ? `\nRejected proposals so far (do not repeat them): ${rejected.join("; ")}\n` : "";
  return [
    {
      role: "system",
      content:
        "You design challenge scenarios for a drone navigation agent: where a territorial bird starts and how it hunts. Your goal is to expose weaknesses in the drone's planning, but every scenario must stay solvable: the simulator rejects scenarios where no reference route reaches the goal. Reply with one JSON object and nothing else.",
    },
    {
      role: "user",
      content: `${physicsNote(world)}

The drone flies from "${task.start}" ${JSON.stringify(fmt(N[task.start]))} to "${task.goal}" ${JSON.stringify(fmt(N[task.goal]))}. Its route options:
${menu.map((r) => `${r.id} (${r.length} m, ${r.label}): ${r.route.join(" > ")}`).join("\n")}

Allowed bird waypoints: ${allowed.map((id) => `${id} ${JSON.stringify(fmt(N[id]))}`).join(", ")}

Defender history (it adapts between episodes):
${hist}
${rej}
Return JSON with exactly these keys:
${fieldSpec(ATTACKER_FIELDS)}
  "rationale": one or two sentences on what weakness you are targeting${BRIEF}`,
    },
  ];
}

export function strategyMessages(world, history) {
  return [
    {
      role: "system",
      content: "You write concise, general navigation guidance for a drone planner, based on verified simulation results. Reply with one JSON object and nothing else.",
    },
    {
      role: "user",
      content: `${physicsNote(world)}

These training episodes were flown by the simulator. Look at what failed and what worked:

${history.map((ep) => `Episode ${ep.index}:\n${episodeEvidence(world, ep)}`).join("\n\n")}

${BEHAVIOR_HYPOTHESES}

Write a general strategy (at most 150 words) the drone planner should follow in NEW situations: different start and goal positions and different, unknown bird behavior. Include (1) how to tell the bird's behavior from its first seconds of observed movement, (2) how to choose a route given that behavior and the bird's position, and (3) speed, cornering and evasion settings. Do not refer to episode numbers or specific waypoint names, because the next tasks use different ones.

Return: {"strategy": "..."}${BRIEF}`,
    },
  ];
}

// ---------- spatial-prediction quiz (ground truth computed analytically) ----------

export function makeQuiz(n = 12, seed = 777) {
  const R = rng(seed);
  const u = (a, b) => a + (b - a) * R.next();
  const qs = [];
  for (let i = 0; i < n; i++) {
    const dp = [u(0, 20), u(1, 7), u(0, 20)];
    const dv = [u(-3, 3), u(-0.5, 0.5), u(-3, 3)];
    const bp = [u(0, 20), u(1, 7), u(0, 20)];
    let bv;
    if (i % 2 === 0) {
      // aim the bird near the drone's future position so roughly half collide
      const tHit = u(1, 3.5);
      const meet = v.add(v.add(dp, v.scale(dv, tHit)), [u(-0.8, 0.8), u(-0.3, 0.3), u(-0.8, 0.8)]);
      bv = v.scale(v.sub(meet, bp), 1 / tHit);
    } else bv = [u(-4, 4), u(-0.5, 0.5), u(-4, 4)];
    const rdp = fmt(dp), rdv = fmt(dv), rbp = fmt(bp), rbv = fmt(bv);
    // closest approach within horizon H, computed on the rounded values shown
    const H = 4;
    const rp = v.sub(rbp, rdp);
    const rv = v.sub(rbv, rdv);
    const vv = v.dot(rv, rv);
    const tStar = Math.max(0, Math.min(H, vv > 1e-9 ? -v.dot(rp, rv) / vv : 0));
    const dmin = v.len(v.add(rp, v.scale(rv, tStar)));
    qs.push({
      id: `Q${i + 1}`,
      drone_position: rdp,
      drone_velocity: rdv,
      bird_position: rbp,
      bird_velocity: rbv,
      truth: { collide: dmin < 1.0, t_closest: Math.round(tStar * 100) / 100, min_distance: Math.round(dmin * 100) / 100 },
    });
  }
  // Shuffle so the answer can't be read off the question order.
  for (let i = qs.length - 1; i > 0; i--) {
    const j = Math.floor(R.next() * (i + 1));
    [qs[i], qs[j]] = [qs[j], qs[i]];
  }
  return qs.map((q, i) => ({ ...q, id: `Q${i + 1}` }));
}

export function quizMessages(qs, strategy = null) {
  const shown = qs.map(({ truth, ...q }) => q);
  return [
    { role: "system", content: "You answer spatial prediction questions precisely. Reply with JSON only." },
    {
      role: "user",
      content: `${strategy ? `Guidance you wrote earlier for navigating near the bird:\n${strategy}\n\n` : ""}Each item gives a drone and a bird as points in 3D (metres, y up) moving at constant velocity (m/s). For each, predict whether they come within 1.0 m of each other during the next 4 seconds, and the time in [0, 4] s at which they are closest.

${JSON.stringify(shown, null, 1)}

Return a JSON array: [{"id": "Q1", "collide": true|false, "t_closest": number}, ...]${BRIEF}`,
    },
  ];
}

export function scoreQuiz(qs, answers) {
  const list = Array.isArray(answers) ? answers : Array.isArray(answers?.answers) ? answers.answers : [];
  const byId = Object.fromEntries(list.map((a) => [String(a.id), a]));
  let correct = 0;
  let tErr = 0;
  let tN = 0;
  const rows = qs.map((q) => {
    const a = byId[q.id];
    const ok = !!a && (a.collide === true || a.collide === "true") === q.truth.collide;
    if (ok) correct++;
    if (a && Number.isFinite(Number(a.t_closest))) {
      tErr += Math.abs(Number(a.t_closest) - q.truth.t_closest);
      tN++;
    }
    return { id: q.id, truth: q.truth, answer: a || null, correct: ok };
  });
  return { accuracy: qs.length ? correct / qs.length : 0, correct, total: qs.length, meanTimeError: tN ? Math.round((tErr / tN) * 100) / 100 : null, answered: tN, rows };
}

// ---------- rule-based stand-ins (no model configured) ----------

export function heuristicDefender(world, scenario, { history = [], strategy = null } = {}) {
  const menu = routeMenu(world, scenario.start, scenario.goal);
  // Crude identification from the observed track: heading at the drone =
  // chaser, slow = patrol, otherwise lying in wait.
  const obs = observeBird(world, scenario);
  const first = obs[0].bird_position;
  const lastObs = obs[obs.length - 1];
  const moved = v.sub(lastObs.bird_position, first);
  const speed = v.len(moved) / Math.max(0.1, lastObs.t);
  const toDrone = v.norm(v.sub(world.nodes[scenario.start], first));
  const guess = speed < 0.5 ? "ambush" : v.dot(v.norm(moved), toDrone) > 0.8 ? "pursue" : speed < 2.3 ? "patrol" : "ambush";
  if (!strategy && !history.length) {
    return { bird_behavior_guess: "unknown", danger_point: null, route_id: menu[0].id, cruise_speed: 3.5, corner_slowdown: 0.4, avoidance_distance: 0, evade_strength: 0, replan_when_bird_nearby: false, rationale: "Take the shortest route." };
  }
  // Prefer routes that stay away from where the bird is heading, then evade.
  const bird = v.add(lastObs.bird_position, v.scale(moved, 1));
  const clearance = (r) => Math.min(...r.route.slice(1, -1).map((id) => v.dist(world.nodes[id], bird)), 99);
  const best = menu
    .map((r) => ({ r, s: Math.min(clearance(r), 12) - r.length / 12 }))
    .sort((a, b) => b.s - a.s)[0].r;
  const danger = best.route.slice(1, -1).map((id) => world.nodes[id]).sort((a, b) => v.dist(a, bird) - v.dist(b, bird))[0] || null;
  return {
    bird_behavior_guess: guess,
    danger_point: danger ? fmt(danger) : null,
    route_id: best.id,
    cruise_speed: 4.2,
    corner_slowdown: 0.6,
    avoidance_distance: 6,
    evade_strength: 0.6,
    replan_when_bird_nearby: true,
    rationale: `Bird looks like "${guess}"; route ${best.id} keeps the most distance from where it is heading; react within 6 m.`,
  };
}

export function heuristicAttacker(world, task, history, rejected = []) {
  const allowed = allowedBirdNodes(world, task);
  const last = history[history.length - 1];
  if (!last) return { bird_start: allowed.includes("perch") ? "perch" : allowed[0], strategy: "pursue", ambush_node: "perch", speed: 4.0, lead_time: 0, trigger_distance: 10, rationale: "Start with a direct chase." };
  const route = last.defender.policy.route || [];
  const goal = world.nodes[task.goal];
  const tried = new Set([...history.map((h) => h.scenario.bird.ambush_node), ...rejected.map((r) => r.split(" ")[0])]);
  const cand = route.filter((id) => allowed.includes(id) && !tried.has(id)).sort((a, b) => v.dist(world.nodes[a], goal) - v.dist(world.nodes[b], goal));
  const node = cand[0] || allowed[(history.length * 7 + rejected.length) % allowed.length];
  if (history.length % 3 === 2) {
    // every third episode: patrol across the defender's last route
    const far = allowed.reduce((a, b) => (v.dist(world.nodes[b], world.nodes[node]) > v.dist(world.nodes[a], world.nodes[node]) ? b : a));
    return { bird_start: far, strategy: "patrol", ambush_node: node, speed: 4.4, lead_time: 0.8, trigger_distance: 12, rationale: `Patrol across ${node}, which the defender last flew through.` };
  }
  return {
    bird_start: node,
    strategy: "ambush",
    ambush_node: node,
    speed: 4.4,
    lead_time: 0.8,
    trigger_distance: 12,
    rationale: `The defender last used ${last.defender.policy.route_id}; wait on that route at ${node}.`,
  };
}

export function heuristicStrategy(history) {
  const caught = history.reduce((s, h) => s + h.summary.intercepted, 0);
  const crashed = history.reduce((s, h) => s + h.summary.crashed, 0);
  return `Prefer the route whose waypoints stay furthest from the bird's position, even if it is somewhat longer. Fly about 4 m/s with corner_slowdown around 0.6. React to the bird within 6 m with evade_strength 0.6 and replanning enabled. (${caught} interceptions and ${crashed} crashes in training.)`;
}
