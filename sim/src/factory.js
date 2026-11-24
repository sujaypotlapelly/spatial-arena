// The published scene uses streamed PlayCanvas SOG tiles with a -90° X
// transform. Keep the camera cut in world metres across all tile LODs.
import * as pc from "https://cdn.jsdelivr.net/npm/playcanvas@2.18.0/build/playcanvas.min.mjs";
import { createCutawayCamera } from "./factory-camera.js";

import { scanUrl, colliderUrl, cutShader, loadAsset } from "./factory-assets.js";

// A repeatable visual check in the north hall. Both loops were sampled
// against Factory_collider.glb in its original world transform.
function flightPoint(angle, eagle = false) {
  const xRadius = eagle ? 3.25 : 3.5;
  const zRadius = eagle ? 1.8 : 2;
  return new pc.Vec3(-24 + xRadius * Math.cos(angle),
    (eagle ? 0.65 : 0.5) + 0.12 * Math.sin(2 * angle), -24 + zRadius * Math.sin(angle));
}

// The original collider has hundreds of thousands of triangles. Retain only
// those whose bounds meet the fixed flight and camera envelope in this hall.
function makeCameraCollider(mesh) {
  const vertices = [];
  const indices = [];
  const faces = [];
  mesh.getPositions(vertices);
  mesh.getIndices(indices);
  const offset = new pc.Vec3(-4.695, 0.438, 11.397);
  const vertex = index => new pc.Vec3(vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2]).add(offset);
  const footprint = { minX: -28, maxX: -20, minZ: -27, maxZ: -21 };
  for (let i = 0; i < indices.length; i += 3) {
    const points = [indices[i], indices[i + 1], indices[i + 2]];
    const outside = points.every(n => vertices[3 * n] + offset.x < footprint.minX)
      || points.every(n => vertices[3 * n] + offset.x > footprint.maxX)
      || points.every(n => vertices[3 * n + 2] + offset.z < footprint.minZ)
      || points.every(n => vertices[3 * n + 2] + offset.z > footprint.maxZ);
    if (outside) continue;
    faces.push(new pc.Tri(...points.map(vertex)));
  }
  const ray = new pc.Ray();
  const hit = new pc.Vec3();
  return (target, desired) => {
    ray.origin.copy(target);
    ray.direction.sub2(desired, target);
    let distance = ray.direction.length();
    ray.direction.normalize();
    for (const face of faces) {
      if (face.intersectsRay(ray, hit)) distance = Math.min(distance, Math.max(.05, hit.distance(target) - .12));
    }
    return desired.copy(ray.direction).mulScalar(distance).add(target);
  };
}

