// three.js view. Draws the building (greybox or Gaussian splat), the
// collision overlay, waypoints, agents and trajectories. All motion comes
// from the engine: either recorded frames or a live Episode.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

export const OUTCOME_COLORS = {
  reached: 0x34d399,
  intercepted: 0xf43f5e,
  crashed: 0xf59e0b,
  timeout: 0x94a3b8,
  running: 0x7dd3fc,
};

function makeDrone() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.1, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x2563eb, emissive: 0x1d4ed8, emissiveIntensity: 0.35, metalness: 0.3, roughness: 0.4 }),
  );
  g.add(body);
  const armMat = new THREE.MeshStandardMaterial({ color: 0x334155 });
  const rotorMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0ea5e9, emissiveIntensity: 0.6, transparent: true, opacity: 0.85 });
  g.rotors = [];
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.34), armMat);
    arm.position.set(x * 0.12, 0, z * 0.12);
    arm.rotation.y = Math.atan2(x, z);
    g.add(arm);
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.015, 16), rotorMat);
    rotor.position.set(x * 0.24, 0.06, z * 0.24);
    g.add(rotor);
    g.rotors.push(rotor);
  }
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.04), new THREE.MeshBasicMaterial({ color: 0x22d3ee }));
  led.position.set(0, 0.02, 0.18);
  g.add(led);
  g.scale.setScalar(1.6);
  return g;
}

function makeBird() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xdc2626, emissive: 0x7f1d1d, emissiveIntensity: 0.4, roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), mat);
  body.scale.set(0.8, 0.7, 1.6);
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 10), new THREE.MeshStandardMaterial({ color: 0xe7e5e4 }));
  head.position.set(0, 0.06, 0.24);
  g.add(head);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.1, 8), new THREE.MeshStandardMaterial({ color: 0xfacc15 }));
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.04, 0.34);
  g.add(beak);
  const wingGeo = new THREE.BufferGeometry();
  wingGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0.12, 0, 0, -0.12, 0.55, 0, -0.08], 3));
  wingGeo.computeVertexNormals();
  const wingMat = new THREE.MeshStandardMaterial({ color: 0xb91c1c, emissive: 0x7f1d1d, emissiveIntensity: 0.3, side: THREE.DoubleSide });
  g.wings = [1, -1].map((s) => {
    const pivot = new THREE.Group();
    const w = new THREE.Mesh(wingGeo, wingMat);
    w.scale.x = s;
    pivot.add(w);
    pivot.side = s;
    g.add(pivot);
    return pivot;
  });
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.22, 3), mat);
  tail.rotation.x = -Math.PI / 2;
  tail.scale.y = 1;
  tail.position.set(0, 0, -0.3);
  g.add(tail);
  g.scale.setScalar(1.5);
  return g;
}

function setOpacity(obj, opacity) {
  obj.traverse((o) => {
    if (o.material) {
      o.material = o.material.clone();
      o.material.transparent = true;
      o.material.opacity = Math.min(o.material.opacity ?? 1, opacity);
      o.material.depthWrite = opacity > 0.9;
    }
  });
}

// Frame source over recorded frames (interpolated).
export class RecordedSource {
  constructor(frames) {
    this.frames = frames;
    this.duration = frames[frames.length - 1].t;
    this.i = 0;
  }
  state(t) {
    const f = this.frames;
    if (t <= 0) return f[0];
    if (t >= this.duration) return f[f.length - 1];
    while (this.i > 0 && f[this.i].t > t) this.i--;
    while (this.i < f.length - 2 && f[this.i + 1].t < t) this.i++;
    const a = f[this.i];
    const b = f[this.i + 1];
    const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
    const L = (p, q) => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k];
    return { t, d: L(a.d, b.d), dv: L(a.dv, b.dv), b: L(a.b, b.b), bs: a.bs };
  }
  done(t) {
    return t >= this.duration;
  }
  pointsUpTo(t) {
    return this.frames.filter((f) => f.t <= t);
  }
}

// Frame source that steps a live Episode as wall-clock time advances.
export class LiveSource {
  constructor(episode) {
    this.ep = episode;
    this.rec = new RecordedSource(episode.frames);
  }
  state(t) {
    while (!this.ep.done && this.ep.t < t) this.ep.tick();
    this.rec.frames = this.ep.frames;
    this.rec.duration = this.ep.frames[this.ep.frames.length - 1].t;
    return this.rec.state(Math.min(t, this.rec.duration));
  }
  done(t) {
    return this.ep.done && t >= this.rec.duration;
  }
  get duration() {
    return this.rec.duration;
  }
  pointsUpTo(t) {
    return this.ep.frames.filter((f) => f.t <= t);
  }
}

