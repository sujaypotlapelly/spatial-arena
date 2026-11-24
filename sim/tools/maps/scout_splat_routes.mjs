// Scout geometric start/goal pairs in a downloaded SuperSplat voxel collider.
// This tool does not call a model or simulate a flight. diagnosticPath is a
// privileged connectivity check; a model receives only start and goal.
//   node sim/tools/maps/scout_splat_routes.mjs --scene canyon --out cache/splat-scenes/canyon/route-scout.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SplatVoxels } from '../../src/splat_voxels.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const option = (key, fallback) => {
  const i = args.indexOf(key);
  return i < 0 ? fallback : args[i + 1];
};
const id = option('--scene', 'canyon');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'sim/scenes/rescue-scenes.json')));
const scene = manifest.scenes.find(s => s.id === id);
if (!scene?.assets.collisionBinaryUrl) throw new Error(`No SuperSplat voxel collider configured for ${id}`);
const cache = path.resolve(root, option('--cache', scene.assets.cacheDirectory));
const meta = JSON.parse(fs.readFileSync(path.join(cache, 'scene.voxel.json')));
const collider = new SplatVoxels(meta, fs.readFileSync(path.join(cache, 'scene.voxel.bin')), {
  transform: scene.transform.collision,
  outsideSolid: true,
});
const bounds = JSON.parse(option('--bounds', JSON.stringify(scene.flightBounds)));
const cell = Number(option('--cell', '.6'));
const radius = Number(option('--radius', '.25'));
const groundGap = Number(option('--ground-gap', '3'));
if (!(cell > 0 && radius > 0 && groundGap > radius)) throw new Error('Invalid scout cell, radius, or ground gap');
const dims = bounds.min.map((v, k) => Math.floor((bounds.max[k] - v) / cell) + 1);
const size = dims.reduce((a, b) => a * b, 1);
if (dims.some(v => v <= 0) || size > 250_000) throw new Error(`Scout crop needs ${size} cells; limit is 250000. Narrow the bounds or increase --cell.`);
const index = (x, y, z) => x + dims[0] * (y + dims[1] * z);
const coord = i => {
  const x = i % dims[0], y = Math.floor(i / dims[0]) % dims[1], z = Math.floor(i / (dims[0] * dims[1]));
  return [x, y, z];
};
const point = i => coord(i).map((v, k) => bounds.min[k] + v * cell);
const distance = (a, b) => Math.hypot(...a.map((v, k) => v - b[k]));
const free = new Uint8Array(size);
const slices = [];
const supported = p => {
  for (let drop = radius + .1; drop <= groundGap; drop += .2) {
    if (collider.isOccupied([p[0], p[1] - drop, p[2]])) return true;
  }
  return false;
};
let freeCount = 0;
for (let y = 0; y < dims[1]; y++) {
  let count = 0;
  for (let z = 0; z < dims[2]; z++) for (let x = 0; x < dims[0]; x++) {
    const i = index(x, y, z), p = point(i);
    if (collider.sphereHits(p, radius) || !supported(p)) continue;
    free[i] = 1; count++; freeCount++;
  }
  slices.push({ y: bounds.min[1] + y * cell, freeSupportedCells: count });
}
if (!freeCount) throw new Error('No supported free cells in the scout crop. Inspect crop, scale, and collider alignment.');
const anchor = JSON.parse(option('--anchor', JSON.stringify(scene.camera.position)));
let startIndex = -1, nearest = Infinity;
for (let i = 0; i < size; i++) {
  if (!free[i]) continue;
  const d = distance(point(i), anchor);
  if (d < nearest) { nearest = d; startIndex = i; }
}
const clear = (a, b) => {
  const steps = Math.ceil(distance(a, b) / Math.min(.1, radius * .4));
  for (let t = 0; t <= steps; t++) {
    const p = a.map((v, k) => v + (b[k] - v) * (steps ? t / steps : 0));
    if (collider.sphereHits(p, radius)) return false;
  }
  return true;
};
const visited = new Uint8Array(size), previous = new Int32Array(size).fill(-1), steps = new Int32Array(size);
const queue = new Int32Array(size); let head = 0, tail = 1;
queue[0] = startIndex; visited[startIndex] = 1;
const moves = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
while (head < tail) {
  const i = queue[head++], xyz = coord(i), a = point(i);
  for (const delta of moves) {
    const c = xyz.map((v, k) => v + delta[k]);
    if (c.some((v, k) => v < 0 || v >= dims[k])) continue;
    const j = index(...c);
    if (visited[j] || !free[j]) continue;
    // Endpoints alone can bridge a thin occupied feature between grid samples.
    if (!clear(a, point(j))) continue;
    visited[j] = 1; previous[j] = i; steps[j] = steps[i] + 1; queue[tail++] = j;
  }
}
const start = point(startIndex);
const viewDirection = scene.camera.target.map((v, k) => v - scene.camera.position[k]);
const ranked = [];
for (let n = 0; n < tail; n++) {
  const i = queue[n], goal = point(i), directDistance = distance(start, goal);
  if (directDistance < 4 || directDistance > 24 || steps[i] * cell > 55) continue;
  if (Math.abs(goal[1] - start[1]) > 3) continue;
  if (goal.some((v, k) => v < bounds.min[k] + cell || v > bounds.max[k] - cell)) continue;
  if (goal.reduce((sum, v, k) => sum + (v - start[k]) * viewDirection[k], 0) <= 0) continue;
  ranked.push({ i, goal, directDistance, gridLength: steps[i] * cell });
}
ranked.sort((a, b) => (b.gridLength - b.directDistance) - (a.gridLength - a.directDistance));
const routes = [];
const inspected = [];
for (const candidate of ranked.slice(0, 160)) {
  if (clear(start, candidate.goal)) continue;
  const chain = [];
  for (let i = candidate.i; i >= 0; i = previous[i]) chain.push(point(i));
  chain.reverse();
  const diagnosticPath = [chain[0]];
  let current = 0;
  while (current < chain.length - 1) {
    let next = chain.length - 1;
    while (next > current + 1 && !clear(chain[current], chain[next])) next--;
    diagnosticPath.push(chain[next]); current = next;
  }
  const pathLength = diagnosticPath.slice(1).reduce((sum, p, k) => sum + distance(p, diagnosticPath[k]), 0);
  inspected.push({
    start, goal: candidate.goal, droneRadius: radius, goalRadius: .6, timeLimitSeconds: 90,
    status: 'geometric-connectivity-only; no model flight recorded; physical scale uncalibrated',
    diagnosticPath,
    checks: { startClear: true, goalClear: true, directPathClear: false, pathClear: true, pathLength,
      straightDistance: candidate.directDistance, detourFactor: pathLength / candidate.directDistance,
      sampleStep: Math.min(.1, radius * .4), supportWithin: groundGap },
  });
}
inspected.sort((a, b) => b.checks.detourFactor - a.checks.detourFactor || b.checks.pathLength - a.checks.pathLength);
for (const route of inspected) {
  if (routes.length >= 3) break;
  if (routes.some(r => distance(r.goal, route.goal) < 2)) continue;
  routes.push({ id: `${id}-scout-${routes.length + 1}`, ...route });
}
const report = {
  version: 1, sceneId: id, coordinateFrame: 'scene engine world', physicalScaleCalibrated: false,
  bounds, cell, droneRadius: radius, groundGap, dims, freeSupportedCells: freeCount,
  reachableSupportedCells: tail, cameraAnchor: anchor, anchorSnapDistance: nearest,
  slices, routes,
  warning: 'Geometric scout only. Verify against visible surfaces before simulation. diagnosticPath must not be provided to a model as a route or autopilot.',
};
const out = path.resolve(root, option('--out', `${scene.assets.cacheDirectory}/route-scout.json`));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ out, freeSupportedCells: freeCount, reachableSupportedCells: tail, anchorSnapDistance: nearest,
  routes: routes.map(({ id, start, goal, checks }) => ({ id, start, goal, checks })), slices }, null, 2));
