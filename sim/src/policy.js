// Action schemas. The model only ever returns one of these JSON objects;
// the engine executes it. Out-of-range numbers are clamped and counted as
// constraint violations. A defender reply without a usable route is an
// invalid action (reward -1, nothing is flown).

import { v, routeMenu } from "./world.js";

export const BIRD_BEHAVIORS = ["pursue", "intercept", "ambush", "patrol"];

export const DEFENDER_FIELDS = {
  bird_behavior_guess: [...BIRD_BEHAVIORS, "unknown"],
  predicted_bird_position: "[x, y, z] where you expect the bird to be 3 seconds after the drone takes off",
  danger_point: "[x, y, z] where you expect the bird is most likely to reach you on your chosen route, or null if you expect no encounter",
  route_id: "id of one of the available routes (e.g. \"R3\")",
  cruise_speed: [1.5, 5.5, "m/s target speed on straight segments"],
  corner_slowdown: [0, 1, "0 = take corners at full speed (may overshoot into walls), 1 = brake hard before every turn"],
  avoidance_distance: [0, 10, "m; inside this distance the drone reacts to the bird (0 = ignore the bird)"],
  evade_strength: [0, 1, "how strongly the drone steers away from the bird when it reacts"],
  replan_when_bird_nearby: "boolean; when reacting, re-route through waypoints away from the bird",
};

export const ATTACKER_FIELDS = {
  bird_start: "waypoint id where the bird begins",
  strategy: BIRD_BEHAVIORS,
  ambush_node: "waypoint id the bird waits at (ambush), patrols to and from its start (patrol), and returns to when it tires",
  speed: [2.5, 4.6, "m/s top speed while hunting"],
  lead_time: [0, 3, "s; how far ahead of the drone the bird aims (intercept and ambush)"],
  trigger_distance: [2, 20, "m; ambush waits until the drone is this close and in line of sight"],
};

const clampField = (obj, key, [lo, hi], warnings, fallback) => {
  let x = Number(obj[key]);
  if (obj[key] === undefined || obj[key] === null || !Number.isFinite(x)) {
    warnings.push(`${key} missing or not a number, using ${fallback}`);
    x = fallback;
  }
  if (x < lo || x > hi) {
    warnings.push(`${key}=${x} clamped to [${lo}, ${hi}]`);
    x = Math.min(hi, Math.max(lo, x));
  }
  return Math.round(x * 100) / 100;
};

// Shortest-path comparator: no model, no awareness of the bird.
export function shortestPathPolicy(world, scenario) {
  const menu = routeMenu(world, scenario.start, scenario.goal);
  return {
    bird_behavior_guess: "unknown",
    predicted_bird_position: null,
    danger_point: null,
    route_id: menu[0].id,
    route: menu[0].route,
    cruise_speed: 3.5,
    corner_slowdown: 0.4,
    avoidance_distance: 0,
    evade_strength: 0,
    replan_when_bird_nearby: false,
    rationale: "Shortest-path comparator: shortest route, moderate speed, ignores the bird.",
  };
}

export function validateDefender(raw, world, scenario) {
  const warnings = [];
  const p = raw && typeof raw === "object" ? raw : {};
  const menu = routeMenu(world, scenario.start, scenario.goal);
  let route = null;
  let routeId = null;
  let invalid = null;
  if (p.route_id !== undefined) {
    const m = menu.find((r) => r.id.toLowerCase() === String(p.route_id).trim().toLowerCase());
    if (m) {
      route = m.route;
      routeId = m.id;
    } else invalid = `route_id "${p.route_id}" is not one of ${menu.map((r) => r.id).join(", ")}`;
  } else if (Array.isArray(p.route)) {
    const err = world.isValidRoute(p.route.map(String), scenario.start, scenario.goal);
    if (err) invalid = `route rejected: ${err}`;
    else {
      route = p.route.map(String);
      routeId = menu.find((r) => r.route.join() === route.join())?.id || "custom";
    }
  } else invalid = "no route_id given";
  const d = shortestPathPolicy(world, scenario);
  let guess = String(p.bird_behavior_guess ?? "unknown").toLowerCase().trim();
  if (![...BIRD_BEHAVIORS, "unknown"].includes(guess)) {
    warnings.push(`bird_behavior_guess "${p.bird_behavior_guess}" not recognised; using unknown`);
    guess = "unknown";
  }
  const point = (key) => {
    const x = p[key];
    if (Array.isArray(x) && x.length === 3 && x.every((c) => Number.isFinite(Number(c)))) {
      const { min, max } = world.bounds;
      return x.map((c, i) => Math.min(max[i], Math.max(min[i], Math.round(Number(c) * 10) / 10)));
    }
    if (x !== null && x !== undefined) warnings.push(`${key} is not [x, y, z]; ignored`);
    return null;
  };
  const predicted = point("predicted_bird_position");
  let danger = null;
  if (Array.isArray(p.danger_point) && p.danger_point.length === 3 && p.danger_point.every((x) => Number.isFinite(Number(x)))) {
    const { min, max } = world.bounds;
    danger = p.danger_point.map((x, i) => Math.min(max[i], Math.max(min[i], Math.round(Number(x) * 10) / 10)));
  } else if (p.danger_point !== null && p.danger_point !== undefined) {
    warnings.push("danger_point is not [x, y, z]; ignored");
  }
  return {
    policy: {
      bird_behavior_guess: guess,
      predicted_bird_position: predicted,
      danger_point: danger,
      route_id: routeId,
      route,
      cruise_speed: clampField(p, "cruise_speed", DEFENDER_FIELDS.cruise_speed, warnings, d.cruise_speed),
      corner_slowdown: clampField(p, "corner_slowdown", DEFENDER_FIELDS.corner_slowdown, warnings, d.corner_slowdown),
      avoidance_distance: clampField(p, "avoidance_distance", DEFENDER_FIELDS.avoidance_distance, warnings, d.avoidance_distance),
      evade_strength: clampField(p, "evade_strength", DEFENDER_FIELDS.evade_strength, warnings, d.evade_strength),
      replan_when_bird_nearby: p.replan_when_bird_nearby === true || p.replan_when_bird_nearby === "true",
      rationale: typeof p.rationale === "string" ? p.rationale.slice(0, 600) : "",
    },
    warnings,
    invalid,
  };
}

