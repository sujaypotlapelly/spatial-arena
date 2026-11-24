#!/usr/bin/env node
// Check an environment against the admission gates (docs/CONTRIBUTING_ENVIRONMENTS.md),
// record its stage in its manifest, and write a report card.
//
//   node sim/tools/env/admit.mjs canyon5             # stages 0-2, update the manifest, write the report
//   node sim/tools/env/admit.mjs --all               # every environment
//   node sim/tools/env/admit.mjs --all --check       # CI: fail if any environment fell below its recorded stage
//   node sim/tools/env/admit.mjs canyon5 --dry-run   # print only
//
// Stages 3 (demo-ready) and 4 (measured) are recorded by hand for now; this
// command checks stages 0-2. Waive a failed gate only with a reason, in the
// manifest: admission.signoffs.<gate> = { "waive": true, "by": "...", "date": "...", "reason": "..." }.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { loadManifests, environment, envFile, sceneFile, writeJson, root, DIR, STAGES } from "./manifests.mjs";
import { stage0, stage1, stage2, applyWaivers, infoOnly, loadWorld, THRESHOLDS } from "./gates.mjs";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const ids = args.filter((a) => !a.startsWith("--"));
const REPORTS = path.join(DIR, "reports");

const commit = () => { try { return execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; } };
const ok = (g) => g.status === "pass" || g.status === "waived" || g.status === "info";

export async function admit(id, m = loadManifests()) {
  const { env, scene, map } = environment(id, m);
  const ctx = { env, scene, map };
  const signoffs = env.admission?.signoffs ?? {};
  const results = [];
  let stage = null;
  const g0 = infoOnly(applyWaivers(stage0(ctx), { ...(scene?.admission?.signoffs ?? {}), ...signoffs }));
  results.push(...g0);
  if (g0.every(ok)) stage = 0;
  ctx.world = loadWorld(env);
  const g1 = infoOnly(applyWaivers(stage1(ctx), signoffs));
  results.push(...g1);
  if (stage === 0 && g1.every(ok)) stage = 1;
  const g2 = applyWaivers(await stage2(ctx), signoffs);
  results.push(...g2);
  if (stage === 1 && g2.every(ok)) stage = 2;
  // How far it gets on the technical gates alone, while a person's review of
  // the look (stage 0 "review") is still pending.
  const tech = (g) => ok(g) || g.id === "review";
  let ready = null;
  if (g0.every(tech)) { ready = 0; if (g1.every(tech)) { ready = 1; if (g2.every(tech)) ready = 2; } }
  return { env, scene, map, ctx, results, stage, readyIfApproved: ready };
}

function record(r) {
  const { env, scene } = r;
  const prior = env.admission?.stage ?? null;
  // Stages 3-4 are set by hand; keep them while stages 0-2 still pass.
  const kept = prior != null && prior > 2 && r.stage === 2 ? prior : r.stage;
  env.admission = { ...env.admission, stage: kept, readyIfApproved: r.readyIfApproved, checkedAt: new Date().toISOString().slice(0, 10), commit: commit(),
    gates: Object.fromEntries(r.results.map((g) => [g.id, { stage: g.stage, status: g.status, ...(g.value !== undefined ? { value: g.value } : {}), detail: g.detail }])) };
  writeJson(envFile(env.id), env);
  if (scene) {
    const s0 = r.results.filter((g) => g.stage === 0);
    scene.admission = { ...scene.admission, stage: s0.every(ok) ? 0 : null, checkedAt: env.admission.checkedAt,
      gates: Object.fromEntries(s0.map((g) => [g.id, { status: g.status, detail: g.detail }])) };
    writeJson(sceneFile(scene.id), scene);
  }
  return kept;
}

// ---------------------------------------------------------------- report card
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const LABEL = { pass: "Pass", fail: "Fail", waived: "Waived", "not-checked": "Not checked", info: "Info" };