export async function startFactory() {
  const el = id => document.getElementById(id);
  const canvas = el("factoryCanvas");
  const app = new pc.Application(canvas, { graphicsDeviceOptions: { antialias: false, alpha: false } });
  app.graphicsDevice.maxPixelRatio = Math.min(devicePixelRatio, 1.5);
  const resize = () => app.graphicsDevice.resizeCanvas(canvas.clientWidth, canvas.clientHeight);
  new ResizeObserver(resize).observe(canvas);
  resize();

  app.scene.ambientLight = new pc.Color(.66, .68, .71);
  const sun = new pc.Entity("Window light");
  sun.addComponent("light", { type: "directional", intensity: 1.3, color: new pc.Color(1, .95, .87) });
  sun.setEulerAngles(50, 32, 0);
  app.root.addChild(sun);
  const camera = new pc.Entity("Audience camera");
  camera.addComponent("camera", { clearColor: new pc.Color(.07, .08, .09), nearClip: .05, farClip: 220, fov: 68 });
  app.root.addChild(camera);
  app.start();

  const [scan, colliderFile, droneFile, eagleFile] = await Promise.all([
    loadAsset(pc, app, "Factory", "gsplat", scanUrl),
    loadAsset(pc, app, "Factory collider", "container", colliderUrl),
    loadAsset(pc, app, "DJI FPV", "container", "assets/flight/dji-fpv.glb"),
    loadAsset(pc, app, "White Eagle", "container", "assets/flight/white-eagle.glb"),
  ]);
  const building = new pc.Entity("Factory");
  building.setEulerAngles(-90, 0, 0);
  // ?lod=N raises the full-detail distance (default 7 m) for renders shot from the overhead cutaway, which sits ~60 m away.
  building.addComponent("gsplat", { asset: scan, unified: true, lodBaseDistance: Number(new URLSearchParams(location.search).get("lod")) || 7, lodMultiplier: 2 });
  const gs = building.gsplat;
  gs.lodRangeMin = 2;
  gs.lodRangeMax = scan.resource.octree.lodLevels - 1;
  const material = app.scene.gsplat.material;
  material.getShaderChunks(pc.SHADERLANGUAGE_GLSL).set("gsplatModifyVS", cutShader);
  material.update();
  app.root.addChild(building);

  // Raycast the physical shell when placing the chase camera. Its triangles
  // retain the source scene transform in either view.
  const collider = colliderFile.resource.renders[0].resource.meshes[0];
  const chaseCameraPosition = makeCameraCollider(collider);

  const actors = [droneFile, eagleFile].map(file => {
    const anchor = new pc.Entity();
    const visual = file.resource.instantiateRenderEntity();
    anchor.addChild(visual);
    app.root.addChild(anchor);
    return { anchor, visual };
  });
  const drone = actors[0].anchor;
  const eagle = actors[1].anchor;
  const birdVisual = actors[1].visual;
  birdVisual.addComponent("anim", { activate: true });
  birdVisual.anim.assignAnimation("Flight", eagleFile.resource.animations[0].resource);
  const RED_BIRD = new URLSearchParams(location.search).get("redbird") === "1";
  // While the bird hunts it is marked (rings, line, label); ?redbird=1 also tints it.
  const birdLooks = [];
  for (const render of birdVisual.findComponents("render")) {
    for (const mi of render.meshInstances) {
      mi.material = mi.material.clone();
      birdLooks.push({ material: mi.material, diffuse: mi.material.diffuse.clone(), emissive: mi.material.emissive.clone() });
    }
  }
  let birdHunting = false;
  function setBirdHunting(on) {
    if (on === birdHunting) return;
    birdHunting = on;
    for (const { material, diffuse, emissive } of birdLooks) {
      // The bird keeps its own look by default (the rings, line and label mark
      // the hunt); ?redbird=1 tints it red while hunting.
      const red = on && RED_BIRD;
      material.diffuse.copy(red ? new pc.Color(1, .28, .22) : diffuse);
      material.emissive.copy(red ? new pc.Color(.45, .06, .04) : emissive);
      material.update();
    }
  }

  let shot = "angled";
  let playing = true;
  let elapsed = 0;
  // factory-replay.js turns this off and drives the actors from recordings.
  let scripted = true;
  const cut = el("cut");
  const overhead = () => shot !== "chase";
  // The replay's chase flies above the cut, so it keeps the roof off.
  const cutOn = () => overhead() || !scripted;
  function applyCut() {
    el("cutValue").value = Number(cut.value).toFixed(1) + " m";
    material.setParameter("roofHeight", cutOn() ? Number(cut.value) : 1e6);
    material.update();
  }
  const shotButtons = document.querySelectorAll("[data-shot]");
  function markShot(selected) {
    if (shot === selected) return;
    shot = selected;
    // Re-query: the control panel adds its own shot buttons later.
    for (const button of document.querySelectorAll("[data-shot]")) button.setAttribute("aria-pressed", String(button.dataset.shot === shot));
  }
  const navigation = createCutawayCamera(canvas, camera, markShot);
  function selectCamera(selected) {
    markShot(selected);
    navigation.select(shot);
    el("navHint").hidden = !overhead();
    el("cutControl").hidden = !cutOn();
    el("trailControl").hidden = !cutOn();
    camera.camera.projection = overhead() ? pc.PROJECTION_ORTHOGRAPHIC : pc.PROJECTION_PERSPECTIVE;
    // The overhead shots sit ~60 m out and get coarse LOD anyway. The chase
    // flies metres from the walls: left at LOD 0 it streams tiles and pops at
    // every LOD boundary as it moves. LOD 3 everywhere inside the building
    // has no boundaries to cross and is all loaded with the overview.
    // (The LOD range is read from scene.gsplat, not the component.)
    app.scene.gsplat.lodRangeMin = overhead() ? 0 : 3;
    applyCut();
  }
  for (const button of shotButtons) button.onclick = () => selectCamera(button.dataset.shot);
  cut.oninput = applyCut;
  el("playback").onclick = () => {
    playing = !playing;
    birdVisual.anim.speed = playing ? 1 : 0;
    el("playback").textContent = playing ? "Pause flight" : "Resume flight";
  };
  selectCamera("angled");

  app.systems.gsplat.on("frame:ready", (_camera, _layer, ready, pending) => {
    if (ready && pending === 0) el("factoryStatus").hidden = true;
  });
  const trailColors = [new pc.Color(.22, .86, .84), new pc.Color(1, .68, .28)];
  app.on("update", dt => {
    if (playing) elapsed += Math.min(dt, 0.1);
    const angle = elapsed * 0.46;
    if (scripted) for (const [i, { anchor: actor }] of actors.entries()) {
      const a = angle - i * 0.72;
      const pos = flightPoint(a, i === 1);
      const ahead = flightPoint(a + .01, i === 1);
      actor.setPosition(pos);
      actor.setEulerAngles(0, Math.atan2(ahead.x - pos.x, ahead.z - pos.z) * pc.math.RAD_TO_DEG, i ? -7 : -4);
      if (overhead() && el("trails").checked) {
        let last = pos;
        for (let j = 1; j <= 32; j++) {
          const point = flightPoint(a - j * .055, i === 1);
          app.drawLine(last, point, trailColors[i], false);
          last = point;
        }
      }
    }
  });
  // Replay sets both actor positions during update. Track the finished frame.
  // A camera override (the replay's chase, capture mode) places the camera
  // itself when it returns true.
  let cameraOverride = null;
  app.on("prerender", () => {
    if (cameraOverride?.(shot)) return;
    if (overhead()) {
      navigation.update(drone.getPosition(), eagle.getPosition());
    } else if (scripted) {
      const target = drone.getPosition();
      const eye = flightPoint(elapsed * 0.46 - 1.27);
      eye.y = target.y + .64;
      camera.setPosition(chaseCameraPosition(target, eye));
      camera.lookAt(target);
    }
  });
  return {
    pc,
    app,
    camera,
    actors: actors.map(({ anchor }) => anchor),
    birdVisual,
    navigation,
    selectCamera,
    get shot() { return shot; },
    setScripted(on) {
      scripted = on;
      el("chase").disabled = !on;
      applyCut();
    },
    setCameraOverride(fn) {
      cameraOverride = fn;
    },
    setBirdHunting,
    get birdHunting() { return birdHunting; },
  };
}
