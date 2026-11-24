// The simulator's voxel map of the factory, drawn under the scan: one
// instanced 0.25 m cube per exposed cell, with the same roof and south-wall
// cut as the splat (factory-assets.js cutShader). A second camera copies the
// audience camera every frame and repaints the screen right of a split x
// (scissor), so the view can wipe between the scan and what the simulator
// flies through.
//   view "scan"   split = 1 (scan only)
//   view "voxels" split = 0 (voxels only)
//   view "wipe"   split sweeps 1 → 0 → 1 on a loop; wipeOnce() plays one pass
//   view "split"  split held where setSplit() put it
// Capture mode (factory-replay.js) drives the wipe clock with setWipeTime().
const MAP_URL = "maps/factory-full.json";
const WIPE = { hold: 0.6, sweep: 2.0, rest: 1.0 }; // seconds
const WIPE_PERIOD = 2 * (WIPE.hold + WIPE.sweep) + WIPE.rest;
const southWallZ = (x) => 11.8 - 0.035 * x;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// Split x (1 = all scan) at time t into one wipe pass.
export function wipeSplit(t) {
  t = clamp(t, 0, WIPE_PERIOD);
  const a = WIPE.hold, b = a + WIPE.sweep, c = b + WIPE.rest, d = c + WIPE.sweep;
  if (t < a) return 1;
  if (t < b) return 1 - ease((t - a) / WIPE.sweep);
  if (t < c) return 0;
  if (t < d) return ease((t - c) / WIPE.sweep);
  return 1;
}