function topDown(r) {
  const w = r.ctx.world, { min, max } = w.bounds;
  const W = 640, sx = W / (max[0] - min[0]), H = Math.round((max[2] - min[2]) * sx);
  const X = (p) => ((p[0] - min[0]) * sx).toFixed(1), Z = (p) => ((p[2] - min[2]) * sx).toFixed(1);
  const parts = [];
  for (const [a, b] of w.map.edges) { const A = w.nodes[a], B = w.nodes[b]; parts.push(`<line x1="${X(A)}" y1="${Z(A)}" x2="${X(B)}" y2="${Z(B)}" class="e"/>`); }
  for (const p of Object.values(w.nodes)) parts.push(`<circle cx="${X(p)}" cy="${Z(p)}" r="1.6" class="n"/>`);
  for (const sc of r.ctx.sets?.dev ?? []) {
    parts.push(`<circle cx="${X(sc.start)}" cy="${Z(sc.start)}" r="3" class="s"/><circle cx="${X(sc.goal)}" cy="${Z(sc.goal)}" r="3" class="g"/>`);
  }
  for (const t of r.ctx.targets ?? []) {
    const bad = t.captured === false || t.sky === false;
    parts.push(`<rect x="${(+X(t.p) - 3).toFixed(1)}" y="${(+Z(t.p) - 3).toFixed(1)}" width="6" height="6" class="${bad ? "tb" : "t"}"><title>${esc(t.id)}${t.captured === false ? " · not captured" : ""}${t.sky === false ? " · not open to the sky" : ""}</title></rect>`);
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Top-down map of the flight graph, development routes and mission targets">${parts.join("")}</svg>`;
}

function reportHtml(r) {
  const byStage = [0, 1, 2].map((s) => r.results.filter((g) => g.stage === s));
  const stageName = r.stage == null ? (r.readyIfApproved != null ? `Awaiting review of the look · technically stage ${r.readyIfApproved} (${STAGES[r.readyIfApproved]})` : "Not admitted") : `Stage ${r.stage} · ${STAGES[r.stage]}`;
  const src = r.scene?.registry?.source;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.env.id)} admission</title><style>
