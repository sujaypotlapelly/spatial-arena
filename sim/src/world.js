// Collision geometry and navigation graph. No rendering code here so the
// engine can run headless in Node for tests and fast background trials.

export const v = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
  },
  clampLen: (a, m) => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > m ? [(a[0] * m) / l, (a[1] * m) / l, (a[2] * m) / l] : a;
  },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

export class World {
  constructor(map) {
    this.map = map;
    this.boxes = map.boxes;
    this.physics = map.physics;
    this.nodes = map.waypoints;
    this.nodeIds = Object.keys(map.waypoints);
    this.adj = {};
    for (const id of this.nodeIds) this.adj[id] = [];
    for (const [a, b] of map.edges) {
      if (!this.adj[a] || !this.adj[b]) throw new Error(`edge references unknown node ${a}-${b}`);
      this.adj[a].push(b);
      this.adj[b].push(a);
    }
    const { min, max } = map.bounds;
    this.bounds = { min, max };
    // Optional voxel occupancy grid (maps built from a scan's collision mesh).
    if (map.voxels) {
      const { origin, cell, dims, firstValue, runs } = map.voxels;
      const occ = new Uint8Array(dims[0] * dims[1] * dims[2]);
      let i = 0;
      let val = firstValue;
      for (const n of runs) {
        if (val) occ.fill(1, i, i + n);
        i += n;
        val = val ? 0 : 1;
      }
      this.grid = { origin, cell, dims, occ };
    }
  }

  // Squared distance from point to an axis-aligned box (0 if inside).
  static boxDist2(p, b) {
    let d = 0;
    for (let i = 0; i < 3; i++) {
      const c = p[i] < b.min[i] ? b.min[i] - p[i] : p[i] > b.max[i] ? p[i] - b.max[i] : 0;
      d += c * c;
    }
    return d;
  }

  gridHits(p, r) {
    const { origin, cell, dims, occ } = this.grid;
    const r2 = r * r;
    const lo = [0, 1, 2].map((k) => Math.floor((p[k] - r - origin[k]) / cell));
    const hi = [0, 1, 2].map((k) => Math.floor((p[k] + r - origin[k]) / cell));
    for (let z = lo[2]; z <= hi[2]; z++)
      for (let y = lo[1]; y <= hi[1]; y++)
        for (let x = lo[0]; x <= hi[0]; x++) {
          if (x < 0 || y < 0 || z < 0 || x >= dims[0] || y >= dims[1] || z >= dims[2]) return true;
          if (!occ[x + dims[0] * (y + dims[1] * z)]) continue;
          let d2 = 0;
          for (const [k, c] of [[0, x], [1, y], [2, z]]) {
            const a = origin[k] + c * cell;
            const e = p[k] < a ? a - p[k] : p[k] > a + cell ? p[k] - a - cell : 0;
            d2 += e * e;
          }
          if (d2 < r2) return true;
        }
    return false;
  }

  sphereHits(p, r) {
    const r2 = r * r;
    for (const b of this.boxes) if (World.boxDist2(p, b) < r2) return b;
    if (this.grid && this.gridHits(p, r)) return { id: "scan", kind: "scan" };
    const { min, max } = this.bounds;
    for (let i = 0; i < 3; i++) if (p[i] - r < min[i] || p[i] + r > max[i]) return { id: "bounds", kind: "bounds" };
    return null;
  }

  // Swept-sphere clearance, sampled. Sampling step is a fraction of r so a
  // thin wall can't slip between samples.
  segmentClear(a, b, r) {
    const L = v.dist(a, b);
    const step = Math.max(0.08, r * 0.5);
    const n = Math.max(1, Math.ceil(L / step));
    for (let i = 0; i <= n; i++) if (this.sphereHits(v.lerp(a, b, i / n), r)) return false;
    return true;
  }

  // Push a sphere out of any box it overlaps (used for the bird, which
  // shouldn't pass through walls but doesn't "crash").
  // Move a sphere from `from` toward `to` without entering geometry. Box maps
  // push out of boxes (the original behaviour, kept so old recordings
  // reproduce exactly); voxel maps slide along the blocked axis.
  moveSphere(from, to, r) {
    if (!this.grid) return this.resolve(to, r);
    if (!this.sphereHits(to, r)) return to;
    for (const mask of [[1, 0, 1], [1, 1, 0], [0, 1, 1], [1, 0, 0], [0, 0, 1], [0, 1, 0]]) {
      const q = from.map((f, k) => (mask[k] ? to[k] : f));
      if (!this.sphereHits(q, r)) return q;
    }
    return from.slice();
  }

