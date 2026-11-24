#!/usr/bin/env node
// Convert an explicitly cropped SuperSplat v1.1 collider into the simulator's
// RLE map format. This does not infer a metre scale, select routes, or invent
// navigable space missing from the collider.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SplatVoxels, convertSplatToMap } from "../../src/splat_voxels.js";

const usage = `Usage:
  node sim/tools/maps/import_splat_map.mjs --meta cache/splat-scenes/canyon/scene.voxel.json --inspect
  node sim/tools/maps/import_splat_map.mjs --meta .../scene.voxel.json --bounds '{"min":[0,0,0],"max":[10,5,10]}' --cell 0.25 --out runs/splat-maps/canyon.json

Options:
  --bin PATH          Binary path (default: matching .voxel.bin)
  --transform JSON    {position:[x,y,z],rotation:[x,y,z],scale:1}; degrees X→Y→Z
  --max-cells N       Maximum dense cells before conversion (default 2000000)
  --base-map PATH     Reuse map metadata/waypoints; drop old geometry and splat
  --name TEXT         Output map name
  --inspect           Validate and print metadata without dense conversion
  --gzip              Also write OUT.gz

Crop bounds and cell size are in transformed scene units. Specify calibration
separately before interpreting any distance or simulation speed as metres.
`;

function parse(argv) {
  const a = {};
  const flags = new Set(["help", "inspect", "gzip"]);
  const values = new Set(["meta", "bin", "bounds", "cell", "transform", "max-cells", "base-map", "name", "out"]);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || (!flags.has(key) && !values.has(key))) throw new Error(`Unknown argument: ${argv[i]}`);
    if (flags.has(key)) a[key] = true;
    else {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`Missing value for --${key}`);
      a[key] = argv[++i];
    }
  }
  return a;
}

export async function main(argv = process.argv.slice(2)) {
  const a = parse(argv);
  if (a.help) { console.log(usage); return; }
  if (!a.meta) throw new Error("--meta is required; use --help for examples");
  const metaPath = resolve(a.meta);
  if (!metaPath.endsWith(".voxel.json") && !a.bin) throw new Error("--bin is required when metadata is not named *.voxel.json");
  const binPath = resolve(a.bin ?? metaPath.replace(/\.voxel\.json$/, ".voxel.bin"));
  const metaBytes = await readFile(metaPath), wire = await readFile(binPath);
  const binary = wire[0] === 0x1f && wire[1] === 0x8b ? gunzipSync(wire) : wire;
  const voxels = new SplatVoxels(JSON.parse(metaBytes), binary, { transform: a.transform ? JSON.parse(a.transform) : {} });
  const source = { metadata: metaPath, binary: binPath, metadataSha256: createHash("sha256").update(metaBytes).digest("hex"), binarySha256: createHash("sha256").update(binary).digest("hex"), binaryBytes: binary.length };
  if (a.inspect) {
    console.log(JSON.stringify({ ...source, bounds: voxels.bounds, sourceBounds: voxels.sourceBounds, sourceVoxelResolution: voxels.resolution, transformedVoxelResolution: voxels.voxelResolution, transform: voxels.transform, calibration: "unverified", nodes: voxels.nodes.length }, null, 2));
    return;
  }
  if (!a.bounds || !a.cell || !a.out) throw new Error("conversion requires --bounds, --cell, and --out");
  const base = a["base-map"] ? JSON.parse(await readFile(resolve(a["base-map"]), "utf8")) : {};
  // These are the simulator's normal dynamic limits, interpreted in scene units
  // until the supplied transform has a separately established metre scale.
  const physics = { dt: 1 / 60, maxTime: 90, droneRadius: 0.25, droneMaxAccel: 7, droneMaxSpeed: 5.5, birdRadius: 0.35, birdMaxAccel: 6, birdMaxSpeed: 4.6, catchDistance: 0.9, birdStamina: 9, birdRest: 3, gust: 0.8, observeSeconds: 2, ...base.physics };
  const { voxels: _oldGrid, boxes: _oldBoxes, splat: _oldSplat, notes: _oldNotes, splatCollision: _oldSource, bounds: _oldBounds, ...baseFields } = base;
  const map = convertSplatToMap(voxels, { ...baseFields, physics, name: a.name ?? base.name ?? "Imported SuperSplat voxel crop", bounds: JSON.parse(a.bounds), cell: Number(a.cell), maxCells: Number(a["max-cells"] ?? 2_000_000) });
  map.splatCollision.source = source;
  const out = resolve(a.out), json = `${JSON.stringify(map)}\n`;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, json);
  if (a.gzip) await writeFile(`${out}.gz`, gzipSync(json));
  console.log(JSON.stringify({ out, cells: map.splatCollision.cells, occupiedCells: map.splatCollision.solidCells, dims: map.voxels.dims, bytes: Buffer.byteLength(json), calibration: "unverified" }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
