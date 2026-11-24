// Right-side control panel for the scan page (factory.html?panel=1, and the
// demo's Full scan tab). It drives what is already there: the cutaway shots
// (selectCamera), the replay (window.factoryReplay) and the voxel view
// (ctx.voxels). P shows or hides it; every other key keeps working with it
// hidden.
const SHOTS = [
  ["auto", "Auto", "Overview, then in behind the drone (the default)"],
  ["angled", "Angled", "The angled roof-cut overview (O)"],
  ["top", "Top", "Straight down (T)"],
  ["track", "Track both", "Keep the drone and the bird in frame"],
  ["drone", "Follow drone", "Keep the drone in the middle (D)"],
  ["bird", "Follow bird", "Keep the bird in the middle (B)"],
  ["chase", "Chase", "Behind the drone, above the roof cut"],
];
const VIEWS = [
  ["scan", "Scan", "The Gaussian-splat scan"],
  ["voxels", "Voxels", "The simulator's voxel map of the same building"],
  ["wipe", "Wipe", "Sweep from scan to voxels and back, on a loop (V plays one pass)"],
];
const OUTCOME = { reached: "#34d399", intercepted: "#f43f5e", crashed: "#f59e0b", timeout: "#94a3b8" };
const OUTCOME_TEXT = { reached: "Reached", intercepted: "Caught", crashed: "Crashed", timeout: "Timed out" };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function createPanel(ctx, { open = false } = {}) {
  const rp = window.factoryReplay || null;
  const vox = ctx.voxels || null;
  const cut = document.getElementById("cut");
  const trails = document.getElementById("trails");
  const main = document.querySelector("main");
  document.body.classList.add("has-panel");

  const panel = document.createElement("aside");
  panel.className = "scan-panel";
  panel.setAttribute("aria-label", "Scan controls");
  const seg = (items, attr) =>
    items.map(([id, text, title]) => `<button type="button" ${attr}="${id}" title="${esc(title)}" aria-pressed="false">${esc(text)}</button>`).join("");
  panel.innerHTML = `
    <div class="sp-head"><b>Controls</b><button type="button" class="sp-close" title="Hide the panel (P)" aria-label="Hide the panel">P ×</button></div>
    <section><h3>Shot</h3><div class="sp-seg sp-shots">${seg(SHOTS, "data-pshot")}</div></section>
    ${rp ? `<section><h3>Flights</h3><div class="sp-flights"></div></section>
    <section><h3>Playback</h3>
      <div class="sp-row">
        <button type="button" data-act="play" title="Pause or resume (Space)">Pause</button>
        <button type="button" data-act="replay" title="Fly this flight again (R)">↻ Replay</button>
        <button type="button" data-act="next" title="Next recorded flight (N)">Next ›</button>
      </div>
      <div class="sp-row"><span class="sp-label">Speed</span><div class="sp-seg">${seg(rp.speeds.map((s) => [s, `${s}×`, `Play at ${s}× speed`]), "data-speed")}</div></div>
      <input class="sp-scrub" type="range" min="0" max="1" step="0.05" value="0" aria-label="Flight time">
      <div class="sp-time"></div>
    </section>` : ""}
    <section><h3>Look</h3>
      <label class="sp-row"><span class="sp-label">Roof cut</span><input class="sp-cut" type="range" min="${cut.min}" max="${cut.max}" step="${cut.step}" value="${cut.value}"><output class="sp-cutv"></output></label>
      <label class="sp-row sp-check"><input class="sp-trails" type="checkbox"> Trails</label>
      ${vox ? `<div class="sp-row"><span class="sp-label">View</span><div class="sp-seg">${seg(VIEWS, "data-view")}</div></div>` : ""}
    </section>
    <p class="sp-keys">O T B D shots · R replay · N next${rp ? " · Space pause" : ""}${vox ? " · V wipe" : ""} · P panel</p>`;
  main.appendChild(panel);
  const opener = document.createElement("button");
  opener.type = "button";
  opener.className = "sp-open";
  opener.title = "Show the controls (P)";
  opener.textContent = "Controls · P";
  main.appendChild(opener);
  const $ = (sel) => panel.querySelector(sel);

  let shown = false;
  function setOpen(on) {
    shown = !!on;
    document.body.classList.toggle("panel-open", shown);
    opener.hidden = shown || !open; // the pill only where the panel was asked for
  }
  setOpen(open);
  $(".sp-close").onclick = () => setOpen(false);
  opener.onclick = () => setOpen(true);
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target?.matches?.("input:not([type=range]):not([type=checkbox]), select, textarea")) return;
    if (e.key === "p" || e.key === "P") setOpen(!shown);
  });

  // ---- shots ----
  for (const b of panel.querySelectorAll("[data-pshot]")) {
    const shot = b.dataset.pshot;
    if (shot === "auto" && !rp) b.hidden = true;
    b.onclick = () => {
      if (shot === "auto") rp.setAuto();
      else if (rp) rp.setShot(shot);
      else ctx.selectCamera(shot);
    };
  }

  // ---- flights and playback ----
  const scrub = $(".sp-scrub");
  let dragging = false;
  if (rp) {
    const list = $(".sp-flights");
    list.innerHTML = rp.flights
      .map((f, i) => {
        const r = f.result;
        const s = f.ep.summary;
        return `<button type="button" class="sp-flight" data-flight="${i}" title="Play this flight">
          <span class="dot" style="background:${OUTCOME[r.outcome] || OUTCOME.timeout}"></span>
          <span class="what"><b>${esc(f.ep.scenario.id)}</b> ${esc(f.label)}</span>
          <span class="how">${esc(OUTCOME_TEXT[r.outcome] || r.outcome)}${s ? ` · ${s.reached}/${s.trials}` : ""}</span>
        </button>`;
      })
      .join("");
    for (const b of list.querySelectorAll("[data-flight]")) b.onclick = () => rp.start(Number(b.dataset.flight));
    $('[data-act="play"]').onclick = () => rp.setPaused(!rp.current.paused);
    $('[data-act="replay"]').onclick = () => rp.start(rp.current.idx);
    $('[data-act="next"]').onclick = () => rp.start(rp.current.idx + 1);
    $('[data-act="next"]').hidden = rp.flights.length < 2;
    for (const b of panel.querySelectorAll("[data-speed]")) b.onclick = () => rp.setSpeed(Number(b.dataset.speed));
    scrub.addEventListener("input", () => {
      dragging = true;
      rp.seek(Number(scrub.value));
    });
    scrub.addEventListener("change", () => (dragging = false));
    scrub.addEventListener("pointerup", () => (dragging = false));
  }

  // ---- look ----
  const cutBox = $(".sp-cut");
  cutBox.addEventListener("input", () => {
    cut.value = cutBox.value;
    cut.dispatchEvent(new Event("input"));
  });
  const trailBox = $(".sp-trails");
  trailBox.addEventListener("change", () => {
    trails.checked = trailBox.checked;
    trails.dispatchEvent(new Event("change"));
  });
  for (const b of panel.querySelectorAll("[data-view]")) b.onclick = () => vox.setView(b.dataset.view);

  // ---- state → panel, written only when it changes ----
  const memo = new Map();
  const put = (key, value, apply) => {
    if (memo.get(key) === value) return;
    memo.set(key, value);
    apply(value);
  };
  const press = (sel, attr, value) => {
    for (const b of panel.querySelectorAll(sel)) b.setAttribute("aria-pressed", String(String(b.dataset[attr]) === String(value)));
  };
  function refresh() {
    const cur = rp?.current;
    const auto = !!cur?.auto;
    put("shot", `${ctx.shot}|${auto}`, () => {
      for (const b of panel.querySelectorAll("[data-pshot]")) {
        const on = b.dataset.pshot === "auto" ? auto : !auto && b.dataset.pshot === ctx.shot;
        b.setAttribute("aria-pressed", String(on));
      }
    });
    if (cur) {
      put("flight", cur.idx, (i) => press("[data-flight]", "flight", i));
      put("paused", cur.paused, (p) => {
        const b = $('[data-act="play"]');
        b.textContent = p ? "▶ Play" : "❚❚ Pause";
        b.classList.toggle("on", p);
      });
      put("speed", cur.speed, (s) => press("[data-speed]", "speed", s));
      put("dur", cur.duration, (d) => (scrub.max = d.toFixed(2)));
      const t = Math.min(cur.flightT, cur.duration);
      if (!dragging) put("t", t.toFixed(2), (v) => (scrub.value = v));
      const label = cur.phase === "intro" ? "overview" : cur.phase === "end" ? "landed" : "flying";
      put("time", `${t.toFixed(1)}|${label}`, () => ($(".sp-time").textContent = `t ${t.toFixed(1)} / ${cur.duration.toFixed(1)} s · ${label}`));
    }
    put("cut", cut.value, (v) => {
      cutBox.value = v;
      $(".sp-cutv").textContent = `${Number(v).toFixed(1)} m`;
    });
    put("trails", trails.checked, (on) => (trailBox.checked = on));
    if (vox) put("view", vox.view, (v) => press("[data-view]", "view", v));
  }
  refresh();
  ctx.app.on("update", refresh);

  return {
    element: panel,
    setOpen,
    get open() {
      return shown;
    },
  };
}
