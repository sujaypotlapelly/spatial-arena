#!/usr/bin/env node
// Propose a flight volume for a scanned environment: the region of ground the
// scan actually captured, plus a height band above that ground. Writes the
// ground mask for build_splat_map.mjs and a top-down preview for a person to
// approve. It changes no map; applying the volume is a separate, reviewed step.
//
//   node sim/tools/env/suggest_volume.mjs canyon5 --agl 8 --close 2 --margin 0.8 --out canyon-v5b
//
// How the region is chosen, from the environment's current map:
//  1. Every column with open-sky ground is marked captured if the scan's own
//     collider surface lies under it and carries enough scan points (the same
//     rule as admit.mjs: at least 5% of the scene's median on real ground).
//  2. Small holes and gaps up to --close metres are closed, so a patch of thin
//     capture inside good ground doesn't split the region.
//  3. The connected region containing the launch point is kept.
//  4. It is shrunk by --margin metres, so routes don't run along its edge.
// The height band is --agl metres above the terrain, applied by the existing
// altitude fence in build_splat_map.mjs.
import fs from "node:fs";
import path from "node:path";
import { loadManifests, environment, root, DIR } from "./manifests.mjs";
import { loadWorld, sourceMapper, capturedModel } from "./gates.mjs";
import { readDensity } from "./scan_density.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const id = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
if (!id) { console.error("usage: node sim/tools/env/suggest_volume.mjs <environment> [--agl 8] [--close 2] [--margin 0.8] [--out <build-id>]"); process.exit(2); }
const AGL = Number(opt("--agl", 8)), CLOSE = Number(opt("--close", 2)), MARGIN = Number(opt("--margin", 0.8));
// --targets-only: run on the FINAL map (already inside its volume) and rewrite
// only the target mask, so targets are judged on the ground they'll sit on.
const TARGETS_ONLY = args.includes("--targets-only");

const m = loadManifests();
const ctx = environment(id, m);
if (ctx.env.kind !== "scan" || !ctx.map) throw new Error(`${id} is not a scanned environment built by build_splat_map.mjs`);
const world = loadWorld(ctx.env);
const mapper = sourceMapper(ctx), density = readDensity(ctx.scene.id);
if (!mapper || !density) throw new Error(`needs the cached collider and scan density for ${ctx.scene.id}`);
const cap = capturedModel(world, mapper, density);
const G = world.map.ground;
const [NX, NZ] = G.dims, cell = G.cell;
const outBuild = opt("--out", `${ctx.map.id}-volume`);

// 1. captured ground. Each column's own open-sky floor, read from the
// occupancy grid exactly as the mission generator places targets (the map's
// ground rows are the fence's terrain, the lowest ground nearby, not this).
const { origin: VO, cell: VC, dims: [GX, GY], occ } = world.grid;
const ground = (ix, iz) => {
  const at = (y) => occ[ix + GX * (y + GY * iz)];
  let y = GY - 1;
  while (y >= 0 && at(y)) y--;             // skip sealed cells at the top
  if (y < 1) return null;                  // sealed to the bottom: no ground
  while (y > 0 && !at(y - 1)) y--;         // down through the topmost free interval
  return y < 1 ? null : VO[1] + y * VC;
};
if (VC !== cell || VO[0] !== G.origin[0] || VO[2] !== G.origin[1]) throw new Error("ground rows and occupancy grid are not aligned");
const captured = new Uint8Array(NX * NZ), hasGround = new Uint8Array(NX * NZ);
for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX; ix++) {
  const y = ground(ix, iz);
  if (y == null) continue;
  hasGround[ix + NX * iz] = 1;
  if (cap.captured([G.origin[0] + (ix + 0.5) * cell, y + 0.1, G.origin[1] + (iz + 0.5) * cell])) captured[ix + NX * iz] = 1;
}

// Square-structuring-element morphology on the column grid.
function morph(src, r, dilate) {
  const out = new Uint8Array(src.length);
  for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX; ix++) {
    let v = dilate ? 0 : 1;
    for (let dz = -r; dz <= r && (dilate ? !v : v); dz++) for (let dx = -r; dx <= r; dx++) {
      const X = ix + dx, Z = iz + dz;
      const s = X < 0 || Z < 0 || X >= NX || Z >= NZ ? 0 : src[X + NX * Z];
      if (dilate && s) { v = 1; break; }
      if (!dilate && !s) { v = 0; break; }
    }
    out[ix + NX * iz] = v;
  }
  return out;
}
const rc = Math.round(CLOSE / cell), rm = Math.round(MARGIN / cell);
// 2. close small holes, but never add columns that have no ground at all
let region = rc ? morph(morph(captured, rc, true), rc, false) : captured.slice();
for (let i = 0; i < region.length; i++) region[i] &= hasGround[i];