// Waypoints the bird may start at / ambush from for a given drone task.
export function allowedBirdNodes(world, scenario) {
  const N = world.nodes;
  const s = N[scenario.start];
  const g = N[scenario.goal];
  return world.nodeIds.filter(
    (id) => id !== scenario.start && id !== scenario.goal && v.dist(N[id], s) >= 9 && v.dist(N[id], g) >= 4,
  );
}

export function defaultAttack(world, scenario) {
  const allowed = allowedBirdNodes(world, scenario);
  const home = allowed.includes(world.map.birdStart) ? world.map.birdStart : allowed[0];
  return { bird_start: home, strategy: "pursue", ambush_node: home, speed: 4.0, lead_time: 0, trigger_distance: 10, rationale: "Default: chase from the perch." };
}

export function validateAttack(raw, world, scenario) {
  const warnings = [];
  const p = raw && typeof raw === "object" ? raw : {};
  const d = defaultAttack(world, scenario);
  const allowed = allowedBirdNodes(world, scenario);
  let strategy = String(p.strategy || "").toLowerCase();
  if (!ATTACKER_FIELDS.strategy.includes(strategy)) {
    warnings.push(`strategy "${p.strategy}" unknown; using ${d.strategy}`);
    strategy = d.strategy;
  }
  let start = String(p.bird_start || "");
  if (!allowed.includes(start)) {
    warnings.push(`bird_start "${p.bird_start}" not allowed; using ${d.bird_start}`);
    start = d.bird_start;
  }
  let ambush = String(p.ambush_node || start);
  if (!allowed.includes(ambush)) {
    warnings.push(`ambush_node "${p.ambush_node}" not allowed; using ${start}`);
    ambush = start;
  }
  if (strategy === "patrol" && ambush === start) {
    // a patrol needs two different ends; use the allowed waypoint furthest away
    const N = world.nodes;
    ambush = allowed.reduce((a, b) => (v.dist(N[b], N[start]) > v.dist(N[a], N[start]) ? b : a));
    warnings.push(`patrol needs two different waypoints; patrolling ${start} to ${ambush}`);
  }
  return {
    bird: {
      start,
      strategy,
      ambush_node: ambush,
      speed: clampField(p, "speed", ATTACKER_FIELDS.speed, warnings, d.speed),
      lead_time: clampField(p, "lead_time", ATTACKER_FIELDS.lead_time, warnings, d.lead_time),
      trigger_distance: clampField(p, "trigger_distance", ATTACKER_FIELDS.trigger_distance, warnings, d.trigger_distance),
      rationale: typeof p.rationale === "string" ? p.rationale.slice(0, 600) : "",
    },
    warnings,
  };
}

// Pull the first JSON object out of a model reply (handles ```json fences
// and leading prose).
export function extractJson(text) {
  if (typeof text !== "string") return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const open = src.search(/[[{]/);
  if (open < 0) return null;
  const closeFor = { "{": "}", "[": "]" };
  const first = src[open];
  let depth = 0;
  let inStr = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === first) depth++;
    else if (c === closeFor[first] && --depth === 0) {
      try {
        return JSON.parse(src.slice(open, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
