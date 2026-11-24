// Environment-aware prompts for live steering (Reach), without touching the
// hashed harness file sim/src/gym/reach_agents.js.
//
// reach_agents.js writes a few factory assumptions into every prompt: the
// system line says "an indoor building", the C1 rules say "the building's
// waypoint graph", and the lean (C3) prompt says "a factory building". The
// time limit and goal radius are written as literals (90 s, 1 m).
//
// This module takes the prompt that reach_agents.js builds and rewrites only
// those phrases from the environment's own description. For the factory every
// rewrite is a no-op, so the factory prompt is byte-identical to the published
// one (sim/test/arena_prompt.test.mjs proves it for every level and feature).
// Each phrase must be found where expected: if reach_agents.js ever changes
// its wording, the rewrite throws instead of silently doing nothing.
//
// Use localizeChat(chat, profile) to wrap a chat function: the controller in
// reach_agents.js keeps its parsing, checks and fallbacks unchanged, and the
// model sees the environment's text.

import { reachMessages } from "./reach_agents.js";
import { TIME_LIMIT, GOAL_RADIUS } from "./reach.js";

export const FACTORY_SCENE = "The building is a 3D scan of a real factory: halls, rooms, pillars, machinery and clutter.";

// What reach_agents.js says today (the anchors). Each is replaced by the
// matching profile field.
const ANCHORS = {
  system: "You are piloting a small drone through an indoor building.",
  graph: "You know the building's waypoint graph (below).",
  limits: "You reach the goal within 1 m of it. You have 90 s.",
  leanPlace: "Drone in a factory building, no map.",
  leanLimits: "Reach within 1 m of the goal within 90 s.",
};

// The physics the prompts state as literals (top speed 5.5 in the C3/C4
// command lines, radius 0.25 in the program prompt). Every map shipped today
// uses these; a map that differs would make the prompt wrong, so refuse it.
export const PROMPT_PHYSICS = { droneRadius: 0.25, droneMaxSpeed: 5.5, droneMaxAccel: 7 };

const fmt = (x) => String(Math.round(x * 100) / 100);

// Profile for one environment, from its harness entry (benchmark_env.mjs
// loadEnvironment). Optional overrides in the entry: prompt.setting
// ("an outdoor area"), prompt.placeNoun ("area"), prompt.leanPlace.
export function promptProfile(E = {}) {
  const scene = E.scene ?? FACTORY_SCENE;
  const indoor = E.prompt?.indoor ?? /^The building\b/.test(scene);
  const factory = scene === FACTORY_SCENE;
  const limits = { timeLimitS: E.limits?.timeLimitS ?? TIME_LIMIT, goalRadiusM: E.limits?.goalRadiusM ?? GOAL_RADIUS };
  // The simulator enforces reach.js's constants for every map; a prompt that
  // stated other limits would lie to the model.
  if (limits.timeLimitS !== TIME_LIMIT || limits.goalRadiusM !== GOAL_RADIUS) throw new Error(`environment ${E.name}: limits ${JSON.stringify(limits)} differ from the simulator's (${TIME_LIMIT} s, ${GOAL_RADIUS} m)`);
  if (E.world?.physics) for (const [k, want] of Object.entries(PROMPT_PHYSICS)) if (E.world.physics[k] !== want) throw new Error(`environment ${E.name}: physics.${k} is ${E.world.physics[k]}, the prompts state ${want}`);
  return {
    name: E.name ?? "factory",
    scene,
    setting: E.prompt?.setting ?? (indoor ? "an indoor building" : "an outdoor area"),
    placeNoun: E.prompt?.placeNoun ?? (indoor ? "building" : "area"),
    leanPlace: E.prompt?.leanPlace ?? (factory ? "a factory building" : indoor ? "a building" : "an outdoor area"),
    ...limits,
  };
}

const swap = (text, anchor, repl, where) => {
  if (!text.includes(anchor)) throw new Error(`arena_prompt: expected "${anchor}" in the ${where} prompt; reach_agents.js changed, update the anchors`);
  return text.split(anchor).join(repl);
};

// Rewrite messages built by reachMessages for this profile.
export function localizeMessages(messages, profile) {
  const P = profile;
  const lim = `You reach the goal within ${fmt(P.goalRadiusM)} m of it. You have ${fmt(P.timeLimitS)} s.`;
  const leanLim = `Reach within ${fmt(P.goalRadiusM)} m of the goal within ${fmt(P.timeLimitS)} s.`;
  return messages.map((m, i) => {
    let c = m.content;
    if (i === 0 && m.role === "system") {
      if (c.includes(ANCHORS.system)) c = swap(c, ANCHORS.system, `You are piloting a small drone through ${P.setting}.`, "system");
      return c === m.content ? m : { ...m, content: c };
    }
    if (m.role !== "user") return m;
    if (c.includes(ANCHORS.leanPlace)) {
      c = swap(c, ANCHORS.leanPlace, `Drone in ${P.leanPlace}, no map.`, "lean");
      c = swap(c, ANCHORS.leanLimits, leanLim, "lean");
    } else {
      c = swap(c, ANCHORS.limits, lim, "rules");
      if (c.includes(ANCHORS.graph)) c = swap(c, ANCHORS.graph, `You know the ${P.placeNoun}'s waypoint graph (below).`, "C1");
    }
    return c === m.content ? m : { ...m, content: c };
  });
}

// The full builder: what reachMessages would build, for this environment.
export function envReachMessages(world, scenario, level, obs, history, opts = {}, env = null, profile = promptProfile()) {
  return localizeMessages(reachMessages(world, scenario, level, obs, history, { ...opts, scene: opts.scene ?? profile.scene }, env), profile);
}

// Wrap a chat function so every Reach prompt is rewritten for the profile.
// Messages that are not Reach prompts (a preflight, for example) pass through.
export function localizeChat(chat, profile) {
  return (messages, ...rest) => {
    const isReach = messages.some((m) => m.role === "system" && (m.content.includes("piloting a small drone") || m.content.startsWith("You pilot a drone.")));
    return chat(isReach ? localizeMessages(messages, profile) : messages, ...rest);
  };
}
