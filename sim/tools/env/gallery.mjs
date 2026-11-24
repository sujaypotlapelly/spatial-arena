#!/usr/bin/env node
// One page to review every scanned environment: how it looks (the owner's
// poster and our drone's-eye still), where the drone may fly (the flight
// volume), how far it got through the gates, and its attribution.
//
//   node sim/tools/env/gallery.mjs     # writes sim/environments/reports/gallery.html
import fs from "node:fs";
import path from "node:path";
import { loadManifests, DIR, STAGES } from "./manifests.mjs";

const REPORTS = path.join(DIR, "reports");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function writeGallery() {
  const m = loadManifests();
  const rank = (e) => { const a = e.admission ?? {}; return a.stage >= 2 ? 0 : a.readyIfApproved >= 2 ? 1 : 2; };
  const cards = m.envs.filter((e) => e.kind === "scan" && !e.videoOnly).sort((x, y) => rank(x) - rank(y)).map((e) => {
    const s = m.scenes.find((x) => x.id === e.scene), reg = s?.registry ?? {}, a = e.admission ?? {}, g = a.gates ?? {};
    const still = fs.existsSync(path.join(REPORTS, "stills", `${e.id}-drone-eye.jpg`)) ? `stills/${e.id}-drone-eye.jpg` : null;
    const vol = fs.existsSync(path.join(REPORTS, `volume-${e.mapBuild}.html`)) ? `volume-${e.mapBuild}.html` : null;
    const status = a.stage != null ? `Stage ${a.stage} · ${STAGES[a.stage]}` : a.readyIfApproved != null ? `Awaiting your review · technically stage ${a.readyIfApproved}` : "Not admitted";
    const cls = a.stage >= 2 ? "ok" : a.readyIfApproved >= 2 ? "wait" : "bad";
    const num = (id) => (g[id]?.value != null ? g[id].value : null);
    const facts = [
      ["Scan collider backed by points", num("alignment") != null ? `${Math.round(num("alignment") * 100)}%` : "None"],
      ["Flight space over captured ground", num("coverage") != null ? `${Math.round(num("coverage") * 100)}%` : "None"],
      ["Planner / straight / avoider", num("planner") != null ? `${Math.round(num("planner") * 100)}% / ${Math.round(num("straight") * 100)}% / ${Math.round(num("between") * 100)}%` : "None"],
      ["Search missions", g["missions-search"] ? (g["missions-search"].status === "pass" ? "84, pinned" : g["missions-search"].status) : "None"],
    ];
    const failing = Object.entries(g).filter(([id, x]) => !["pass", "waived", "info"].includes(x.status) && id !== "review").map(([id]) => id);
    return `<article class="card ${cls}" id="${esc(e.id)}">
<div class="pics">${reg.assets?.posterUrl ? `<figure><img loading="lazy" src="${esc(reg.assets.posterUrl)}" alt=""><figcaption>Owner's image</figcaption></figure>` : ""}${still ? `<figure><img loading="lazy" src="${esc(still)}" alt=""><figcaption>Our render, drone's eye at launch</figcaption></figure>` : ""}</div>
<h2>${esc(e.id)} <span class="t">${esc(reg.source?.originalTitle ?? reg.title ?? "")}</span></h2>
<p class="status">${esc(status)}${failing.length ? ` · not passing: ${esc(failing.join(", "))}` : ""}</p>
<p>${esc(e.harness.scene)}</p>
<table>${facts.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
<p class="links"><a href="${esc(e.id)}.html">Report card</a>${vol ? ` · <a href="${esc(vol)}">Flight volume</a>` : ""}${reg.source?.sceneUrl ? ` · <a href="${esc(reg.source.sceneUrl)}">Original scan</a>` : ""}</p>
<p class="attr">${esc(reg.source?.attribution ?? "")}</p>
${a.stage == null && a.readyIfApproved != null ? `<p class="how">To approve: <code>node sim/tools/env/approve.mjs ${esc(e.scene)} --by reviewer-name</code></p>` : ""}
</article>`;
  });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Environment gallery</title><style>
:root{--bg:#fbfbfa;--panel:#fff;--ink:#1d2224;--muted:#5d6669;--line:#dfe3e3;--ok:#14532d;--wait:#9a3412;--bad:#8f1d14;--accent:#22577a}
@media (prefers-color-scheme:dark){:root{--bg:#141718;--panel:#1c2022;--ink:#e6e9ea;--muted:#9aa4a7;--line:#2f3538;--ok:#a6e3b8;--wait:#fdba74;--bad:#ffb4aa;--accent:#8cc4e8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif}main{max-width:1200px;margin:0 auto;padding:24px 16px 80px}
h1{margin:0 0 4px}.lede{color:var(--muted);max-width:820px}a{color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px;margin-top:18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;border-top:4px solid var(--line)}.card.ok{border-top-color:var(--ok)}.card.wait{border-top-color:var(--wait)}.card.bad{border-top-color:var(--bad)}
.pics{display:grid;grid-template-columns:1fr 1fr;gap:6px}.pics figure{margin:0}.pics img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:8px;background:var(--line);display:block}figcaption{font-size:12px;color:var(--muted)}
h2{font-size:18px;margin:10px 0 2px}.t{font-weight:400;color:var(--muted);font-size:14px}.status{margin:2px 0 6px;font-weight:600}.ok .status{color:var(--ok)}.wait .status{color:var(--wait)}.bad .status{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:3px 0;border-bottom:1px solid var(--line)}td:last-child{text-align:right}
.links{font-size:14px}.attr{font-size:12px;color:var(--muted)}.how{font-size:13px}code{font-size:12px}
</style></head><body><main><h1>Environment gallery</h1>
<p class="lede">Every scanned environment in the arena: how it looks, where the drone may fly (only over ground the scan captured), and how far it got through the admission gates. Green: stage 2 or higher. Amber: passes the technical gates and waits for a person to approve the look. Red: something fails. Nothing appears in the film or article below stage 3; nothing carries a number below stage 4.</p>
<div class="grid">${cards.join("")}</div></main></body></html>`;
  fs.writeFileSync(path.join(REPORTS, "gallery.html"), html);
  return cards.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) console.log(`wrote sim/environments/reports/gallery.html (${writeGallery()} environments)`);
