// Demo controller (demo.html): one tab bar over the existing pages.
// Each view is the existing page in an iframe with the runbook's URL, so the
// pages keep working on their own. Heavy views (the factory scan) stay loaded
// once opened; the grids reload on every visit so their flights replay.
// Keys: 1–7 jump to a tab, ←/→ or PageUp/PageDown step through them.

const FACTORY_FULL = "recordings/ripple-factory-full.json";
const FACTORY_NORTH = "recordings/ripple-factory.json";

async function exists(url) {
  try {
    return (await fetch(url, { method: "HEAD" })).ok;
  } catch {
    return false;
  }
}

// The full-factory Ripple run may not be committed yet; fall back to the
// north-hall run and say so in the tab.
const factoryRec = (await exists(FACTORY_FULL)) ? FACTORY_FULL : FACTORY_NORTH;
const factoryWhere = factoryRec === FACTORY_FULL ? "full building" : "north hall";

const BUILDING = "recordings/ripple-demo-36.json";
const TABS = [
  { id: "results", group: "Building", name: "Results", sub: "36 scenarios × 8 harnesses", src: `./?recording=${BUILDING}`, keep: true, panel: true, demo: true },
  { id: "grid", group: "Building", name: "Grid", sub: "4 flights · harness H", src: `grid.html?recording=${BUILDING}&flyer=structured_feedback` },
  { id: "factory", group: "Factory", name: "Simulator", sub: `voxels · ${factoryWhere}`, src: `./?recording=${factoryRec}`, keep: true, panel: true, demo: true },
  // The scan page on its own, full width, in presentation mode: the best
  // recorded flights, each opening on the overview and easing in behind the
  // drone (O / T / B / D switch shots, R replays, N next flight). The
  // right-side panel drives shots, flights, playback and the scan ↔ voxel
  // wipe; P hides it, V plays one wipe.
  { id: "scan", group: "Factory", name: "Full scan", sub: `Gaussian splat · ${factoryWhere} · best recorded flights · keys O T B D, R replay, N next, Space pause, V wipe, P panel`, src: `factory.html?recording=${factoryRec}&clean=1&shot=drone&panel=1`, keep: true },
  // The grid always shows the full building (north hall and south rooms).
  // Until Ripple's full-building run exists, those flights come from the
  // labelled bird-aware heuristic, never presented as Ripple.
  {
    id: "fgrid", group: "Factory", name: "Grid",
    sub: factoryRec === FACTORY_FULL ? "4 flights · full building" : "4 flights · full building · heuristic until Ripple's run lands",
    // Without a Ripple recording, open on the scenarios the heuristic flies
    // best (3–4 of 4 seeds; see showcase note in DEMO.md).
    src: factoryRec === FACTORY_FULL ? `grid.html?recording=${FACTORY_FULL}` : "grid.html?map=maps/factory-full.json&flyer=heuristic&ids=H9,H5,H23,H2",
  },
  { id: "findings", group: "", name: "Findings", sub: "every number, 95% CIs", src: "findings.html", keep: true },
  { id: "io", group: "", name: "Harness I/O", sub: "input JSON, output JSON, thinking tokens, what the simulator flies", src: `harness.html?recording=${BUILDING}&harness=structured_feedback&scenario=H26`, keep: true },
];
// Panel sections to jump to on the arena pages (ids of elements inside them).
// Presentation mode keeps the bar to the tabs and the two play buttons;
// ?full=1 brings the scroll shortcuts back.
const FULL = new URLSearchParams(location.search).get("full");
const JUMPS = FULL
  ? [
      ["Training", "curve"],
      ["Held-out", "evalTable"],
      ["Strategy", "strategy"],
      ["Episodes", "episodes"],
    ]
  : [];

const $ = (id) => document.getElementById(id);
const frames = new Map(); // tab id -> iframe
let current = null;

// Inside the controller the pages' own cross-links would navigate a frame
// away from its view; the tab bar replaces them.
// The bar's ▶ buttons drive the arena pages, so their own copies are hidden.
const EMBED_CSS = "#backLink, #gridLink { display: none !important; }" + (FULL ? "" : " #btnDemo, #btnLearn { display: none !important; }");

const fullName = (t) => (t.group ? `${t.group} · ${t.name}` : t.name);
let lastGroup = null;
for (const [i, t] of TABS.entries()) {
  if (t.group !== lastGroup) {
    lastGroup = t.group;
    const g = document.createElement("span");
    g.className = "demo-group";
    g.textContent = t.group;
    $("tabs").appendChild(g);
  }
  const b = document.createElement("button");
  b.className = "demo-tab";
  b.role = "tab";
  b.id = `tab-${t.id}`;
  b.title = `${fullName(t)}: ${t.sub} (key ${i + 1})`;
  b.innerHTML = `<span class="key">${i + 1}</span><span class="name"></span><span class="dot"></span>`;
  b.querySelector(".name").textContent = t.name;
  b.onclick = () => show(t.id);
  $("tabs").appendChild(b);
}

function setLoading(id, on) {
  $(`tab-${id}`).querySelector(".dot").classList.toggle("loading", on);
}

