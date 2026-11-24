// The cutaway uses an orthographic camera. Keep its focus on a horizontal
// plane so a point under the pointer stays there while panning or zooming.
// Shot changes and actor tracking ease toward their target pose instead of
// jumping, so replays read as one continuous camera move.
const radians = Math.PI / 180;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const presets = {
  angled: { x: -10, y: 0, z: -7.5, yaw: Math.atan2(16, 31.5), tilt: Math.atan2(Math.hypot(16, 31.5), 50) },
  top: { x: -10, y: 0, z: -7.5, yaw: 0, tilt: 0 },
  track: { x: 0, y: 0, z: 0, yaw: Math.atan2(8, 10), tilt: Math.atan2(Math.hypot(8, 10), 13) },
  // Follow one actor, angled, with enough of the room around it to read
  // where it is heading.
  bird: { x: 0, y: 0, z: 0, yaw: Math.atan2(8, 10), tilt: Math.atan2(Math.hypot(8, 10), 16) },
  drone: { x: 0, y: 0, z: 0, yaw: Math.atan2(8, 10), tilt: Math.atan2(Math.hypot(8, 10), 15) },
};
const FOLLOW = { track: "both", bird: "bird", drone: "drone" };
// Seconds the "drone" shot looks ahead along the drone's velocity, and the
// distance at which it starts framing the bird too.
const LOOK_AHEAD = 0.9;
const BIRD_NEAR = 10;

