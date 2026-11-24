// Controllers for closed-loop matches (duel.js): Ripple-backed drone and
// bird, plus scripted baselines that use the same observations and the same
// command interface. Ripple controllers take a `chat(messages, meta)`
// function so this module never sees an API key.

import { v } from "./world.js";

const r1 = (p) => p.map((x) => Math.round(x * 10) / 10);
export const DRONE_INTENTS = ["chasing me", "waiting in ambush", "patrolling", "unknown"];

export function mapBrief(world) {
  const N = world.nodes;
  const tags = world.map.routeTags || {};
  return world.nodeIds
    .map((id) => `${id} ${JSON.stringify(r1(N[id]))}${tags[id] ? ` (${tags[id]})` : ""} -> ${world.adj[id].join(", ")}`)
    .join("\n");
}

function rules(world) {
  const P = world.physics;
  return `Simulator: ${world.map.name}. Coordinates [x, y, z] in metres, y is height. Touching any wall, floor or obstacle is a crash. Drone top speed ${P.droneMaxSpeed} m/s; bird top speed ${P.birdMaxSpeed} m/s. The bird catches the drone if it gets within ${P.catchDistance} m. The bird can sprint (faster than ${(0.6 * P.birdMaxSpeed).toFixed(1)} m/s) for at most ${P.birdStamina} s, recovering 0.5 s of sprint per second when slower; at zero it must rest ${P.birdRest} s without moving. Each side sees the other only with a clear line of sight within 30 m; otherwise it only knows where it last saw it. Random wind gusts push the drone. The match ends when the drone reaches its goal, is caught, crashes, or after ${P.maxTime} s. Every 1 s of simulated time each side gets its observation and gives a new command; both decide at the same moment.`;
}

const DRONE_SYSTEM =
  "You are the pilot of a small delivery drone in a physics simulation. A hostile bird is trying to catch it. Every second you receive what the drone can currently observe and you give the next flight command. An autopilot flies your command along the waypoint graph; it does NOT dodge the bird, so avoiding the bird is up to you. Reply with one JSON object and nothing else.";

const BIRD_SYSTEM =
  "You control a hunting bird in a physics simulation. A drone is trying to fly to its goal; your job is to catch it before it gets there. Every second you receive what the bird can currently observe and you give the next command. A flight controller steers around walls for you. Reply with one JSON object and nothing else.";

function recent(history, key) {
  return history.slice(-3).map((h) => ({ t: h.t, command: h[key].command, said: h[key].say })).filter((h) => h.command);
}

const notesBlock = (notes) => (notes ? `\nYour notes from earlier matches (written by you from simulator-verified results):\n${notes}\n` : "");

export function droneMessages(world, scenario, obs, history, notes = null) {
  return [
    { role: "system", content: DRONE_SYSTEM },
    {
      role: "user",
      content: `${rules(world)}

Waypoint graph (id [x,y,z] -> neighbours). The autopilot flies the shortest graph path from the drone's nearest waypoint to "via", then the shortest path from "via" to the goal:
${mapBrief(world)}

${notesBlock(notes)}
Your last commands: ${JSON.stringify(recent(history, "drone"))}

Current observation:
${JSON.stringify(obs)}

Return JSON with these keys:
  "bird_intent": one of ${DRONE_INTENTS.map((s) => `"${s}"`).join(", ")}
  "bird_in_2s": [x, y, z] where you expect the bird in 2 s, or null if you have no idea
  "via": a waypoint id to route through on the way to the goal (use the goal id "${scenario.goal}" to go straight there)
  "speed": cruise speed in m/s, 0.5 to ${world.physics.droneMaxSpeed}
  "hold": true to hover in place for this second instead of flying
  "say": at most 12 words: what you are doing and why`,
    },
  ];
}

export function birdMessages(world, scenario, obs, history, notes = null) {
  return [
    { role: "system", content: BIRD_SYSTEM },
    {
      role: "user",
      content: `${rules(world)}

Waypoint graph (id [x,y,z] -> neighbours):
${mapBrief(world)}

${notesBlock(notes)}
Your last commands: ${JSON.stringify(recent(history, "bird"))}

Current observation:
${JSON.stringify(obs)}

Return JSON with these keys:
  "drone_heading_to": the waypoint id you think the drone is heading for next, or null
  "mode": "chase" (fly at the drone's last seen position, led by lead_s seconds of its velocity), "goto" (fly to a waypoint) or "wait" (hover where you are)
  "target": waypoint id, required for "goto"
  "lead_s": 0 to 2, used by "chase"
  "speed": m/s, 0.5 to ${world.physics.birdMaxSpeed} (above ${(0.6 * world.physics.birdMaxSpeed).toFixed(1)} uses sprint energy)
  "say": at most 12 words: what you are doing and why`,
    },
  ];
}