function frameFor(tab) {
  let f = frames.get(tab.id);
  if (f) return f;
  f = document.createElement("iframe");
  f.title = fullName(tab);
  f.src = tab.src;
  setLoading(tab.id, true);
  f.addEventListener("load", () => {
    setLoading(tab.id, false);
    try {
      const style = f.contentDocument.createElement("style");
      style.textContent = EMBED_CSS;
      f.contentDocument.head.appendChild(style);
    } catch {}
    hookKeys(f.contentWindow);
  });
  $("frames").appendChild(f);
  frames.set(tab.id, f);
  return f;
}

function show(id) {
  const tab = TABS.find((t) => t.id === id) || TABS[0];
  if (current && current !== tab.id) {
    const prev = TABS.find((t) => t.id === current);
    const pf = frames.get(current);
    // Grids are cheap and should replay from the start on every visit; also
    // frees their four WebGL contexts.
    if (pf && !prev.keep) {
      pf.remove();
      frames.delete(current);
      setLoading(current, false);
    }
  }
  current = tab.id;
  const f = frameFor(tab);
  for (const other of frames.values()) other.classList.toggle("active", other === f);
  for (const t of TABS) $(`tab-${t.id}`).setAttribute("aria-selected", String(t.id === tab.id));
  $(`tab-${tab.id}`).scrollIntoView({ block: "nearest", inline: "nearest" });
  $("openTab").href = tab.src;
  history.replaceState(null, "", `#${tab.id}`);
  document.title = `${fullName(tab)} · Spatial Arena`;
  renderJumps(tab);
  // The scan keeps looping in the background; start it from its first
  // flight whenever it comes on screen.
  if (tab.id === "scan") {
    try {
      f.contentWindow.factoryReplay?.start(0);
    } catch {}
  }
  // Take keyboard focus back from the previous frame so the keys keep working.
  f.blur();
  window.focus();
}

function renderJumps(tab) {
  const box = $("jumps");
  box.replaceChildren();
  box.hidden = !tab.panel;
  if (!tab.panel) return;
  for (const [text, target] of JUMPS) {
    const b = document.createElement("button");
    b.textContent = text;
    b.title = `Scroll the side panel to ${text.toLowerCase()}`;
    b.onclick = () => jump(tab, target);
    box.appendChild(b);
  }
  if (tab.demo) {
    const l = document.createElement("button");
    l.className = "primary";
    l.textContent = "▶ Learning";
    l.title = "Watch Ripple learn: baseline, the 8 training episodes in order, the frozen strategy, the held-out result (same as the page's ▶ Learning button)";
    l.onclick = () => frames.get(tab.id)?.contentDocument?.getElementById("btnLearn")?.click();
    box.appendChild(l);
    const b = document.createElement("button");
    b.className = "primary";
    b.textContent = "▶ Demo";
    b.title = "Play the three demo beats (same as the page's ▶ Demo button)";
    b.onclick = () => frames.get(tab.id)?.contentDocument?.getElementById("btnDemo")?.click();
    box.appendChild(b);
  }
}

function jump(tab, targetId) {
  const doc = frames.get(tab.id)?.contentDocument;
  const el = doc?.getElementById(targetId);
  const section = el?.closest("section") || el;
  section?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function step(delta) {
  const i = TABS.findIndex((t) => t.id === current);
  show(TABS[(i + delta + TABS.length) % TABS.length].id);
}

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  const n = Number(e.key);
  if (n >= 1 && n <= TABS.length) show(TABS[n - 1].id);
  else if (e.key === "ArrowRight" || e.key === "PageDown") step(1);
  else if (e.key === "ArrowLeft" || e.key === "PageUp") step(-1);
  else {
    // Any other key pressed while focus is on the controller itself goes to
    // the current view, so its own shortcuts (the scan's O/T/B/D camera
    // keys) work without clicking into it first.
    const win = frames.get(current)?.contentWindow;
    if (e.currentTarget === window && win && e.key.length === 1) {
      try {
        win.dispatchEvent(new win.KeyboardEvent("keydown", { key: e.key, bubbles: true }));
      } catch {}
    }
    return;
  }
  e.preventDefault();
}

// Keys must work wherever focus is, including inside a frame (and the scan
// page's own nested frame), so listen in every same-origin window.
function hookKeys(win) {
  try {
    if (!win || win.__demoKeys) return;
    win.__demoKeys = true;
    win.addEventListener("keydown", onKey);
    const hookFrame = (fr) => {
      fr.addEventListener("load", () => hookKeys(fr.contentWindow));
      if (fr.contentDocument?.readyState === "complete") hookKeys(fr.contentWindow);
    };
    win.document.querySelectorAll("iframe").forEach(hookFrame);
    new win.MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.tagName === "IFRAME") hookFrame(n);
    }).observe(win.document.body, { childList: true, subtree: true });
  } catch {}
}
window.addEventListener("keydown", onKey);

show(location.hash.slice(1) || TABS[0].id);

// Warm the slow views in the background, one at a time, once the first view
// has loaded: the factory scan streams for ~25 s on first open.
const warm = TABS.filter((t) => t.keep);
async function preload() {
  for (const t of warm) {
    if (frames.has(t.id)) continue;
    const f = frameFor(t);
    await new Promise((r) => f.addEventListener("load", r, { once: true }));
    await new Promise((r) => setTimeout(r, 800));
  }
}
const first = frames.get(current);
first.addEventListener("load", () => setTimeout(preload, 1500), { once: true });
