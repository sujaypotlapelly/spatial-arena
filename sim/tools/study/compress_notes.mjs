// Ask Ripple to compress its own notes to the few facts that matter most
// (the notes were learned on train routes only).
//   node sim/tools/study/compress_notes.mjs runs/reach/learn-c3/notes-round2.json runs/reach/learn-c3/notes-short.json --words 60
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeClient, preflight } from "../ripple_client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const [src, dst] = process.argv.slice(2);
const args = process.argv.slice(2);
const words = Number(args.includes("--words") ? args[args.indexOf("--words") + 1] : 60);
const notes = JSON.parse(fs.readFileSync(src)).text;
const client = makeClient({ root, maxInFlight: 1, logFile: path.join(path.dirname(dst), "compress-calls.jsonl") });
await preflight(client);
const r = await client.chat(
  [
    { role: "system", content: "Reply with the compressed notes only, as plain text." },
    { role: "user", content: `These are your notes for flying a drone through a factory building (axes: +x east, +z north, +y up). Compress them to the 5 most useful facts for reaching a goal, at most ${words} words in total. Keep coordinates where they matter. Fix anything that confuses height (y) with north-south (z).\n\n${notes}` },
  ],
  { role: "compress-notes" },
  { max_tokens: 200 },
);
const text = r.content.trim().split(/\s+/).slice(0, words + 10).join(" ");
fs.writeFileSync(dst, JSON.stringify({ text, from: src, words: text.split(/\s+/).length }, null, 1));
client.close();
console.log(text);
