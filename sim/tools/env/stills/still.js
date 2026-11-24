// Render establishing stills of a scanned environment (render only; nothing
// here touches the simulation). Driven by sim/tools/env/render_stills.mjs:
// ?splat=<url>&scale=<s>&rot=<x,y,z>; then window.shoot({position, target, fov})
// resolves once the splat has fully streamed for that view.
import * as pc from "../node_modules/playcanvas/build/playcanvas.min.mjs";

const q = new URLSearchParams(location.search);
const canvas = document.querySelector("canvas");
const app = new pc.Application(canvas, { graphicsDeviceOptions: { antialias: true, alpha: false, preserveDrawingBuffer: true } });
app.setCanvasFillMode(pc.FILLMODE_NONE); app.setCanvasResolution(pc.RESOLUTION_FIXED, 1280, 720);
app.graphicsDevice.maxPixelRatio = 1;
const camera = new pc.Entity("camera");
camera.addComponent("camera", { clearColor: new pc.Color(0.71, 0.80, 0.89), nearClip: 0.05, farClip: 1000, fov: 60 });
app.root.addChild(camera);
let frameReady = false, pending = 1;
app.systems.gsplat.on("frame:ready", (_c, _l, ready, count) => { frameReady = ready; pending = ready ? count : Math.max(1, count); });
app.start();

const asset = new pc.Asset("scan", "gsplat", { url: q.get("splat") });
app.assets.add(asset);
await new Promise((res, rej) => { asset.ready(res); asset.on("error", rej); app.assets.load(asset); });
const scan = new pc.Entity("scan");
const rot = (q.get("rot") || "0,0,180").split(",").map(Number), s = Number(q.get("scale") || 1);
scan.setLocalEulerAngles(...rot); scan.setLocalScale(s, s, s);
scan.addComponent("gsplat", { asset, unified: true, lodBaseDistance: 14, lodMultiplier: 2 });
if (asset.resource.octree) { scan.gsplat.lodRangeMin = 0; scan.gsplat.lodRangeMax = 0; }
app.root.addChild(scan);

const frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
window.shoot = async ({ position, target, fov = 60 }) => {
  camera.camera.fov = fov;
  camera.setPosition(...position); camera.lookAt(...target);
  frameReady = false;
  const t0 = performance.now();
  // Wait until every streamed chunk for this view is resident (or 25 s).
  let stable = 0;
  while (performance.now() - t0 < 25000) { await frames(2); stable = frameReady ? stable + 1 : 0; if (stable >= 6) break; }
  await frames(4);
  return { ready: stable >= 6, ms: Math.round(performance.now() - t0), pending };
};
window.__loaded = true;