export function parseJson(text) {
  if (typeof text !== "string") return null;
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try {
    const o = JSON.parse(text.slice(s, e + 1));
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

// A Ripple-backed controller. One format-repair retry with the identical
// prompt; after that the decision is invalid and the previous command (or a
// hover, at t = 0) stands. Invalid decisions are counted and reported.
function rippleController(role, world, scenario, chat, build, notes = null) {
  const history = [];
  return async (obs) => {
    const msgs = build(world, scenario, obs, history, notes);
    let reply = null;
    let parsed = null;
    let attempts = 0;
    let error = null;
    while (attempts < 2 && !parsed) {
      attempts++;
      try {
        reply = await chat(msgs, { role, scenario: scenario.id, t: obs.time_s });
        parsed = parseJson(reply.content);
        if (!parsed) error = "unparseable reply";
      } catch (err) {
        error = String(err.message || err);
      }
    }
    const prev = history.length ? history[history.length - 1][role]?.command : null;
    const rec = parsed
      ? role === "drone"
        ? { command: { via: parsed.via, speed: parsed.speed, hold: parsed.hold === true }, belief: { intent: parsed.bird_intent ?? null, bird_in_2s: Array.isArray(parsed.bird_in_2s) ? parsed.bird_in_2s : null }, say: String(parsed.say ?? "").slice(0, 160) }
        : { command: { mode: parsed.mode, target: parsed.target, lead_s: parsed.lead_s, speed: parsed.speed }, belief: { drone_heading_to: parsed.drone_heading_to ?? null }, say: String(parsed.say ?? "").slice(0, 160) }
      : { command: prev || (role === "drone" ? { hold: true } : { mode: "wait" }), invalid: error, say: "" };
    rec.meta = { attempts, provider: reply?.provider ?? null, latencyMs: reply?.latencyMs ?? null, promptTokens: reply?.usage?.prompt_tokens ?? null, completionTokens: reply?.usage?.completion_tokens ?? null };
    history.push({ t: obs.time_s, [role]: rec });
    return rec;
  };
}

export const rippleDrone = (world, scenario, chat, notes = null) => rippleController("drone", world, scenario, chat, droneMessages, notes);
export const rippleBird = (world, scenario, chat, notes = null) => rippleController("bird", world, scenario, chat, birdMessages, notes);

// ---------- reflection: notes for the next generation ----------
// Each side sees only its own match logs plus the simulator's verdicts.
export function matchDigest(role, m, scenario) {
  const r = m.result;
  const me = role === "drone" ? "drone" : "bird";
  const lines = m.decisions.map((d) => {
    const x = d[me];
    if (!x) return null;
    const c = x.command;
    const cmd = role === "drone" ? (c.hold ? "hover" : `via ${c.via} @${c.speed}`) : `${c.mode}${c.target ? " " + c.target : ""}${c.mode === "chase" ? " lead " + c.lead_s : ""} @${c.speed}`;
    return `  t=${d.t}s ${cmd}${x.say ? ` ("${x.say}")` : ""}${x.invalid ? " [invalid reply]" : ""}`;
  }).filter(Boolean);
  const verdict = r.outcome === "reached" ? (role === "drone" ? "YOU WON: reached the goal" : "YOU LOST: the drone reached its goal") : r.outcome === "intercepted" ? (role === "drone" ? "YOU LOST: caught by the bird" : "YOU WON: caught the drone") : role === "drone" ? "YOU LOST: out of time" : "YOU WON: the drone ran out of time";
  const c = r.closest ? ` Closest approach ${r.minSeparation} m at t=${r.closest.t}s (drone ${JSON.stringify(r.closest.drone)}, bird ${JSON.stringify(r.closest.bird)}).` : "";
  return `Match: drone ${scenario.start} -> goal ${scenario.goal}. ${verdict} at t=${r.time}s.${c}\n${lines.slice(0, 25).join("\n")}`;
}

export function reflectionMessages(world, role, digests, oldNotes) {
  const who = role === "drone" ? "the drone pilot" : "the hunting bird";
  return [
    { role: "system", content: `You are ${who} in a physics simulation, writing notes to your future self. Reply with the notes only, as plain text.` },
    {
      role: "user",
      content: `${rules(world)}

${oldNotes ? `Your current notes:\n${oldNotes}\n\n` : ""}Here are your matches from the last round, with the simulator's verdicts:

${digests.join("\n\n")}

Write updated notes for your future self (at most 200 words). Keep what is supported by these results, drop what was contradicted, and add concrete rules about positions, routes, timing, line of sight and speed that would have changed the outcomes. Use waypoint names where useful.`,
    },
  ];
}

// ---------- scripted baselines ----------

// Flies straight to the goal at top speed; ignores the bird.
export const shortestDrone = (world, scenario) => async () => ({ command: { via: scenario.goal, speed: world.physics.droneMaxSpeed }, say: "straight to goal" });

// Keep-away evader: when it knows where the bird is, picks the via waypoint
// whose path keeps the most clearance from the bird's last sighting
// (capped at 10 m), with a small penalty for length. Otherwise shortest.
export const evaderDrone = (world, scenario) => async (obs, duel) => {
  const s = duel.seen.byDrone;
  const max = world.physics.droneMaxSpeed;
  if (!s) return { command: { via: scenario.goal, speed: max }, say: "no bird seen; straight to goal" };
  const here = world.nearestVisibleNode(duel.drone.pos, world.physics.droneRadius);
  let best = null;
  for (const via of world.nodeIds) {
    const a = world.path(here, via);
    const b = via === scenario.goal ? [via] : world.path(via, scenario.goal);
    if (!a || !b) continue;
    const route = [...a, ...b.slice(1)];
    const clearance = Math.min(...route.slice(0, 6).map((id) => v.dist(world.nodes[id], s.pos)));
    const score = Math.min(clearance, 10) - 0.05 * world.routeLength(route);
    if (!best || score > best.score) best = { via, score };
  }
  return { command: { via: best.via, speed: max }, say: `keep away via ${best.via}` };
};

// Greedy bird: guards the goal at a cruise below sprint speed; chases with
// a short lead whenever it sees the drone and has energy to spare.
export const greedyBird = (world, scenario) => async (obs, duel) => {
  const P = world.physics;
  const cruise = Math.round(0.58 * P.birdMaxSpeed * 10) / 10;
  if (duel.seen.byBird && duel.t - duel.seen.byBird.t < 0.15) {
    const sprint = duel.bird.energy > 2 ? P.birdMaxSpeed : cruise;
    return { command: { mode: "chase", lead_s: 0.5, speed: sprint }, say: "drone in view: chase" };
  }
  return { command: { mode: "goto", target: scenario.goal, speed: cruise }, say: "guard the goal" };
};