export function createCutawayCamera(canvas, camera, onExplore) {
  const pose = {};
  const view = {}; // what is rendered; eases toward pose
  const pointers = new Map();
  let enabled = true;
  let snap = true; // jump straight to pose (first frame, direct manipulation)
  let last = performance.now();
  let prev = null; // previous drone position, for its velocity
  const vel = { x: 0, z: 0 };
  let near = 0; // 0..1, how much the bird is in the "drone" shot

  function select(shot) {
    enabled = shot !== "chase";
    for (const id of pointers.keys()) {
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    }
    pointers.clear();
    canvas.dataset.navigation = enabled ? "ready" : "off";
    if (!enabled) return;
    const keep = pose.tracking && FOLLOW[shot] ? { x: pose.x, y: pose.y, z: pose.z } : {};
    Object.assign(pose, presets[shot], { zoom: 1, tracking: FOLLOW[shot] || false }, keep);
    orient();
  }

  function baseHeight() {
    // An inactive presentation tab can have a zero-sized canvas.
    const aspect = Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight);
    if (pose.tracking === "both") return Math.max(4, 5 / aspect);
    // Wide enough that the splat stays sharp and the next turn is in view;
    // opens up a little more while the bird is close.
    if (pose.tracking === "drone") return Math.max(6, 9.5 / aspect) * (1 + 0.25 * near);
    if (pose.tracking) return Math.max(5.5, 8.5 / aspect);
    return Math.max(25.5, 33 / aspect);
  }

  function orient() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const target = { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw, tilt: pose.tilt, height: baseHeight() / pose.zoom };
    const k = snap || view.x === undefined ? 1 : 1 - Math.exp(-dt * 2.6);
    for (const key in target) view[key] = view[key] === undefined ? target[key] : view[key] + (target[key] - view[key]) * k;
    snap = false;
    const distance = 60;
    const horizontal = distance * Math.sin(view.tilt);
    camera.setPosition(view.x + horizontal * Math.sin(view.yaw),
      view.y + distance * Math.cos(view.tilt), view.z + horizontal * Math.cos(view.yaw));
    camera.setEulerAngles(view.tilt / radians - 90, view.yaw / radians, 0);
    camera.camera.orthoHeight = view.height;
  }

  function update(drone, eagle) {
    const now = performance.now();
    const dt = Math.max(1e-3, (now - (update.t ?? now - 16)) / 1000);
    update.t = now;
    if (prev) {
      const k = 0.08; // smooth the velocity so the look-ahead doesn't jitter
      vel.x += ((drone.x - prev.x) / dt - vel.x) * k;
      vel.z += ((drone.z - prev.z) / dt - vel.z) * k;
      // A teleport (new flight) resets the estimate.
      if (Math.hypot(drone.x - prev.x, drone.z - prev.z) > 2) vel.x = vel.z = 0;
    }
    prev = { x: drone.x, y: drone.y, z: drone.z };
    if (pose.tracking === "drone") {
      const gap = Math.hypot(eagle.x - drone.x, eagle.z - drone.z);
      const want = clamp((BIRD_NEAR - gap) / 4, 0, 1);
      near += (want - near) * 0.04;
      const ax = drone.x + clamp(vel.x * LOOK_AHEAD, -3, 3);
      const az = drone.z + clamp(vel.z * LOOK_AHEAD, -3, 3);
      pose.x = ax + (eagle.x - ax) * 0.4 * near;
      pose.y = drone.y;
      pose.z = az + (eagle.z - az) * 0.4 * near;
    } else if (pose.tracking) {
      const a = pose.tracking === "bird" ? eagle : drone;
      const b = pose.tracking === "both" ? eagle : a;
      pose.x = (a.x + b.x) / 2;
      pose.y = (a.y + b.y) / 2;
      pose.z = (a.z + b.z) / 2;
    }
    orient();
  }

  function explore() {
    if (pose.tracking) {
      // Change projection scale bases without jumping away from the actors.
      const aspect = Math.max(1, canvas.clientWidth) / Math.max(1, canvas.clientHeight);
      pose.zoom = Math.max(25.5, 33 / aspect) / camera.camera.orthoHeight;
      pose.tracking = false;
      Object.assign(pose, { x: view.x, y: view.y, z: view.z, yaw: view.yaw, tilt: view.tilt });
      snap = true;
    }
    onExplore(pose.tilt === 0 ? "top" : "angled");
  }

  function pan(dx, dy) {
    snap = true;
    const units = 2 * camera.camera.orthoHeight / canvas.clientHeight;
    const right = -dx * units;
    const forward = dy * units / Math.cos(pose.tilt);
    const sin = Math.sin(pose.yaw), cos = Math.cos(pose.yaw);
    pose.x += right * cos - forward * sin;
    pose.z -= right * sin + forward * cos;
  }

  function rotate(dx, dy) {
    snap = true;
    pose.yaw -= dx * .006;
    pose.tilt = clamp(pose.tilt + dy * .006, 0, 72 * radians);
  }

  // Preserve the world point under the gesture as its centre moves, twists
  // and changes scale. A mouse wheel gesture has a stationary centre.
  function transformAt(x, y, dx, dy, factor, twist = 0) {
    const rect = canvas.getBoundingClientRect();
    const fromX = x - rect.left - rect.width / 2;
    const fromY = y - rect.top - rect.height / 2;
    pan(-fromX, -fromY);
    pose.yaw += twist;
    pose.zoom = clamp(pose.zoom * factor, .45, 32);
    orient();
    pan(fromX + dx, fromY + dy);
  }

  canvas.addEventListener("wheel", event => {
    if (!enabled) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
    const factor = Math.exp(-.0015 * event.deltaY * unit);
    if (pose.tracking) pose.zoom = clamp(pose.zoom * factor, .45, 4);
    else transformAt(event.clientX, event.clientY, 0, 0, factor);
    orient();
  }, { passive: false });

  canvas.addEventListener("pointerdown", event => {
    if (!enabled || event.button > 2 || pointers.size >= 2) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.dataset.navigation = "dragging";
  });
  canvas.addEventListener("contextmenu", event => { if (enabled) event.preventDefault(); });
  canvas.addEventListener("pointermove", event => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    const dx = event.clientX - last.x, dy = event.clientY - last.y;
    if (!dx && !dy) return;
    const other = [...pointers.values()].find(point => point !== last);
    if (other) {
      const oldDistance = Math.hypot(last.x - other.x, last.y - other.y);
      const newDistance = Math.hypot(event.clientX - other.x, event.clientY - other.y);
      const angle = Math.atan2(event.clientY - other.y, event.clientX - other.x) - Math.atan2(last.y - other.y, last.x - other.x);
      explore();
      if (oldDistance > 2 && newDistance > 2) {
        transformAt((last.x + other.x) / 2, (last.y + other.y) / 2, dx / 2, dy / 2, newDistance / oldDistance, angle);
      } else {
        pan(dx / 2, dy / 2);
      }
    } else if (event.shiftKey || (event.buttons & 2)) {
      rotate(dx, dy);
      explore();
    } else {
      explore();
      pan(dx, dy);
    }
    last.x = event.clientX;
    last.y = event.clientY;
    orient();
  });
  function release(event) {
    pointers.delete(event.pointerId);
    if (enabled && !pointers.size) canvas.dataset.navigation = "ready";
  }
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(type, release);
  return { select, update };
}