// 3. the connected region containing the launch point
const L = ctx.map.build.launch;
const lx = Math.floor((L[0] - G.origin[0]) / cell), lz = Math.floor((L[2] - G.origin[1]) / cell);
const comp = new Int32Array(NX * NZ).fill(-1);
const sizes = [];
for (let s = 0; s < region.length; s++) {
  if (!region[s] || comp[s] >= 0) continue;
  const c = sizes.length; let n = 0; const q = [s]; comp[s] = c;
  while (q.length) {
    const i = q.pop(); n++;
    const x = i % NX, z = (i / NX) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const X = x + dx, Z = z + dz; if (X < 0 || Z < 0 || X >= NX || Z >= NZ) continue;
      const j = X + NX * Z; if (region[j] && comp[j] < 0) { comp[j] = c; q.push(j); }
    }
  }
  sizes.push(n);
}
let keep = comp[lx + NX * lz];
const launchInside = keep >= 0;
if (!launchInside) keep = sizes.indexOf(Math.max(...sizes));
let volume = new Uint8Array(NX * NZ);
for (let i = 0; i < volume.length; i++) volume[i] = comp[i] === keep ? 1 : 0;
// 4. margin
if (rm) volume = morph(volume, rm, false);
if (TARGETS_ONLY) {
  // The final map's own volume: every column that still has open ground.
  volume = hasGround.slice();
}

// stats
const count = (a) => a.reduce((s, v) => s + v, 0);
const area = (n) => Math.round(n * cell * cell);
const stats = {
  groundM2: area(count(hasGround)), capturedM2: area(count(captured)), volumeM2: area(count(volume)),
  capturedShareOfGround: Math.round((count(captured) / count(hasGround)) * 1000) / 1000,
  launchInside, components: sizes.length, capturedMinPoints: cap.min, groundMedianPoints: cap.median,
};
// how the current mission targets and routes fall
const inVol = (p) => { const ix = Math.floor((p[0] - G.origin[0]) / cell), iz = Math.floor((p[2] - G.origin[1]) / cell); return ix >= 0 && iz >= 0 && ix < NX && iz < NZ && volume[ix + NX * iz] === 1; };
const targets = [];
for (const task of Object.keys(ctx.env.harness.missions ?? {})) {
  const f = path.join(root, `sim/scenarios/mission-${id}-${task}.json`);
  if (!fs.existsSync(f)) continue;
  const s = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const k of ["train", "dev", "test"]) for (const t of s[k]) targets.push({ id: t.id, p: t.targetPosition, inside: inVol(t.targetPosition) });
}
stats.currentTargetsInside = `${targets.filter((t) => t.inside).length} of ${targets.length}`;

// run-length encode, row-major over x then z
const runs = []; let cur = volume[0], n = 0;
for (const v of volume) { if (v === cur) n++; else { runs.push(n); cur = v; n = 1; } }
runs.push(n);
const volFile = path.join(root, "sim/maps/volumes", `${outBuild}.json`);
fs.mkdirSync(path.dirname(volFile), { recursive: true });
if (!TARGETS_ONLY) fs.writeFileSync(volFile, JSON.stringify({
  note: `Flight volume proposed by sim/tools/env/suggest_volume.mjs from ${ctx.env.harness.map} (environment ${id}). Columns with value 1 are inside; build_splat_map.mjs seals every other column. The height band is the map build's agl.`,
  createdAt: new Date().toISOString().slice(0, 10), source: { environment: id, map: ctx.env.harness.map },
  params: { agl: AGL, closeMetres: CLOSE, marginMetres: MARGIN, rule: "captured = scan collider surface under the column with at least capturedMinPoints scan points within 2 m" },
  stats, origin: G.origin, cell, dims: [NX, NZ], firstValue: volume[0], runs,
}) + "\n");