:root{--bg:#fbfbfa;--panel:#fff;--ink:#1d2224;--muted:#5d6669;--line:#dfe3e3;--ok:#14532d;--bad:#8f1d14;--warn:#9a3412;--accent:#22577a;--map:#eef1f1}
@media (prefers-color-scheme:dark){:root{--bg:#141718;--panel:#1c2022;--ink:#e6e9ea;--muted:#9aa4a7;--line:#2f3538;--ok:#a6e3b8;--bad:#ffb4aa;--warn:#fdba74;--accent:#8cc4e8;--map:#1a1f21}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,sans-serif}
main{max-width:960px;margin:0 auto;padding:28px 16px 80px}h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px}
.lede{color:var(--muted);margin:0 0 16px}a{color:var(--accent)}.big{font-size:20px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;vertical-align:top;padding:7px 8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600}
.chip{font-size:13px;padding:1px 8px;border-radius:99px;border:1px solid;white-space:nowrap}.info{color:var(--muted)}.pass{color:var(--ok)}.fail{color:var(--bad)}.waived,.not-checked{color:var(--warn)}
svg{width:100%;height:auto;background:var(--map);border-radius:8px;border:1px solid var(--line)}
.e{stroke:var(--muted);stroke-opacity:.25;stroke-width:.6}.n{fill:var(--muted);fill-opacity:.6}.s{fill:#3b82f6}.g{fill:#16a34a}.t{fill:#16a34a;stroke:#fff;stroke-width:.6}.tb{fill:#dc2626;stroke:#fff;stroke-width:.6}
.legend{font-size:14px;color:var(--muted)}
</style></head><body><main>
<p class="lede"><a href="index.html">← All environments</a></p>
<h1>${esc(r.env.id)}${src?.originalTitle ? ` · ${esc(src.originalTitle)}` : ""}</h1>
<p class="lede">${esc(r.env.harness.map)} · ${r.env.kind === "scan" ? `scan by ${esc(src?.creator ?? "unknown")}${src?.license ? `, ${esc(src.license)}` : ""}` : "built from boxes"} · checked ${esc(r.env.admission.checkedAt)} at ${esc(r.env.admission.commit ?? "uncommitted")}</p>
<p class="big">${esc(stageName)}</p>
<p class="lede">Stage 3 (demo-ready) and 4 (measured) are recorded by hand. A stage passes only when every gate in it passes or was waived by a person with a reason.</p>
${byStage.map((gs, s) => `<h2>Stage ${s} · ${STAGES[s]}</h2><table><thead><tr><th>Gate</th><th>Result</th><th>Detail</th></tr></thead><tbody>${gs.map((g) => `<tr><td>${esc(g.title)}</td><td><span class="chip ${g.status}">${LABEL[g.status]}</span></td><td>${esc(g.detail)}</td></tr>`).join("")}</tbody></table>`).join("")}
<h2>Map</h2>
<p class="legend">Top-down, north up. Grey: flight graph. Blue and green dots: development route starts and goals. Squares: mission targets, red where a target is uncaptured or not open to the sky.</p>
${topDown(r)}
<h2>Thresholds</h2>
<p class="legend">${esc(JSON.stringify({ ...THRESHOLDS, approvedReviews: String(THRESHOLDS.approvedReviews) }))}</p>
</main></body></html>`;
}

function indexHtml(m) {
  const rows = m.envs.map((e) => {
    const a = e.admission ?? {};
    const fails = Object.entries(a.gates ?? {}).filter(([, g]) => !["pass", "waived", "info"].includes(g.status));
    const report = fs.existsSync(path.join(REPORTS, e.id + ".html")) ? `<a href="${esc(e.id)}.html">${esc(e.id)}</a>` : esc(e.id);
    return `<tr><td>${report}</td><td>${a.stage == null ? (a.readyIfApproved != null ? `Awaiting review (technically ${a.readyIfApproved} · ${STAGES[a.readyIfApproved]})` : "Not admitted") : `${a.stage} · ${STAGES[a.stage]}`}</td><td>${fails.length ? fails.map(([id, g]) => `<span class="chip ${g.status}">${esc(id)}</span>`).join(" ") : "None"}</td><td>${esc(a.checkedAt ?? "never")}</td></tr>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Environment admission</title><style>
:root{--bg:#fbfbfa;--ink:#1d2224;--muted:#5d6669;--line:#dfe3e3;--bad:#8f1d14;--warn:#9a3412;--accent:#22577a}
@media (prefers-color-scheme:dark){:root{--bg:#141718;--ink:#e6e9ea;--muted:#9aa4a7;--line:#2f3538;--bad:#ffb4aa;--warn:#fdba74;--accent:#8cc4e8}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,sans-serif}main{max-width:900px;margin:0 auto;padding:28px 16px}
a{color:var(--accent)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted)}
.chip{font-size:13px;padding:1px 8px;border-radius:99px;border:1px solid;margin:0 4px 4px 0;display:inline-block}.fail{color:var(--bad)}.not-checked{color:var(--warn)}.lede{color:var(--muted)}
</style></head><body><main><h1>Environment admission</h1><p class="lede">Each row shows the checks a place has passed and what it still needs. See the <a href="../../../docs/CONTRIBUTING_ENVIRONMENTS.md">environment guide</a> to add a place.</p>
<table><thead><tr><th>Environment</th><th>Stage</th><th>Gates not passing</th><th>Checked</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
}

async function main() {
  const m = loadManifests();
  if (m.problems.length) { console.error(m.problems.join("\n")); process.exit(1); }
  const list = flag("--all") ? m.envs.filter((e) => !e.videoOnly).map((e) => e.id) : ids;
  if (!list.length) { console.error("usage: node sim/tools/env/admit.mjs <environment> | --all [--check] [--dry-run]"); process.exit(2); }
  let regressions = 0;
  for (const id of list) {
    const t0 = Date.now();
    const r = await admit(id, m);
    const fails = r.results.filter((g) => !ok(g));
    console.log(`${id}: ${r.stage == null ? `not admitted${r.readyIfApproved != null && r.readyIfApproved !== r.stage ? `; stage ${r.readyIfApproved} once its look is approved` : ""}` : `stage ${r.stage} (${STAGES[r.stage]})`} in ${((Date.now() - t0) / 1000).toFixed(1)} s${fails.length ? `; not passing: ${fails.map((g) => `${g.id} (${g.status})`).join(", ")}` : ""}`);
    const prior = r.env.admission?.stage;
    if (flag("--check") && prior != null && (r.stage ?? -1) < Math.min(prior, 2)) { regressions++; console.error(`  ${id} fell from stage ${prior} to ${r.stage}`); }
    if (flag("--dry-run") || flag("--check")) continue;
    record(r);
    fs.mkdirSync(REPORTS, { recursive: true });
    fs.writeFileSync(path.join(REPORTS, `${id}.html`), reportHtml(r));
  }
  if (!flag("--dry-run") && !flag("--check")) fs.writeFileSync(path.join(REPORTS, "index.html"), indexHtml(loadManifests()));
  if (regressions) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch((e) => { console.error(e.stack); process.exit(1); });
