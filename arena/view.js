// Top-down view of the factory's collision grid (north up, east right), with
// the flight, its ghost, the goal and wall contacts. Plain canvas 2D: no
// WebGL, no scan download.

export function createView(canvas, world) {
  const g = world.grid;
  const [NX, NY, NZ] = g.dims;
  const { origin, cell } = g;
  const occ = (x, y, z) => g.occ[x + NX * (y + NY * z)];
  // Columns: how much of the flyable band (about -0.5 m to 3.5 m) is solid.
  const yLo = Math.max(0, Math.floor((-0.5 - origin[1]) / cell));
  const yHi = Math.min(NY - 1, Math.ceil((3.5 - origin[1]) / cell));
  const css = getComputedStyle(document.documentElement);
  const col = (name) => css.getPropertyValue(name).trim();

  const base = document.createElement("canvas");
  base.width = NX;
  base.height = NZ;
  const layers = new Map();

  function paintBase() {
    const ctx = base.getContext("2d");
    const img = ctx.createImageData(NX, NZ);
    const floor = hex(col("--map-floor"));
    const wall = hex(col("--map-wall"));
    for (let z = 0; z < NZ; z++)
      for (let x = 0; x < NX; x++) {
        let n = 0;
        for (let y = yLo; y <= yHi; y++) n += occ(x, y, z);
        const f = Math.min(1, n / (yHi - yLo + 1) * 1.6);
        const c = floor.map((a, i) => Math.round(a + (wall[i] - a) * f));
        const k = 4 * (x + NX * (NZ - 1 - z)); // north up
        img.data.set([c[0], c[1], c[2], 255], k);
      }
    ctx.putImageData(img, 0, 0);
    layers.clear();
  }

  // What is solid at one height: drawn over the base when the drone is there.
  function layer(y) {
    const iy = Math.max(0, Math.min(NY - 1, Math.round((y - origin[1]) / cell)));
    if (layers.has(iy)) return layers.get(iy);
    const c = document.createElement("canvas");
    c.width = NX;
    c.height = NZ;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(NX, NZ);
    const s = hex(col("--map-slice"));
    for (let z = 0; z < NZ; z++)
      for (let x = 0; x < NX; x++)
        if (occ(x, iy, z)) img.data.set([s[0], s[1], s[2], 255], 4 * (x + NX * (NZ - 1 - z)));
    ctx.putImageData(img, 0, 0);
    layers.set(iy, c);
    return c;
  }

  let scale = 1;
  const toPx = (p) => [((p[0] - origin[0]) / cell) * scale, (NZ - (p[2] - origin[2]) / cell) * scale];

  function resize() {
    const w = canvas.clientWidth;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    scale = (w * dpr) / NX;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(NZ * scale);
  }

  // state: { goal, start, run: {frames, contacts}, ghost: {frames}, t, showSlice }
  function draw(s) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(base, 0, 0, W, H);
    const now = s.run ? frameAt(s.run.frames, s.t) : null;
    if (now && s.showSlice) {
      ctx.globalAlpha = 0.85;
      ctx.drawImage(layer(now[2]), 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    const m = scale / cell; // pixels per metre
    // start and goal
    if (s.start) dot(ctx, toPx(s.start), Math.max(3, 0.35 * m), col("--ink-soft"), true);
    if (s.goal) {
      const [gx, gy] = toPx(s.goal);
      ctx.strokeStyle = col("--goal");
      ctx.lineWidth = Math.max(2, 0.12 * m);
      ctx.beginPath();
      ctx.arc(gx, gy, 1.0 * m, 0, Math.PI * 2); // goal radius 1 m
      ctx.stroke();
      dot(ctx, [gx, gy], Math.max(2, 0.18 * m), col("--goal"));
    }
    if (s.ghost) {
      path(ctx, s.ghost.frames, s.t, col("--ghost"), Math.max(1.5, 0.1 * m), [6, 5]);
      const gn = frameAt(s.ghost.frames, s.t);
      if (gn) dot(ctx, toPx([gn[1], gn[2], gn[3]]), Math.max(4, 0.3 * m), col("--ghost"), true);
    }
    if (s.run) {
      path(ctx, s.run.frames, s.t, col("--path"), Math.max(2, 0.14 * m));
      for (const c of s.run.contacts) {
        if (c.t > s.t) continue;
        cross(ctx, toPx(c.at), Math.max(3, 0.22 * m), col("--contact"));
      }
      if (now) {
        const p = toPx([now[1], now[2], now[3]]);
        dot(ctx, p, Math.max(5, 0.25 * m), col("--drone"));
        ctx.strokeStyle = col("--bg");
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p[0], p[1], Math.max(5, 0.25 * m), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  function path(ctx, frames, t, color, width, dash) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    let first = true;
    for (const f of frames) {
      if (f[0] > t + 1e-9) break;
      const [x, y] = toPx([f[1], f[2], f[3]]);
      if (first) ctx.moveTo(x, y), (first = false);
      else ctx.lineTo(x, y);
    }
    const n = frameAt(frames, t);
    if (n && !first) ctx.lineTo(...toPx([n[1], n[2], n[3]]));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  paintBase();
  resize();
  return { draw, resize, repaint: () => { paintBase(); }, pxPerMetre: () => scale / cell };
}

// Position at time t, interpolated between the 0.1 s frames
// ([t, x, y, z, heading]); holds the last frame after the flight ends.
export function frameAt(frames, t) {
  if (!frames?.length) return null;
  if (t <= frames[0][0]) return frames[0];
  for (let i = 1; i < frames.length; i++) {
    const b = frames[i];
    if (b[0] >= t) {
      const a = frames[i - 1];
      const u = (t - a[0]) / (b[0] - a[0] || 1);
      return [t, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u, b[4]];
    }
  }
  return frames[frames.length - 1];
}

function dot(ctx, [x, y], r, color, hollow) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (hollow) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.fill();
  }
}

function cross(ctx, [x, y], r, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r);
  ctx.lineTo(x - r, y + r);
  ctx.stroke();
}

function hex(s) {
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
