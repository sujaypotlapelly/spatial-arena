// In-context learning for Reach: Ripple flies the TRAIN routes, reads the
// simulator's verdict on its own flights, and writes notes (at most 200
// words) for future flights. Repeated for --rounds, each round flying with
// the previous round's notes. Also writes a placebo of matched length.
// Dev and held-out routes are never seen here.
//   node sim/tools/study/reach_learn.mjs --level C3 --rounds 2 --out runs/reach/learn-c3
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { World, v } from "../../src/world.js";
import { Reach, makeReachSets } from "../../src/gym/reach.js";
import { runEpisode } from "../../src/gym/core.js";
import { rippleReach } from "../../src/gym/reach_agents.js";
import { makeClient, preflight } from "../ripple_client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const args = process.argv.slice(2);
const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const level = opt("--level", "C3");
const rounds = Number(opt("--rounds", 2));
const outDir = path.resolve(opt("--out", path.join(root, "runs/reach/learn-" + level.toLowerCase())));
fs.mkdirSync(outDir, { recursive: true });
const world = new World(JSON.parse(fs.readFileSync(path.join(here, "../../maps/factory-full.json"))));
const train = makeReachSets(world).train.slice(0, Number(opt("--limit", 12)));
const client = makeClient({ root, maxInFlight: Number(opt("--concurrency", 12)), logFile: path.join(outDir, "calls.jsonl") });
console.log(`preflight ok on ${await preflight(client)}`);

const r1 = (p) => p.map((x) => Math.round(x * 10) / 10);
function digest(sc, ep) {
  const r = ep.result;
  const verdict = r.outcome === "reached" ? `REACHED the goal in ${r.time} s` : `FAILED: out of time; closest it got to the goal was ${r.minGoalDist} m`;
  const moments = ep.decisions.filter((_, i) => i % 6 === 0).slice(0, 12).map((d) => {
    const f = ep.frames.find((fr) => fr[0] >= d.t - 1e-6) || ep.frames[ep.frames.length - 1];
    return `  t=${d.t}s at ${JSON.stringify(r1([f[1], f[2], f[3]]))}: ${JSON.stringify(d.command)}${d.say ? ` ("${d.say}")` : ""}`;
  });
  const contacts = ep.decisions.length ? `${r.contacts} wall contacts` : "";
  return `Flight from ${JSON.stringify(r1(world.nodes[sc.start]))} to goal ${JSON.stringify(r1(world.nodes[sc.goal]))} (${sc.straight_m} m apart in a straight line): ${verdict}. ${contacts}.\n${moments.join("\n")}`;
}

let notes = null;
const log = [];
for (let round = 1; round <= rounds; round++) {
  const eps = await Promise.all(train.map(async (sc) => ({ sc, ep: await runEpisode(new Reach(world, sc, sc.seeds[0], level), rippleReach(world, sc, level, client.chat, { notes })) })));
  const reached = eps.filter((x) => x.ep.result.outcome === "reached").length;
  const progress = eps.reduce((a, x) => a + Math.max(0, 1 - x.ep.result.minGoalDist / x.sc.straight_m), 0) / eps.length;
  const msgs = [
    { role: "system", content: "You pilot a drone through an indoor building and are writing notes to your future self. Reply with the notes only, as plain text." },
    {
      role: "user",
      content: `You fly a drone through the same factory building (a 3D scan: halls, rooms, pillars, machinery, clutter) with no map. Coordinates are [x, y, z] in metres: +x is east, +z is north, +y is up. Every second you give a velocity [vx, vy, vz] that the drone holds for one second; nothing plans a path for you. You sense your position, velocity, the goal's position and free space in 8 compass directions plus up and down.
${notes ? `\nYour current notes:\n${notes}\n` : ""}
Here are your flights from the last round, with the simulator's verdicts:

${eps.map((x) => digest(x.sc, x.ep)).join("\n\n")}

Write updated notes for future flights in this building (at most 200 words). Keep what these results support, drop what they contradict, and add concrete rules: how to turn the goal's position into a correct velocity, how to use the free-space readings, how to get around obstacles, and anything you learned about the building's layout (where walls, openings and corridors are, by coordinates).`,
    },
  ];
  const r = await client.chat(msgs, { role: "notes", round }, { max_tokens: 600 });
  const words = r.content.trim().split(/\s+/);
  notes = words.slice(0, 260).join(" ");
  fs.writeFileSync(path.join(outDir, `notes-round${round}.json`), JSON.stringify({ text: notes, round, level, trainScenarios: train.map((s) => s.id), trainReached: reached, trainProgress: progress }, null, 1));
  log.push({ round, reached, progress, words: notes.split(/\s+/).length });
  console.log(`round ${round}: train reached ${reached}/${train.length}, progress ${Math.round(progress * 100)}%; notes ${notes.split(/\s+/).length} words`);
}
// Placebo: generic advice of the same length as the final notes.
const placebo = fs.readFileSync(path.join(here, "../../scenarios/placebo-notes.txt"), "utf8").trim().split(/\s+/);
const n = notes.split(/\s+/).length;
fs.writeFileSync(path.join(outDir, "placebo.json"), JSON.stringify({ text: Array.from({ length: n }, (_, i) => placebo[i % placebo.length]).join(" "), matchedWords: n }, null, 1));
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ level, rounds: log, ledger: client.ledger }, null, 1));
client.close();
console.log("wrote", path.relative(root, outDir));
