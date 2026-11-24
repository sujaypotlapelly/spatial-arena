// Reach route sets, version 2: node-disjoint.
//
// makeReachSets (reach.js) only keeps a route and its reverse out of two
// sets, so a test route can start or end at a waypoint a practice route also
// uses (18 of 48 factory test routes do). A program that is shown practice
// coordinates could then learn places instead of learning to fly.
//
// Here every waypoint belongs to at most one set: no start or goal used by
// train appears in dev, held-out or test, and the same holds between every
// other pair of sets. With separation > 0, endpoints of different sets are
// also at least that many metres apart, so two sets cannot meet at
// neighbouring waypoints either.
//
// The candidate rule (15-35 m apart, no straight line of sight, a graph
// detour of at least 15%) is the same as makeReachSets. This is a new
// generator with its own ids ("N" prefix by default) and wind seeds; it does
// not change makeReachSets or any published set.
import { v } from "../world.js";
import { rng } from "../engine.js";

export const SET_ORDER = ["train", "dev", "heldout", "test"];

export function reachCandidates(world, { minDist = 15, maxDist = 35, minDetour = 1.15 } = {}) {
  const ids = world.nodeIds;
  const cands = [];
  for (const a of ids)
    for (const b of ids) {
      if (a === b) continue;
      const d = v.dist(world.nodes[a], world.nodes[b]);
      if (d < minDist || d > maxDist) continue;
      if (world.segmentClear(world.nodes[a], world.nodes[b], 0.25)) continue;
      const p = world.path(a, b);
      if (!p) continue;
      const L = world.routeLength(p);
      if (L / d < minDetour) continue;
      cands.push({ start: a, goal: b, straight_m: Math.round(d * 10) / 10, graph_m: Math.round(L * 10) / 10 });
    }
  return cands;
}

// Greedy, seeded: the shuffled candidates are offered to the set that is
// least full (as a share of its size). A set takes the first route whose two
// endpoints are free or already its own, preferring routes that claim no new
// waypoint, so small maps are not used up early. Taking a route claims its
// endpoints for that set for good. Throws if a set cannot be filled, rather
// than returning a short set.
//   separation   metres; a set may not claim a waypoint closer than this to a
//                waypoint another set owns (default 3)
//   maxUses      how many routes of one set may use the same waypoint
//                (default 4), so a set is not a star around one place
export function makeReachSetsDisjoint(world, { train = 12, dev = 24, heldout = 24, test = 48, seed = 20261119, minDist = 15, maxDist = 35, minDetour = 1.15, idPrefix = "N", windOffset = 0, separation = 3, maxUses = 4 } = {}) {
  const want = { train, dev, heldout, test };
  const cands = reachCandidates(world, { minDist, maxDist, minDetour });
  const R = rng(seed);
  for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(R.next() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
  const owner = {};
  const uses = {};
  const pairs = new Set();
  const lists = { train: [], dev: [], heldout: [], test: [] };
  const BASE = { train: 910000, dev: 920000, heldout: 930000, test: 940000 };
  const PRE = { train: "T", dev: "D", heldout: "H", test: "X" };
  const tooClose = (id, k) => separation > 0 && Object.keys(owner).some((o) => owner[o] !== k && v.dist(world.nodes[o], world.nodes[id]) < separation);
  const fits = (c, k) => [c.start, c.goal].every((id) => (owner[id] === k || (owner[id] === undefined && !tooClose(id, k))) && (uses[`${k}:${id}`] || 0) < maxUses);
  const stuck = new Set();
  for (;;) {
    const open = SET_ORDER.filter((k) => lists[k].length < want[k] && !stuck.has(k));
    if (!open.length) break;
    const k = open.reduce((a, b) => (lists[b].length / want[b] < lists[a].length / want[a] ? b : a));
    let pick = null, pickNew = 3;
    for (const c of cands) {
      if (pairs.has([c.start, c.goal].sort().join("|")) || !fits(c, k)) continue;
      const fresh = (owner[c.start] === undefined) + (owner[c.goal] === undefined);
      if (fresh < pickNew) { pick = c; pickNew = fresh; if (!fresh) break; }
    }
    if (!pick) { stuck.add(k); continue; }
    pairs.add([pick.start, pick.goal].sort().join("|"));
    for (const id of [pick.start, pick.goal]) { owner[id] = k; uses[`${k}:${id}`] = (uses[`${k}:${id}`] || 0) + 1; }
    const base = BASE[k] + windOffset + lists[k].length * 10;
    lists[k].push({ id: `${idPrefix}${PRE[k]}${lists[k].length + 1}`, ...pick, seeds: [base + 1, base + 2] });
  }
  for (const k of SET_ORDER) if (lists[k].length < want[k]) throw new Error(`node-disjoint sets: only ${lists[k].length} of ${want[k]} ${k} routes fit (seed ${seed}, separation ${separation}, maxUses ${maxUses}); try another seed, a smaller set or a larger maxUses`);
  return { ...lists, nCandidates: cands.length, waypoints: Object.fromEntries(SET_ORDER.map((k) => [k, Object.keys(owner).filter((id) => owner[id] === k).sort()])), rule: { disjoint: "every waypoint belongs to at most one set", separation, maxUses, seed } };
}

// The check, usable on any sets (also the published ones): returns the routes
// of `of` that touch a waypoint used by `against`, and the smallest distance
// between endpoints of the two sets.
export function sharedEndpoints(world, sets, against = "train", of = "test") {
  const ends = [...new Set(sets[against].flatMap((s) => [s.start, s.goal]))];
  const has = new Set(ends);
  const shared = sets[of].filter((s) => has.has(s.start) || has.has(s.goal)).map((s) => s.id);
  let nearest = Infinity;
  for (const s of sets[of]) for (const e of [s.start, s.goal]) for (const t of ends) nearest = Math.min(nearest, v.dist(world.nodes[e], world.nodes[t]));
  return { shared, nearest_m: Math.round(nearest * 10) / 10 };
}