export class Viewer {
  constructor(container, world) {
    this.world = world;
    this.container = container;
    const w = container.clientWidth;
    const h = container.clientHeight;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.setSize(w, h);
    this.labels.domElement.className = "labels-layer";
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1020);
    this.scene.fog = new THREE.Fog(0x0b1020, 70, 140);

    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.05, 400);
    this.camera.position.set(20, 38, -26);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(20, 3, 12);
    this.controls.enableDamping = true;
    this.controls.addEventListener("start", () => (this._framed = false));
    this.controls.update();

    this.scene.add(new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-20, 40, -10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40 });
    sun.target.position.set(20, 0, 12);
    this.scene.add(sun, sun.target);

    this.greybox = new THREE.Group();
    this.colliders = new THREE.Group();
    this.waypoints = new THREE.Group();
    this.trails = new THREE.Group();
    this.agents = new THREE.Group();
    this.fx = new THREE.Group();
    this.scene.add(this.greybox, this.colliders, this.waypoints, this.trails, this.agents, this.fx);
    this.buildGeometry();
    this.buildWaypoints();
    if (this.world.grid) this.overview();
    this.colliders.visible = false;
    this.waypoints.visible = false;

    this.roundTrails = [];
    this.lineMaterials = new Set();
    this.playback = null;
    this.cameraMode = "orbit";
    this.clock = new THREE.Clock();
    window.addEventListener("resize", () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    for (const m of this.lineMaterials) m.resolution.set(w, h);
    // Keep the overview fitted until someone moves the camera by hand.
    if (this._framed && this.world.grid) this.overview();
  }

  // Scan maps: draw the voxel grid (roof cut off) as the building.
  buildVoxels() {
    const { origin, cell, dims, occ } = this.world.grid;
    const cut = this.world.map.render?.roofCut ?? 2.0;
    const cells = [];
    for (let z = 0; z < dims[2]; z++)
      for (let y = 0; y < dims[1]; y++) {
        const wy = origin[1] + (y + 0.5) * cell;
        if (wy > cut) continue;
        for (let x = 0; x < dims[0]; x++) if (occ[x + dims[0] * (y + dims[1] * z)]) cells.push([x, y, z, wy]);
      }
    const geo = new THREE.BoxGeometry(cell, cell, cell);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, transparent: true, opacity: 0.85 });
    const mesh = new THREE.InstancedMesh(geo, mat, cells.length);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    const ys = cells.map((c) => c[3]);
    const y0 = Math.min(...ys.slice(0, 5000));
    cells.forEach(([x, y, z, wy], i) => {
      m.makeTranslation(origin[0] + (x + 0.5) * cell, wy, origin[2] + (z + 0.5) * cell);
      mesh.setMatrixAt(i, m);
      const t = Math.max(0, Math.min(1, (wy - y0) / (cut - y0)));
      mesh.setColorAt(i, col.setRGB(0.25 + 0.5 * t, 0.29 + 0.5 * t, 0.36 + 0.45 * t));
    });
    mesh.receiveShadow = true;
    this.greybox.add(mesh);
    return cells.length;
  }

  buildGeometry() {
    const styles = {
      floor: { color: 0x1f2937, opacity: 1 },
      wall: { color: 0xcbd5e1, opacity: 0.32 },
      slab: { color: 0x94a3b8, opacity: 0.38 },
      pillar: { color: 0xe2e8f0, opacity: 0.85 },
      obstacle: { color: 0xa16207, opacity: 0.9 },
    };
    for (const b of this.world.boxes) {
      const size = [0, 1, 2].map((i) => b.max[i] - b.min[i]);
      const center = [0, 1, 2].map((i) => (b.max[i] + b.min[i]) / 2);
      const geo = new THREE.BoxGeometry(...size);
      // collider overlay (all boxes, including roof)
      const wire = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xff00aa }));
      wire.position.set(...center);
      this.colliders.add(wire);
      const st = styles[b.kind];
      if (!st) continue;
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: st.color,
          transparent: st.opacity < 1,
          opacity: st.opacity,
          depthWrite: st.opacity >= 0.8,
          roughness: 0.9,
        }),
      );
      mesh.position.set(...center);
      mesh.receiveShadow = true;
      mesh.castShadow = st.opacity >= 0.8;
      this.greybox.add(mesh);
      if (b.kind !== "floor") {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.6 }));
        edges.position.set(...center);
        this.greybox.add(edges);
      }
    }
    if (this.world.grid) this.buildVoxels();
    // ground grid
    const grid = new THREE.GridHelper(120, 60, 0x334155, 0x1e293b);
    const { target } = this.cameraFrame();
    grid.position.set(this.world.grid ? target[0] : 20, this.world.grid ? this.world.grid.origin[1] + 0.01 : 0.01, this.world.grid ? target[2] : 12);
    this.greybox.add(grid);

    this.goalMarker = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(this.world.map.goalRadius, 0.06, 8, 40), new THREE.MeshBasicMaterial({ color: 0x34d399 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.6;
    this.goalRing = ring;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, 1.6, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthWrite: false }),
    );
    beam.position.y = 0.1;
    this.goalMarker.add(ring, beam);
    this.addLabel([0, 0, 0], "GOAL", "lbl lbl-goal", this.goalMarker, 1.4);
    this.startMarker = new THREE.Group();
    this.addLabel([0, 0, 0], "START", "lbl lbl-start", this.startMarker, -1.0);
    this.birdMarker = new THREE.Group();
    this.birdLabel = this.addLabel([0, 0, 0], "BIRD", "lbl lbl-bird", this.birdMarker, 0.9);
    this.scene.add(this.goalMarker, this.startMarker, this.birdMarker);

    // Belief vs. reality: where Ripple said the bird would reach the drone,
    // and where the simulator says it actually got closest.
    this.beliefMarker = new THREE.Group();
    this.beliefMarker.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 24, 16),
        new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.22, depthWrite: false }),
      ),
      new THREE.Mesh(new THREE.SphereGeometry(0.12), new THREE.MeshBasicMaterial({ color: 0xfbbf24 })),
    );
    this.beliefLabel = this.addLabel([0, 0, 0], "RIPPLE EXPECTED THE BIRD HERE", "lbl lbl-belief", this.beliefMarker, 1.5);
    this.actualMarker = new THREE.Group();
    const actualRing = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.07, 8, 32), new THREE.MeshBasicMaterial({ color: 0xf43f5e }));
    actualRing.rotation.x = Math.PI / 2;
    this.actualMarker.add(actualRing, new THREE.Mesh(new THREE.SphereGeometry(0.12), new THREE.MeshBasicMaterial({ color: 0xf43f5e })));
    this.actualLabel = this.addLabel([0, 0, 0], "BIRD ACTUALLY CLOSEST", "lbl lbl-actual", this.actualMarker, -1.0);
    this.beliefLine = null;
    this.scene.add(this.beliefMarker, this.actualMarker);
    this.beliefMarker.visible = false;
    this.actualMarker.visible = false;
    this.setTask(this.world.map.start, this.world.map.goal, this.world.map.birdStart);
  }

  setTask(start, goal, birdStart = null, birdText = "BIRD") {
    const N = this.world.nodes;
    this.goalMarker.position.set(...N[goal]);
    this.startMarker.position.set(...N[start]);
    this.birdMarker.visible = !!birdStart;
    if (birdStart) this.birdMarker.position.set(...N[birdStart]);
    this.birdLabel.element.textContent = birdText;
    this.setBelief(null, null);
  }

  // Who stated the belief: "Ripple", or a labelled stand-in.
  setBeliefOwner(name) {
    this.beliefLabel.element.textContent = `${name.toUpperCase()} EXPECTED THE BIRD HERE`;
  }

  setBirdText(text) {
    this.birdLabel.element.textContent = text;
  }

  // belief: [x,y,z] or null. actual: { drone: [x,y,z], dist } or null.
  setBelief(belief, actual) {
    if (this.beliefLine) {
      this.scene.remove(this.beliefLine);
      this.beliefLine = null;
    }
    this.beliefMarker.visible = !!belief;
    if (belief) this.beliefMarker.position.set(...belief);
    this.actualMarker.visible = !!actual;
    if (actual) {
      this.actualMarker.position.set(...actual.drone);
      this.actualLabel.element.textContent = `BIRD ACTUALLY CLOSEST (${actual.dist.toFixed(1)} m away)`;
    }
    if (belief && actual) {
      this.beliefLine = this.makeLine([belief, actual.drone], 0xfbbf24, 2, 0.8);
      this.beliefLine.material.dashed = true;
      this.beliefLine.material.dashSize = 0.4;
      this.beliefLine.material.gapSize = 0.3;
      this.beliefLine.computeLineDistances();
      this.scene.add(this.beliefLine);
    }
  }

  addLabel(pos, text, cls, parent, dy = 0.5) {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    const o = new CSS2DObject(el);
    o.position.set(pos[0], pos[1] + dy, pos[2]);
    parent.add(o);
    return o;
  }

  buildWaypoints() {
    const N = this.world.nodes;
    const mat = new THREE.MeshBasicMaterial({ color: 0xfacc15 });
    for (const id of this.world.nodeIds) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.12), mat);
      s.position.set(...N[id]);
      this.waypoints.add(s);
      this.addLabel(N[id], id, "lbl lbl-wp", this.waypoints, 0.35);
    }
    const pts = [];
    for (const [a, b] of this.world.map.edges) pts.push(...N[a], ...N[b]);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.waypoints.add(new THREE.LineSegments(g, new THREE.LineDashedMaterial({ color: 0xfacc15, transparent: true, opacity: 0.45 })));
  }

  async loadFlightModels() {
    const loader = new GLTFLoader();
    const models = await Promise.all([
      loader.loadAsync("assets/flight/dji-fpv.glb"),
      loader.loadAsync("assets/flight/white-eagle.glb"),
    ]);
    this.flightModels = models.map(({ scene, animations }, i) => {
      const ghost = cloneSkeleton(scene);
      setOpacity(ghost, i ? 0.4 : 0.45);
      ghost.scale.multiplyScalar(0.8);
      return { scene, ghost, clip: animations[0] };
    });
  }

  makeFlightActor(index, primary) {
    const model = this.flightModels?.[index];
    if (!model) {
      const actor = index ? makeBird() : makeDrone();
      if (!primary) {
        setOpacity(actor, index ? 0.4 : 0.45);
        actor.scale.multiplyScalar(0.8);
      }
      return actor;
    }
    // The simulator moves the anchor. The GLB keeps its own authored transform.
    const anchor = new THREE.Group();
    const visual = cloneSkeleton(primary ? model.scene : model.ghost);
    anchor.add(visual);
    if (model.clip) {
      anchor.mixer = new THREE.AnimationMixer(visual);
      anchor.mixer.clipAction(model.clip).play();
    }
    return anchor;
  }

  async loadSplat(cfg) {
    if (!cfg?.url) return false;
    const { SplatMesh } = await import("@sparkjsdev/spark");
    const splat = new SplatMesh({ url: cfg.url });
    splat.position.set(...(cfg.position || [0, 0, 0]));
    splat.rotation.set(...(cfg.rotation || [0, 0, 0]));
    splat.scale.setScalar(cfg.scale ?? 1);
    this.scene.add(splat);
    this.splat = splat;
    this.scene.background = new THREE.Color(0x05070d);
    return true;
  }

  setLayer(name, on) {
    if (name === "colliders") this.colliders.visible = on;
    if (name === "waypoints") this.waypoints.visible = on;
    if (name === "greybox") this.greybox.visible = on;
    if (name === "splat" && this.splat) this.splat.visible = on;
    if (name === "trails") this.trails.visible = on;
  }

  makeLine(points, color, width, opacity = 1) {
    const geo = new LineGeometry();
    const flat = points.length >= 2 ? points.flat() : [...points[0], ...points[0]];
    geo.setPositions(flat);
    const mat = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthWrite: false });
    mat.resolution.set(this.container.clientWidth, this.container.clientHeight);
    this.lineMaterials.add(mat);
    const line = new Line2(geo, mat);
    line.computeLineDistances();
    return line;
  }

  // Dim earlier rounds so the newest attempts stand out.
  fadeOldTrails() {
    const n = this.roundTrails.length;
    this.roundTrails.forEach((grp, i) => {
      const age = n - 1 - i;
      const op = age === 0 ? 1 : Math.max(0.08, 0.45 * 0.6 ** (age - 1));
      grp.traverse((o) => {
        if (o.material?.isLineMaterial) o.material.opacity = op * (o.userData.baseOpacity ?? 1);
      });
    });
  }

  clearTrails() {
    this.trails.clear();
    this.roundTrails = [];
    this.tempTrail = null;
  }

  clearAgents() {
    for (const actor of this.agents.children) {
      actor.mixer?.stopAllAction();
      actor.traverse(node => node.skeleton?.dispose());
    }
    this.agents.clear();
  }

  // Play one or more episodes together. Returns a promise that resolves
  // when all have finished. sources: [{source, outcome, primary}]
  play(sources, { speed = 1, follow = false, label = "", keepTrails = true, onTick, birdRange = null } = {}) {
    if (this.playback) this.playback.resolve("interrupted");
    this.clearAgents();
    if (this.tempTrail) {
      this.trails.remove(this.tempTrail);
      this.tempTrail = null;
    }
    const grp = new THREE.Group();
    this.trails.add(grp);
    if (keepTrails) this.roundTrails.push(grp);
    else this.tempTrail = grp;
    const tracks = sources.map((s, i) => {
      const drone = this.makeFlightActor(0, s.primary);
      const bird = this.makeFlightActor(1, s.primary);
      this.agents.add(drone, bird);
      const width = s.primary ? 4 : 2.2;
      const live = this.makeLine([[0, 0, 0], [0, 0, 0]], OUTCOME_COLORS.running, width, s.primary ? 1 : 0.6);
      live.userData.baseOpacity = s.primary ? 1 : 0.6;
      grp.add(live);
      // The bird's path: bold red for the main flight so its approach reads
      // at a glance, faint for the ghost seeds.
      const birdOpacity = s.primary ? 0.9 : 0.3;
      const birdLine = this.makeLine([[0, 0, 0], [0, 0, 0]], 0xf43f5e, s.primary ? 3 : 1.4, birdOpacity);
      birdLine.userData.baseOpacity = birdOpacity;
      grp.add(birdLine);
      // A waiting bird leaves no path. For the main flight, show how far it
      // can see to strike (its trigger distance) as a pulsing red ring while
      // it waits; the ring goes once it launches.
      let range = null;
      if (s.primary && birdRange) {
        const pts = [];
        for (let k = 0; k <= 64; k++) pts.push([Math.cos((k / 64) * Math.PI * 2), 0, Math.sin((k / 64) * Math.PI * 2)]);
        range = this.makeLine(pts, 0xf43f5e, 2.5, 0.7);
        range.scale.setScalar(birdRange);
        range.visible = false;
        this.agents.add(range);
      }
      return { ...s, drone, bird, live, birdLine, range, lastN: 0, finished: false };
    });
    this.fadeOldTrails();
    return new Promise((resolve) => {
      this.playback = { tracks, t: 0, speed, follow, label, onTick, resolve: (why) => { this.playback = null; resolve(why); } };
    });
  }

  setSpeed(speed) {
    if (this.playback) this.playback.speed = speed;
  }

  updateTrack(tr, t) {
    const st = tr.source.state(t);
    tr.drone.position.set(...st.d);
    tr.bird.position.set(...st.b);
    // orientation from velocity
    const dv = st.dv;
    const sp = Math.hypot(dv[0], dv[2]);
    if (sp > 0.05) tr.drone.rotation.set(Math.min(0.5, sp * 0.06), Math.atan2(dv[0], dv[2]), 0, "YXZ");
    tr.drone.rotors?.forEach((r, i) => (r.rotation.y += 0.9 + i * 0.05));
    const pts = tr.source.pointsUpTo(t);
    if (pts.length !== tr.lastN && pts.length >= 2) {
      tr.lastN = pts.length;
      tr.live.geometry.dispose();
      tr.live.geometry = new LineGeometry();
      tr.live.geometry.setPositions([...pts.map((f) => f.d).flat(), ...st.d]);
      tr.birdLine.geometry.dispose();
      tr.birdLine.geometry = new LineGeometry();
      tr.birdLine.geometry.setPositions([...pts.map((f) => f.b).flat(), ...st.b]);
      // bird heading
      const prev = pts[Math.max(0, pts.length - 3)].b;
      const dx = st.b[0] - prev[0];
      const dz = st.b[2] - prev[2];
      if (Math.hypot(dx, dz) > 0.01) tr.bird.rotation.y = Math.atan2(dx, dz);
    }
    if (tr.range) {
      const waiting = st.bs === "wait";
      tr.range.visible = waiting;
      if (waiting) {
        tr.range.position.set(st.b[0], st.b[1], st.b[2]);
        tr.range.material.opacity = 0.45 + 0.35 * Math.sin(this.clock.elapsedTime * 3);
      }
    }
    const flap = st.bs === "hunt" ? 18 : st.bs === "wait" || st.bs === "rest" ? 3 : 9;
    const amp = st.bs === "wait" || st.bs === "rest" ? 0.15 : 0.7;
    tr.bird.mixer?.setTime(st.t);
    tr.bird.wings?.forEach((w) => (w.rotation.z = w.side * Math.sin(this.clock.elapsedTime * flap) * amp));
    return st;
  }

  finishTrack(tr) {
    tr.finished = true;
    const color = OUTCOME_COLORS[tr.outcome()] ?? OUTCOME_COLORS.timeout;
    tr.live.material.color.setHex(color);
    const end = tr.source.state(tr.source.duration);
    this.burst(end.d, color, tr.primary ? 1.6 : 0.9);
  }

  burst(pos, color, size) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 20, 14),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    m.position.set(...pos);
    m.userData = { age: 0, size };
    this.fx.add(m);
  }

  frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    const pb = this.playback;
    if (pb) {
      pb.t += dt * pb.speed;
      let primary = null;
      let allDone = true;
      for (const tr of pb.tracks) {
        const st = this.updateTrack(tr, pb.t);
        if (tr.primary) primary = { tr, st };
        if (tr.source.done(pb.t)) {
          if (!tr.finished) this.finishTrack(tr);
        } else allDone = false;
      }
      if (primary && pb.follow) this.followCam(primary.st, dt);
      pb.onTick?.(pb.t, primary?.st);
      if (allDone) pb.resolve("done");
    }
    for (const m of [...this.fx.children]) {
      m.userData.age += dt;
      const a = m.userData.age;
      m.scale.setScalar(1 + a * 6 * m.userData.size);
      m.material.opacity = Math.max(0, 0.8 - a * 1.2);
      if (a > 0.8) this.fx.remove(m);
    }
    this.goalRing.rotation.z += dt * 0.8;
    if (!(pb && pb.follow)) this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  followCam(st, dt) {
    const d = new THREE.Vector3(...st.d);
    const vel = new THREE.Vector3(...st.dv);
    vel.y = 0;
    if (vel.lengthSq() < 0.05) vel.copy(this._lastDir || new THREE.Vector3(0, 0, 1));
    vel.normalize();
    this._lastDir = vel.clone();
    const want = d.clone().addScaledVector(vel, -4.5).add(new THREE.Vector3(0, 2.2, 0));
    const k = 1 - Math.exp(-dt * 3);
    this.camera.position.lerp(want, k);
    this.controls.target.lerp(d.clone().addScaledVector(vel, 2), k);
    this.camera.lookAt(this.controls.target);
  }

  // Where the overview camera sits: fixed for the grey building (unchanged
  // look), fitted to the waypoint graph for scan maps. The fit uses the
  // view's aspect ratio, so wide, short views (the scenario grid's cells)
  // still show the whole graph, including the far south rooms.
  cameraFrame() {
    if (!this.world.grid) return { eye: [20, 38, -26], target: [20, 3, 12] };
    const ps = Object.values(this.world.nodes);
    const lo = [0, 1, 2].map((k) => Math.min(...ps.map((p) => p[k])));
    const hi = [0, 1, 2].map((k) => Math.max(...ps.map((p) => p[k])));
    const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
    const wx = hi[0] - lo[0] + 6;
    const wz = hi[2] - lo[2] + 6;
    const tilt = 0.5; // radians from straight down, looking from +z
    const vfov = (this.camera.fov * Math.PI) / 180;
    const aspect = this.camera.aspect || 1.6;
    const tanV = Math.tan(vfov / 2);
    const tanH = tanV * aspect;
    // Distance at which the graph's width fits horizontally and its
    // (tilted, foreshortened) depth fits vertically; the near edge is
    // closer to the camera, so give depth the extra half-height.
    const dX = wx / 2 / tanH + (wz / 2) * Math.sin(tilt);
    const dZ = ((wz / 2) * Math.cos(tilt)) / tanV + (wz / 2) * Math.sin(tilt);
    const d = Math.max(dX, dZ) * 1.04;
    return { eye: [c[0], c[1] + d * Math.cos(tilt), c[2] + d * Math.sin(tilt)], target: [c[0], c[1] - 1, c[2]] };
  }

  overview() {
    this._framed = true;
    const { eye, target } = this.cameraFrame();
    this.camera.position.set(...eye);
    this.controls.target.set(...target);
    this.controls.update();
  }
}
