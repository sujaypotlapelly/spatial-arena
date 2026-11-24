#!/usr/bin/env node
// Count a scanned scene's opaque splat points per 0.25-unit cell, in the
// collider's own (source) frame, so admit.mjs can tell captured space from
// space the camera never saw. The v4 canyon search failed because targets sat
// in hollows with no scan points; this is the data that catches that.
//
//   node sim/tools/env/scan_density.mjs canyon
//
// Reads the cached streamed-SOG scene (cache/splat-scenes/<scene>/assets, from
// cache_splat_scene.mjs), decodes the finest level in headless Chrome, and
// writes cache/splat-scenes/<scene>/density.json. Install the optional browser tools in this directory first.
// The point convention is shared with the collision builder:
// SOG splats sit 180 degrees about Z from the collider frame, so x and y flip.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { root, loadManifests } from "./manifests.mjs";

export const DENSITY_CELL = 0.25;
export const densityFile = (sceneId) => path.join(root, "cache/splat-scenes", sceneId, "density.json");

export function readDensity(sceneId) {
  const f = densityFile(sceneId);
  if (!fs.existsSync(f)) return null;
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  return { cell: d.cell, counts: new Map(d.cells), meta: d.meta ?? null };
}

// Splat points within `radius` source units of a source-frame point.
export function pointsNear(density, q, radius) {
  const { cell, counts } = density;
  const r = Math.max(0, Math.ceil(radius / cell));
  const c = q.map((x) => Math.floor(x / cell));
  let n = 0;
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
    n += counts.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? 0;
  }
  return n;
}

async function main() {
  const sceneId = process.argv[2];
  if (!sceneId) { console.error("usage: node sim/tools/env/scan_density.mjs <scene>"); process.exit(2); }
  const scene = loadManifests().scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`no scene manifest "${sceneId}"`);
  const cacheDir = scene.registry.assets?.cacheDirectory ?? `cache/splat-scenes/${sceneId}`;
  const assets = path.join(cacheDir, "assets");
  const streamed = fs.existsSync(path.join(root, assets, "lod-meta.json"));
  if (!streamed && !fs.existsSync(path.join(root, assets, "meta.json"))) throw new Error(`${assets}/lod-meta.json (or meta.json) is missing; cache the scene with sim/tools/maps/cache_splat_scene.mjs first`);
  const { chromium } = await import("playwright");
  const server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200); fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const CHROME = process.env.CHROME || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/sim/environments/registry-headers.json`);
  const out = await page.evaluate(async ({ base, C, streamed }) => {
    // Streamed SOG: the finest level's chunks ("0_*/meta.json"). Single SOG: one meta.json at the root.
    const lod = streamed ? await (await fetch(`${base}/lod-meta.json`)).json() : { filenames: ["0_root/meta.json"] };
    const px = async (u) => { const b = await createImageBitmap(await (await fetch(u)).blob()); const c = new OffscreenCanvas(b.width, b.height); const g = c.getContext("2d"); g.drawImage(b, 0, 0); return g.getImageData(0, 0, b.width, b.height).data; };
    const counts = new Map();
    let points = 0, opaque = 0;
    for (const name of lod.filenames.filter((f) => f.startsWith("0_"))) {
      const dir = streamed ? `${base}/${name.slice(0, name.lastIndexOf("/"))}` : base;
      const meta = await (await fetch(streamed ? `${base}/${name}` : `${base}/meta.json`)).json();
      const [ml, mu, sh] = await Promise.all(["means_l.webp", "means_u.webp", "sh0.webp"].map((f) => px(`${dir}/${f}`)));
      const { mins, maxs } = meta.means;
      for (let i = 0; i < meta.count; i++) {
        points++;
        const o = i * 4;
        if (sh[o + 3] < 90) continue;
        opaque++;
        const p = [0, 1, 2].map((k) => { const q = (mu[o + k] << 8) | ml[o + k]; const n = mins[k] + ((maxs[k] - mins[k]) * q) / 65535; return Math.sign(n) * (Math.exp(Math.abs(n)) - 1); });
        const key = `${Math.floor(-p[0] / C)},${Math.floor(-p[1] / C)},${Math.floor(p[2] / C)}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return { cell: C, meta: { points, opaque, level: "0_" }, cells: [...counts.entries()] };
  }, { base: `/${assets}`, C: DENSITY_CELL, streamed });
  await browser.close(); server.close();
  out.meta = { ...out.meta, scene: sceneId, frame: "collider source frame (SOG x and y flipped)", createdAt: new Date().toISOString() };
  fs.writeFileSync(densityFile(sceneId), JSON.stringify(out));
  console.log(`${sceneId}: ${out.meta.opaque} opaque of ${out.meta.points} points in ${out.cells.length} cells -> ${path.relative(root, densityFile(sceneId))}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch((e) => { console.error(e.message); process.exit(1); });
