// Held-back route split: routes nobody has tuned on, fixed today, revealed
// later.
//
// How it works:
// 1. Commit (now). A random 256-bit seed is drawn and kept private. Only a
//    hash is published (sim/bench/hidden-splits.json): the hash binds the
//    seed, the environment, the number of routes, this generator's source,
//    the map file and the public route sets. Nobody, including us, can change
//    the routes afterwards without the hash failing.
// 2. Score (any time). Whoever holds the seed flies a model on the hidden
//    routes (bench.mjs --set hidden --hidden-seed-file <file>). bench.mjs
//    checks the seed against the published hash before it flies anything.
// 3. Reveal (later). The seed is published; anyone recomputes the hash and the
//    routes with `node sim/tools/arena/hidden_split.mjs verify` and re-flies
//    the recorded flights.
//
// The routes are drawn by makeReachSets (the same rules as every public set:
// distance band, no line of sight, detour) with a seed derived from the
// secret, minus every pair already in train, dev, held-out or test, and minus
// any route that starts or ends at a waypoint used by train or dev (the sets
// harnesses are tuned on; the public sets themselves share endpoints across
// splits). Wind seeds are derived from the secret too, so they can't be
// guessed from the public sets' numbering.
//
// What it does not hide: the map is public, and the generator's candidate
// pool (every qualifying pair, 4,646 in the factory) can be enumerated. A
// harness tuned on all of them is tuned on the hidden routes too. The split
// guards against tuning on the specific routes and winds, and against
// choosing routes after seeing results.
//
//   node sim/tools/arena/hidden_split.mjs commit --map factory --n 24 --seed-out <private file>
//   node sim/tools/arena/hidden_split.mjs verify --map factory --seed-file <file>     (after the reveal)
//   node sim/tools/arena/hidden_split.mjs check                                        (every commitment still matches its code and map)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeReachSets } from "../../src/gym/reach.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "../../..");
export const SCHEME = "spatial-arena-hidden-split/1";
export const COMMIT_FILE = path.join(ROOT, "sim/bench/hidden-splits.json");

const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const fileHash = (rel) => sha(fs.readFileSync(path.join(ROOT, rel)));
// The generator's code: this file and the route rules it calls.
export const GENERATOR_FILES = ["sim/tools/arena/hidden_split.mjs", "sim/src/gym/reach.js"];
export const generatorHash = () => sha(GENERATOR_FILES.map((f) => `${f}\0${fs.readFileSync(path.join(ROOT, f))}`).join("\0"));
const publicPairs = (E) => ["train", "dev", "heldout", "test"].flatMap((k) => (E.sets[k] ?? []).map((s) => [s.start, s.goal].sort().join("|")));
export const tunedWaypoints = (E) => new Set(["train", "dev"].flatMap((k) => (E.sets[k] ?? []).flatMap((s) => [s.start, s.goal])));
export const publicSetsHash = (E) => sha(JSON.stringify(["train", "dev", "heldout", "test"].map((k) => E.sets[k] ?? [])));

function checkSeed(seedHex) {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error("the hidden-split seed must be 64 lowercase hex characters (256 bits)");
}

// What the hash covers, in a fixed order.
export function commitmentBody(E, n, seedHex) {
  checkSeed(seedHex);
  return JSON.stringify({ scheme: SCHEME, environment: E.name, n, seed: seedHex, generator: generatorHash(), map: fileHash(E.map), publicSets: publicSetsHash(E) });
}
export const commitmentOf = (E, n, seedHex) => sha(commitmentBody(E, n, seedHex));

// The hidden routes for a seed. Pure: same seed, same code, same map, same routes.
export function makeHiddenRoutes(E, seedHex, n) {
  checkSeed(seedHex);
  const derive = (label) => crypto.createHash("sha256").update(`${SCHEME}|${seedHex}|${E.name}|${label}`).digest();
  const shuffleSeed = derive("shuffle").readUInt32BE(0);
  const taken = new Set(publicPairs(E));
  const tuned = tunedWaypoints(E);
  // Draw every candidate (in the secret order) so the filters can't run dry early.
  const drawn = makeReachSets(E.world, { ...E.reach, seed: shuffleSeed, train: 0, dev: 0, heldout: 0, test: Number.MAX_SAFE_INTEGER, idPrefix: "", windOffset: 0 }).test;
  const routes = [];
  for (const r of drawn) {
    if (routes.length >= n) break;
    if (taken.has([r.start, r.goal].sort().join("|"))) continue;
    if (tuned.has(r.start) || tuned.has(r.goal)) continue;
    const i = routes.length;
    const w = derive(`wind-${i}`);
    routes.push({ id: `hidden-${E.name}-${i + 1}`, start: r.start, goal: r.goal, straight_m: r.straight_m, graph_m: r.graph_m, seeds: [w.readUInt32BE(0) % 1e9, w.readUInt32BE(4) % 1e9] });
  }
  if (routes.length < n) throw new Error(`${E.name}: only ${routes.length} routes left after removing the public sets (wanted ${n})`);
  return routes;
}