export function createVoxelView(ctx, { capture = false } = {}) {
  const { pc, app, camera } = ctx;
  const main = document.querySelector("main");
  const cutInput = document.getElementById("cut");
  const layers = app.scene.layers;
  const world = layers.getLayerByName("World");
  const voxLayer = new pc.Layer({ name: "Voxels" });
  layers.insert(voxLayer, layers.layerList.indexOf(world) + 1);
  const sun = app.root.findByName("Window light");
  if (sun?.light) sun.light.layers = [...sun.light.layers, voxLayer.id];

  // Draws after the audience camera, clearing and painting only its scissor.
  const overlayIds = ["Immediate", "UI"].map((n) => layers.getLayerByName(n)?.id).filter((id) => id !== undefined);
  const camV = new pc.Entity("Voxel camera");
  camV.addComponent("camera", {
    clearColor: camera.camera.clearColor.clone(), nearClip: camera.camera.nearClip, farClip: camera.camera.farClip,
    layers: [voxLayer.id, ...overlayIds], priority: (camera.camera.priority || 0) + 1,
  });
  camV.camera.camera._scissorRectClear = true;
  camV.enabled = false;
  app.root.addChild(camV);

  // The glowing edge at the split, as a DOM line over the canvas.
  const edge = document.createElement("div");
  edge.className = "vox-edge";
  edge.hidden = true;
  main.appendChild(edge);

  // Stand-ins for the actors: physical size, but never smaller than a few
  // pixels in the wide shots.
  const sphere = (name, rgb, glow) => {
    const m = new pc.StandardMaterial();
    m.diffuse = new pc.Color(...rgb);
    m.emissive = new pc.Color(...glow);
    m.update();
    const e = new pc.Entity(name);
    e.addComponent("render", { type: "sphere", material: m, layers: [voxLayer.id] });
    app.root.addChild(e);
    return { e, m, glow };
  };
  const droneBall = sphere("Drone voxel", [0.3, 0.89, 1], [0.1, 0.35, 0.42]);
  const birdBall = sphere("Bird voxel", [1, 0.3, 0.25], [0.45, 0.08, 0.05]);
  let radii = { drone: 0.25, bird: 0.35 };

  // ---- the grid ----
  let grid = null; // decoded occupancy
  let loading = null;
  let root = null;
  let buffers = [];
  let builtCut = null;
  async function load() {
    const map = await (await fetch(MAP_URL)).json();
    if (map.physics) radii = { drone: map.physics.droneRadius, bird: map.physics.birdRadius };
    const { origin, cell, dims, firstValue, runs } = map.voxels;
    const [nx, ny, nz] = dims;
    const occ = new Uint8Array(nx * ny * nz);
    let off = 0;
    let val = firstValue;
    for (const n of runs) {
      if (val) occ.fill(1, off, off + n);
      off += n;
      val = 1 - val;
    }
    grid = { origin, cell, nx, ny, nz, occ };
  }
  function build(roof) {
    const { origin: o, cell: c, nx, ny, nz, occ } = grid;
    const idx = (x, y, z) => x + nx * (y + ny * z);
    const keep = new Uint8Array(occ.length);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = idx(x, y, z);
      if (!occ[i]) continue;
      const wx = o[0] + (x + 0.5) * c, wy = o[1] + (y + 0.5) * c, wz = o[2] + (z + 0.5) * c;
      if (wy > roof || wy < -0.75 || wz > southWallZ(wx) - 0.5) continue;
      keep[i] = 1;
    }
    const K = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && keep[idx(x, y, z)];
    const rows = new Map();
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (!keep[idx(x, y, z)]) continue;
      if (K(x + 1, y, z) && K(x - 1, y, z) && K(x, y + 1, z) && K(x, y - 1, z) && K(x, y, z + 1) && K(x, y, z - 1)) continue;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(o[0] + (x + 0.5) * c, o[1] + (y + 0.5) * c, o[2] + (z + 0.5) * c);
    }
    destroy();
    const device = app.graphicsDevice;
    const mesh = pc.Mesh.fromGeometry(device, new pc.BoxGeometry());
    const s = c * 0.9;
    root = new pc.Entity("Voxels");
    for (const [y, pts] of rows) {
      const wy = o[1] + (y + 0.5) * c;
      const n = pts.length / 3;
      const data = new Float32Array(n * 16);
      for (let i = 0; i < n; i++) data.set([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], 1], i * 16);
      const vb = new pc.VertexBuffer(device, pc.VertexFormat.getDefaultInstancingFormat(device), n, { data });
      buffers.push(vb);
      // Lighter with height, the floor dark, so walls read against it.
      const k = clamp((wy + 0.5) / (Math.min(roof, 4) + 0.5), 0, 1);
      const g = wy < -0.5 ? 0.16 : 0.34 + (0.66 - 0.34) * k;
      const m = new pc.StandardMaterial();
      m.diffuse = new pc.Color(g * 0.96, g, g * 1.04);
      m.useMetalness = true;
      m.metalness = 0;
      m.gloss = 0.15;
      m.update();
      const mi = new pc.MeshInstance(mesh, m);
      mi.setInstancing(vb);
      const e = new pc.Entity();
      e.addComponent("render", { meshInstances: [mi], layers: [voxLayer.id] });
      root.addChild(e);
    }
    app.root.addChild(root);
    builtCut = roof;
  }
  function destroy() {
    root?.destroy();
    root = null;
    for (const vb of buffers) vb.destroy();
    buffers = [];
  }
  const roofNow = () => Number(cutInput?.value ?? 2.3);
  // Load and build once a non-scan view needs it; rebuild when the cut moves.
  function ensure() {
    loading ??= load();
    return loading.then(() => {
      if (builtCut !== roofNow()) build(roofNow());
    });
  }
  let rebuildTimer = 0;
  cutInput?.addEventListener("input", () => {
    if (!grid) return;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => ensure(), split < 1 ? 120 : 600);
  });

  // ---- views ----
  let view = "scan";
  let split = 1;
  let wipeT = 0;
  let once = null; // the view to return to after a one-shot wipe
  const listeners = new Set();
  const changed = () => listeners.forEach((fn) => fn(view));
  function setView(name) {
    if (!["scan", "voxels", "wipe", "split"].includes(name)) throw new Error(`unknown view ${name}`);
    view = name;
    once = null;
    if (name === "scan") split = 1;
    if (name === "voxels") split = 0;
    if (name === "wipe" && !capture) wipeT = 0;
    changed();
    return name === "scan" ? Promise.resolve() : ensure();
  }
  function setSplit(x) {
    view = "split";
    once = null;
    split = clamp(Number(x), 0, 1);
    changed();
    return split < 1 ? ensure() : Promise.resolve();
  }
  // One pass scan → voxels → scan, then back to the view it started from.
  function wipeOnce() {
    once = view === "wipe" ? "scan" : view;
    view = "wipe";
    wipeT = 0;
    changed();
    return ensure();
  }

  app.on("update", (dt) => {
    if (view !== "wipe") return;
    if (!capture) wipeT += Math.min(dt, 0.1);
    if (once && wipeT >= WIPE_PERIOD) {
      const back = once;
      once = null;
      setView(back);
      return;
    }
    split = wipeSplit(once ? wipeT : wipeT % WIPE_PERIOD);
  });

  // After factory.js has placed the audience camera for this frame.
  const rect = new pc.Vec4();
  app.on("prerender", () => {
    const on = split < 0.999 && !!root;
    camV.enabled = on;
    const showEdge = on && split > 0.001;
    edge.hidden = !showEdge;
    if (showEdge) edge.style.transform = `translateX(${(split * main.clientWidth).toFixed(1)}px)`;
    if (!on) return;
    const a = camera.camera, b = camV.camera;
    camV.setPosition(camera.getPosition());
    camV.setRotation(camera.getRotation());
    b.projection = a.projection;
    b.orthoHeight = a.orthoHeight;
    b.fov = a.fov;
    b.nearClip = a.nearClip;
    b.farClip = a.farClip;
    b.scissorRect = rect.set(split, 0, 1 - split, 1);
    const [drone, bird] = ctx.actors;
    const floor = a.projection === pc.PROJECTION_ORTHOGRAPHIC ? a.orthoHeight * 0.03 : 0;
    const dd = Math.max(2 * radii.drone, floor);
    const bd = Math.max(2 * radii.bird, floor * 1.1);
    droneBall.e.setPosition(drone.getPosition());
    droneBall.e.setLocalScale(dd, dd, dd);
    birdBall.e.setPosition(bird.getPosition());
    birdBall.e.setLocalScale(bd, bd, bd);
    const hot = ctx.birdHunting ? 1 : 0;
    if (birdBall.hot !== hot) {
      birdBall.hot = hot;
      birdBall.m.emissive = hot ? new pc.Color(0.9, 0.12, 0.08) : new pc.Color(...birdBall.glow);
      birdBall.m.update();
    }
  });

  return {
    layer: voxLayer,
    camera: camV,
    ensure,
    setView,
    setSplit,
    wipeOnce,
    wipePeriod: WIPE_PERIOD,
    // Capture: the wipe's position in seconds into its loop.
    setWipeTime(t) {
      wipeT = Math.max(0, t);
      if (view === "wipe") split = wipeSplit(once ? wipeT : wipeT % WIPE_PERIOD);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get view() {
      return view;
    },
    get split() {
      return split;
    },
    get oneShot() {
      return !!once;
    },
  };
}
