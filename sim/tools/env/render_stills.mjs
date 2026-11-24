#!/usr/bin/env node
// Establishing stills for scanned environments, for a person to judge the look
// (stage 3 needs footage a person signs off on; these come first).
//
//   node sim/tools/env/render_stills.mjs canyon5b verzasca     # or --all
//
// Renders the drone's-eye view from the launch point toward the volume's
// centre. Establishing and overhead cameras are computed but not rendered:
// placed automatically they look through a scan's floaters, so a person
// places them for stage 3.
// Writes sim/environments/reports/stills/<id>-<shot>.jpg (960x540).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { root, loadManifests, environment, DIR } from "./manifests.mjs";

const OUT = path.join(DIR, "reports", "stills");

export function cameras(ctx) {
  const map = JSON.parse(fs.readFileSync(path.join(root, ctx.env.harness.map), "utf8"));
  const G = map.ground, pts = [];
  G.rows.forEach((row, iz) => row && row.forEach((y, ix) => { if (y != null) pts.push([G.origin[0] + (ix + 0.5) * G.cell, y, G.origin[1] + (iz + 0.5) * G.cell]); }));
  // No terrain rows (the fence's terrain can be empty): frame on the flight graph instead.
  if (!pts.length) for (const p of Object.values(map.waypoints ?? {})) pts.push([p[0], p[1] - 1.5, p[2]]);
  if (!pts.length) throw new Error(`${ctx.env.id}: the map has neither ground rows nor waypoints`);
  const q = (k, f) => { const v = pts.map((p) => p[k]).sort((a, b) => a - b); return v[Math.floor(f * (v.length - 1))]; };
  const c = [q(0, 0.5), q(1, 0.5), q(2, 0.5)];
  const ex = q(0, 0.95) - q(0, 0.05), ez = q(2, 0.95) - q(2, 0.05), extent = Math.max(ex, ez, 20);
  const alongX = ex >= ez;
  const back = alongX ? [-1, 0] : [0, -1];
  const launch = map.launch ?? [c[0], c[1] + 1.5, c[2]];
  // Stay inside the captured envelope: scans carry floaters and distant
  // background splats, so a camera far outside the volume looks through them.
  const lo = alongX ? q(0, 0.06) : q(2, 0.06);
  const edge = alongX ? [lo, c[2]] : [c[0], lo];
  const up = Math.min(25, Math.max(8, 0.18 * extent));
  return {
    establishing: { position: [edge[0], c[1] + up, edge[1]], target: [c[0], c[1] + 1, c[2]], fov: 70 },
    "drone-eye": { position: [launch[0], launch[1], launch[2]], target: [c[0], launch[1] - 0.3, c[2]], fov: 75 },
    overhead: { position: [c[0] + back[0] * 0.15 * extent, c[1] + Math.min(30, 0.3 * extent), c[2] + back[1] * 0.15 * extent], target: [c[0], c[1], c[2]], fov: 65 },
  };
}

async function main() {
  const m = loadManifests();
  const ids = process.argv.includes("--all") ? m.envs.filter((e) => e.kind === "scan" && e.mapBuild && !e.videoOnly).map((e) => e.id) : process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!ids.length) { console.error("usage: node sim/tools/env/render_stills.mjs <environment...> | --all"); process.exit(2); }
  const { chromium } = await import("playwright");
  const server = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    const type = p.endsWith(".js") || p.endsWith(".mjs") ? "text/javascript" : p.endsWith(".html") ? "text/html" : p.endsWith(".json") ? "application/json" : p.endsWith(".webp") ? "image/webp" : "application/octet-stream";
    res.writeHead(200, { "content-type": type }); fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const CHROME = process.env.CHROME || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist", "--disable-background-timer-throttling", ...(process.platform === "darwin" ? ["--use-angle=metal"] : [])] });
  fs.mkdirSync(OUT, { recursive: true });
  const summary = {};
  for (const id of ids) {
    const ctx = environment(id, m);
    const reg = ctx.scene.registry, dir = reg.assets.cacheDirectory;
    const entry = fs.existsSync(path.join(root, dir, "assets/lod-meta.json")) ? "lod-meta.json" : "meta.json";
    const scale = (reg.transform.splat.scale ?? 1) * (ctx.map?.build?.scale ?? 1);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on("pageerror", (e) => console.error(`[${id}] page error: ${e.message}`));
    // Single (meta.json) SOG scenes don't yet render in the collider's frame here
    // (four rotations tried on 2026-11-19); skip them rather than show a wrong view.
    if (entry === "meta.json") { console.log(`[${id}] skipped: single-SOG scenes aren't rendered yet; the gallery uses the owner's poster`); continue; }
    const rot = reg.transform.splat.rotation;
    const url = `http://127.0.0.1:${server.address().port}/sim/tools/env/stills/still.html?splat=/${dir}/assets/${entry}&scale=${scale}&rot=${rot.join(",")}`;
    await page.goto(url);
    await page.waitForFunction(() => window.__loaded === true, null, { timeout: 120000 });
    summary[id] = {};
    // Only the drone's-eye view is automatic for now: it sits inside captured
    // space. Establishing shots need a person to place the camera (stage 3).
    for (const [name, cam] of Object.entries(cameras(ctx)).filter(([n]) => n === "drone-eye")) {
      const r = await page.evaluate((c) => window.shoot(c), cam);
      const file = path.join(OUT, `${id}-${name}.jpg`);
      await page.locator("canvas").screenshot({ path: file, type: "jpeg", quality: 82, scale: "css" });
      summary[id][name] = r;
      console.log(`[${id}] ${name}: ${r.ready ? "fully streamed" : "timed out streaming"} in ${(r.ms / 1000).toFixed(1)} s -> ${path.relative(root, file)}`);
    }
    await page.close();
  }
  await browser.close(); server.close();
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch((e) => { console.error(e.stack ?? e.message); process.exit(1); });