export function readCommitments(file = COMMIT_FILE) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { note: "", splits: [] };
}

// Check a seed against the published commitment for this environment, then
// return the routes. Throws if they don't match: nothing is flown.
export function openHiddenSplit(E, seedHex, file = COMMIT_FILE) {
  const c = readCommitments(file).splits.find((s) => s.environment === E.name);
  if (!c) throw new Error(`no hidden split is committed for ${E.name} in ${path.relative(ROOT, file)}`);
  const got = commitmentOf(E, c.n, seedHex);
  if (got !== c.commitment) {
    const why = c.generator !== generatorHash() ? "the generator code changed since the commitment (check out its commit)" : c.map !== fileHash(E.map) ? "the map changed since the commitment" : c.publicSets !== publicSetsHash(E) ? "the public route sets changed" : "wrong seed";
    throw new Error(`hidden split for ${E.name}: the seed does not match the published commitment (${why})`);
  }
  return { routes: makeHiddenRoutes(E, seedHex, c.n), commitment: c };
}

// ---------- command line ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadEnvironment } = await import("../benchmark_env.mjs");
  const args = process.argv.slice(2);
  const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const cmd = args[0];
  const file = path.resolve(opt("--file", COMMIT_FILE));
  if (cmd === "commit") {
    const E = loadEnvironment(opt("--map", "factory"));
    const n = Number(opt("--n", 24));
    const seedOut = opt("--seed-out");
    if (!seedOut) throw new Error("--seed-out <file> is required: the seed is written there and nowhere else. Keep that file private and backed up.");
    if (fs.existsSync(seedOut)) throw new Error(`${seedOut} exists; refusing to overwrite a seed`);
    const all = readCommitments(file);
    if (all.splits.some((s) => s.environment === E.name)) throw new Error(`${E.name} already has a committed hidden split`);
    const seedHex = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(path.resolve(seedOut)), { recursive: true });
    fs.writeFileSync(seedOut, seedHex + "\n", { mode: 0o600 });
    let gitCommit = null;
    try { gitCommit = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch {}
    all.note = "Hidden route splits (sim/tools/arena/hidden_split.mjs). Each commitment is sha256 of the canonical body (scheme, environment, n, seed, generator, map, publicSets); only the seed is private until the reveal. The routes were not generated when the commitment was made.";
    all.splits.push({ environment: E.name, n, scheme: SCHEME, commitment: commitmentOf(E, n, seedHex), generator: generatorHash(), generatorFiles: GENERATOR_FILES, map: fileHash(E.map), publicSets: publicSetsHash(E), committedAt: new Date().toISOString(), codeCommit: gitCommit, revealed: null });
    fs.writeFileSync(file, JSON.stringify(all, null, 1) + "\n");
    console.log(`committed a hidden split of ${n} routes for ${E.name}; seed written to ${seedOut} (private). Commitment in ${path.relative(ROOT, file)}.`);
  } else if (cmd === "verify") {
    const E = loadEnvironment(opt("--map", "factory"));
    const seedHex = fs.readFileSync(opt("--seed-file"), "utf8").trim();
    const { routes, commitment } = openHiddenSplit(E, seedHex, file);
    console.log(`seed matches the commitment made ${commitment.committedAt}; ${routes.length} routes:`);
    for (const r of routes) console.log(`  ${r.id}: ${r.start} -> ${r.goal}, ${r.straight_m} m, winds ${r.seeds.join(", ")}`);
  } else if (cmd === "check") {
    let bad = 0;
    for (const c of readCommitments(file).splits) {
      const E = loadEnvironment(c.environment);
      const issues = [c.generator !== generatorHash() && "generator code changed", c.map !== fileHash(E.map) && "map changed", c.publicSets !== publicSetsHash(E) && "public sets changed"].filter(Boolean);
      console.log(`${c.environment}: ${issues.length ? issues.join(", ") : "code, map and public sets match the commitment"}`);
      bad += issues.length;
    }
    process.exitCode = bad ? 1 : 0;
  } else {
    console.log("usage: hidden_split.mjs commit|verify|check (see the header of this file)");
  }
}