  resolve(p, r) {
    if (this.grid) return p.slice();
    let q = p.slice();
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const b of this.boxes) {
        const cp = [0, 1, 2].map((i) => Math.min(Math.max(q[i], b.min[i]), b.max[i]));
        const d = v.sub(q, cp);
        const l = v.len(d);
        if (l < r) {
          if (l > 1e-6) q = v.add(cp, v.scale(d, r / l));
          else {
            // centre inside the box: exit through nearest face
            let best = null;
            for (let i = 0; i < 3; i++) {
              for (const s of [-1, 1]) {
                const face = s < 0 ? b.min[i] - r : b.max[i] + r;
                const cost = Math.abs(face - q[i]);
                if (!best || cost < best.cost) best = { i, face, cost };
              }
            }
            q[best.i] = best.face;
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
    const { min, max } = this.bounds;
    for (let i = 0; i < 3; i++) q[i] = Math.min(Math.max(q[i], min[i] + r), max[i] - r);
    return q;
  }

  nearestVisibleNode(p, r, exclude = null) {
    const sorted = this.nodeIds
      .filter((id) => id !== exclude)
      .map((id) => [id, v.dist(p, this.nodes[id])])
      .sort((x, y) => x[1] - y[1]);
    for (const [id] of sorted.slice(0, 8)) if (this.segmentClear(p, this.nodes[id], r)) return id;
    return sorted[0][0];
  }

  // A* over the waypoint graph. nodeCost(id) adds a penalty per node.
  path(from, to, nodeCost = null) {
    const h = (id) => v.dist(this.nodes[id], this.nodes[to]);
    const g = { [from]: 0 };
    const prev = {};
    const open = new Set([from]);
    const f = { [from]: h(from) };
    while (open.size) {
      let cur = null;
      for (const id of open) if (cur === null || f[id] < f[cur]) cur = id;
      if (cur === to) {
        const out = [to];
        while (prev[out[0]]) out.unshift(prev[out[0]]);
        return out;
      }
      open.delete(cur);
      for (const nb of this.adj[cur]) {
        const cost = g[cur] + v.dist(this.nodes[cur], this.nodes[nb]) + (nodeCost ? nodeCost(nb) : 0);
        if (g[nb] === undefined || cost < g[nb]) {
          g[nb] = cost;
          prev[nb] = cur;
          f[nb] = cost + h(nb);
          open.add(nb);
        }
      }
    }
    return null;
  }

  // Simple paths from start to goal, shortest first. Used to give the model
  // (and the offline heuristic) a menu of distinct routes.
  enumerateRoutes(from, to, limit = 12, maxLen = 14) {
    const out = [];
    const walk = (node, seen, acc) => {
      if (acc.length > maxLen) return;
      if (node === to) {
        out.push(acc.slice());
        return;
      }
      for (const nb of this.adj[node]) {
        if (seen.has(nb) || nb === this.map.birdStart) continue;
        seen.add(nb);
        acc.push(nb);
        walk(nb, seen, acc);
        acc.pop();
        seen.delete(nb);
      }
    };
    walk(from, new Set([from]), [from]);
    return out
      .map((r) => ({ route: r, length: this.routeLength(r) }))
      .sort((a, b) => a.length - b.length)
      .slice(0, limit);
  }

  // Shortest path that avoids banned nodes and edges (for Yen's algorithm).
  pathAvoiding(from, to, bannedNodes, bannedEdges) {
    const h = (id) => v.dist(this.nodes[id], this.nodes[to]);
    const g = { [from]: 0 };
    const prev = {};
    const open = new Set([from]);
    const f = { [from]: h(from) };
    while (open.size) {
      let cur = null;
      for (const id of open) if (cur === null || f[id] < f[cur]) cur = id;
      if (cur === to) {
        const out = [to];
        while (prev[out[0]] !== undefined) out.unshift(prev[out[0]]);
        return out;
      }
      open.delete(cur);
      for (const nb of this.adj[cur]) {
        if (bannedNodes.has(nb) || bannedEdges.has(`${cur}>${nb}`)) continue;
        const cost = g[cur] + v.dist(this.nodes[cur], this.nodes[nb]);
        if (g[nb] === undefined || cost < g[nb]) {
          g[nb] = cost;
          prev[nb] = cur;
          f[nb] = cost + h(nb);
          open.add(nb);
        }
      }
    }
    return null;
  }

  // Yen's k shortest loop-free paths.
  kShortest(from, to, K) {
    const first = this.pathAvoiding(from, to, new Set(), new Set());
    if (!first) return [];
    const A = [first];
    const B = [];
    const seen = new Set([first.join()]);
    for (let k = 1; k < K; k++) {
      const last = A[k - 1];
      for (let i = 0; i < last.length - 1; i++) {
        const spur = last[i];
        const root = last.slice(0, i + 1);
        const bannedEdges = new Set();
        for (const p of A) if (p.slice(0, i + 1).join() === root.join() && p[i + 1]) bannedEdges.add(`${spur}>${p[i + 1]}`);
        const bannedNodes = new Set(root.slice(0, -1));
        const tail = this.pathAvoiding(spur, to, bannedNodes, bannedEdges);
        if (!tail) continue;
        const cand = [...root.slice(0, -1), ...tail];
        const key = cand.join();
        if (!seen.has(key)) {
          seen.add(key);
          B.push({ route: cand, length: this.routeLength(cand) });
        }
      }
      if (!B.length) break;
      B.sort((a, b) => a.length - b.length);
      A.push(B.shift().route);
    }
    return A.map((route) => ({ route, length: this.routeLength(route) }));
  }

  routeLength(route) {
    let L = 0;
    for (let i = 1; i < route.length; i++) L += v.dist(this.nodes[route[i - 1]], this.nodes[route[i]]);
    return L;
  }

  isValidRoute(route, start = this.map.start, goal = this.map.goal) {
    if (!Array.isArray(route) || route.length < 2) return "route must list at least two waypoints";
    if (route[0] !== start) return `route must begin at "${start}"`;
    if (route[route.length - 1] !== goal) return `route must end at "${goal}"`;
    for (let i = 0; i < route.length; i++) {
      if (!this.nodes[route[i]]) return `unknown waypoint "${route[i]}"`;
      if (i > 0 && !this.adj[route[i - 1]].includes(route[i]))
        return `no edge between "${route[i - 1]}" and "${route[i]}"`;
    }
    return null;
  }

  // Edges whose swept sphere touches geometry. Should be empty for a good map.
  blockedEdges(r) {
    return this.map.edges.filter(([a, b]) => !this.segmentClear(this.nodes[a], this.nodes[b], r));
  }
}

// A short menu of genuinely different routes (near-duplicates removed),
// each labelled by the landmarks it passes. Shown to the model and used by
// the offline heuristic.
const menuCache = new WeakMap();
export function routeMenu(world, start = world.map.start, goal = world.map.goal, limit = 8) {
  let cache = menuCache.get(world);
  if (!cache) menuCache.set(world, (cache = new Map()));
  const key = `${start}>${goal}`;
  if (!cache.has(key)) cache.set(key, buildMenu(world, start, goal, limit));
  return cache.get(key);
}

function buildMenu(world, start, goal, limit) {
  if (world.nodeIds.length > 30) return buildMenuLarge(world, start, goal, limit);
  return buildMenuSmall(world, start, goal, limit);
}

// Large graphs (scan maps): k shortest paths, then keep routes that differ
// from each other by at least 40% of their waypoints.
function buildMenuLarge(world, start, goal, limit) {
  const tags = world.map.routeTags || {};
  // Label by the hall zones a route passes through, each named once.
  const label = (r) => {
    const zones = [];
    for (const id of r) {
      const t = tags[id]?.replace(/ (high|low)$/, "");
      if (t && !zones.includes(t)) zones.push(t);
    }
    const heights = new Set(r.map((id) => tags[id]?.split(" ").pop()).filter(Boolean));
    return `${zones.join(" → ") || "direct"}${heights.has("high") ? " (partly high)" : " (low)"}`;
  };
  // Maps can ask for more candidates (map.routeMenu.candidates) when many
  // near-identical shortest paths would otherwise crowd out routes through
  // other doorways. The default keeps existing maps and recordings unchanged.
  const cands = world.kShortest(start, goal, world.map.routeMenu?.candidates ?? 40);
  const kept = [];
  for (const c of cands) {
    const set = new Set(c.route);
    const distinct = kept.every((k) => {
      const ks = new Set(k.route);
      const inter = [...set].filter((x) => ks.has(x)).length;
      return 1 - inter / new Set([...set, ...ks]).size >= 0.4;
    });
    if (distinct) kept.push({ ...c, length: Math.round(c.length * 10) / 10, label: label(c.route) });
    if (kept.length >= limit) break;
  }
  return kept.sort((a, b) => a.length - b.length).map((r, i) => ({ ...r, id: `R${i + 1}` }));
}

function buildMenuSmall(world, start, goal, limit) {
  const all = world.enumerateRoutes(start, goal, 400, 16);
  const tags = world.map.routeTags || {};
  const label = (r) => r.filter((id) => tags[id]).map((id) => tags[id]).join(" → ") || "direct";
  // One shortest route per distinct landmark sequence.
  const byLabel = new Map();
  for (const r of all) {
    const l = label(r.route);
    if (!byLabel.has(l)) byLabel.set(l, { ...r, length: Math.round(r.length * 10) / 10, label: l });
  }
  const cands = [...byLabel.values()];
  // First pass: make sure every landmark appears in at least one route.
  const kept = [];
  const covered = new Set();
  for (const c of cands) {
    const ts = c.route.filter((id) => tags[id]).map((id) => tags[id]);
    if (ts.some((t) => !covered.has(t))) {
      kept.push(c);
      ts.forEach((t) => covered.add(t));
    }
  }
  for (const c of cands) if (kept.length < limit && !kept.includes(c)) kept.push(c);
  return kept
    .sort((a, b) => a.length - b.length)
    .map((r, i) => ({ ...r, id: `R${i + 1}` }));
}

export function routeLabel(world, route) {
  const tags = world.map.routeTags || {};
  return route.filter((id) => tags[id]).map((id) => tags[id]).join(" → ") || "direct";
}

// Display-only: collapse repeated zones ("mid high → mid high → …") so long
// scan-map routes fit a caption. Prompts keep using routeLabel.
export function shortRouteLabel(world, route) {
  const tags = world.map.routeTags || {};
  const out = [];
  for (const id of route) if (tags[id] && tags[id] !== out.at(-1)) out.push(tags[id]);
  return out.join(" → ") || "direct";
}