// Target mask: inside the volume AND captured, two cells in from any uncaptured
// column (one cell let 2 of 84 Verzasca targets land on the edge). Flights may
// cross small thin patches; targets never sit on them.
const capInner = morph(captured, 2, false);
const targetMask = new Uint8Array(NX * NZ);
for (let i = 0; i < targetMask.length; i++) targetMask[i] = volume[i] & capInner[i];
const truns = []; { let c = targetMask[0], k = 0; for (const v of targetMask) { if (v === c) k++; else { truns.push(k); c = v; k = 1; } } truns.push(k); }
const tFile = path.join(root, "sim/maps/volumes", `${outBuild}-targets.json`);
fs.writeFileSync(tFile, JSON.stringify({
  note: `Where mission targets may be placed in ${outBuild}: inside the flight volume and on captured ground, two cells in from any uncaptured column${TARGETS_ONLY ? ", judged on the final map" : ""}. Used by make_mission_sets.mjs through a mission config's targetMask.`,
  createdAt: new Date().toISOString().slice(0, 10), source: { environment: id, map: ctx.env.harness.map },
  stats: { targetM2: area(count(targetMask)) }, origin: G.origin, cell, dims: [NX, NZ], firstValue: targetMask[0], runs: truns,
}) + "\n");
stats.targetM2 = area(count(targetMask));

// preview: one SVG rect per horizontal run of the same class
const cls = (i) => (volume[i] ? "v" : captured[i] ? "c" : hasGround[i] ? "u" : "x");
const S = 2, rects = [];
for (let iz = 0; iz < NZ; iz++) {
  let ix = 0;
  while (ix < NX) {
    const k = cls(ix + NX * iz); let j = ix;
    while (j < NX && cls(j + NX * iz) === k) j++;
    if (k !== "x") rects.push(`<rect x="${ix * S}" y="${iz * S}" width="${(j - ix) * S}" height="${S}" class="${k}"/>`);
    ix = j;
  }
}
const pt = (p) => [((p[0] - G.origin[0]) / cell) * S, ((p[2] - G.origin[1]) / cell) * S];
const marks = targets.map((t) => { const [x, z] = pt(t.p); return `<circle cx="${x.toFixed(1)}" cy="${z.toFixed(1)}" r="4" class="${t.inside ? "ti" : "to"}"><title>${t.id}</title></circle>`; }).join("");
const [lxp, lzp] = pt(L);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${outBuild} flight volume</title><style>
:root{--bg:#fbfbfa;--ink:#1d2224;--muted:#5d6669;--line:#dfe3e3}@media (prefers-color-scheme:dark){:root{--bg:#141718;--ink:#e6e9ea;--muted:#9aa4a7;--line:#2f3538}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,sans-serif}main{max-width:1000px;margin:0 auto;padding:24px 16px}
svg{width:100%;height:auto;background:#0e1112;border-radius:8px}.v{fill:#16a34a}.c{fill:#86efac;fill-opacity:.45}.u{fill:#6b7280;fill-opacity:.55}.ti{fill:#fff;stroke:#111;stroke-width:1}.to{fill:#ef4444;stroke:#fff;stroke-width:1}.l{fill:#3b82f6;stroke:#fff;stroke-width:1.5}
table{border-collapse:collapse}td{padding:3px 10px 3px 0;border-bottom:1px solid var(--line)}.muted{color:var(--muted)}
</style></head><body><main><h1>${outBuild}: proposed flight volume</h1>
<p class="muted">From ${ctx.env.harness.map}. Top-down, north up. Dark green: inside the proposed volume. Light green: captured but outside (cut off by the margin or not connected to the launch). Grey: ground the scan barely captured. Blue: launch. Dots: today's ${id} mission targets, white inside the volume, red outside. Height band: ${AGL} m above the terrain.</p>
<svg viewBox="0 0 ${NX * S} ${NZ * S}">${rects.join("")}${marks}<circle cx="${lxp}" cy="${lzp}" r="6" class="l"/></svg>
<table>${Object.entries(stats).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table></main></body></html>`;
const prev = path.join(DIR, "reports", `volume-${outBuild}.html`);
if (!TARGETS_ONLY) fs.writeFileSync(prev, html);
console.log(JSON.stringify(stats));
console.log(TARGETS_ONLY ? `wrote ${path.relative(root, tFile)} from the final map` : `wrote ${path.relative(root, volFile)} and ${path.relative(root, prev)}`);
