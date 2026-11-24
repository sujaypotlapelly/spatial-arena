#!/usr/bin/env node
// Mirror a licensed registry scene's streamed-SOG reference graph for offline
// use. Root URLs come only from the selected registry entry; metadata may name
// relative files within that root directory, never arbitrary external URLs.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hash = (b) => createHash("sha256").update(b).digest("hex");
const inside = (root, p) => p === root || p.startsWith(`${root}${path.sep}`);
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const ASSET_EXT = /\.(?:json|webp|png|jpe?g|avif|ktx2?|bin|sog|spz|ply|splat|hdr|exr|basis|dds|radc?|zip)(?:\?.*)?$/i;
const REF_KEYS = new Set(["file", "files", "filename", "filenames", "uri", "uris", "url", "urls", "src"]);

// Fail on traversal even if URL normalization would collapse it back inside.
export function resolveReference(reference, parentUrl, rootUrl) {
  assert(typeof reference === "string" && reference.length > 0 && reference.length <= 2048, "Invalid asset reference");
  assert(!/[\\\x00-\x20]/.test(reference) && !reference.startsWith("/") && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(reference), `Only relative metadata references are allowed: ${reference}`);
  let decoded;
  try { decoded = decodeURIComponent(reference); } catch { throw new Error(`Malformed encoded asset path: ${reference}`); }
  assert(!decoded.includes("\\") && !decoded.includes("?") && !decoded.includes("#") && !decoded.includes("%"), `Unsupported escaped/query asset path: ${reference}`);
  assert(!decoded.split("/").some((part) => part === ".." || part === "." || part === ""), `Unsafe relative asset path: ${reference}`);
  const root = new URL(".", rootUrl), resolved = new URL(reference, parentUrl);
  assert(resolved.origin === root.origin && resolved.pathname.startsWith(root.pathname) && !resolved.search && !resolved.hash, `Asset escaped root directory: ${reference}`);
  const relative = decodeURIComponent(resolved.pathname.slice(root.pathname.length));
  assert(relative.length > 0 && !relative.split("/").some((part) => part === ".." || part === "." || !part), `Unsafe local asset path: ${reference}`);
  return { url: resolved.href, path: relative };
}

export function assetReferences(metadata) {
  const refs = [];
  const walk = (value, key = "") => {
    if (typeof value === "string") {
      if (REF_KEYS.has(key) || ASSET_EXT.test(value)) refs.push(value);
    } else if (Array.isArray(value)) value.forEach((v) => walk(v, key));
    else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => walk(v, k));
  };
  walk(metadata);
  return [...new Set(refs)];
}

async function boundedBody(response, maxFileBytes) {
  assert(response.body, "Response has no body");
  const chunks = [], reader = response.body.getReader();
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxFileBytes) { await reader.cancel(); throw new Error(`Asset exceeds decoded file limit (${maxFileBytes} bytes)`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

export async function cacheStreamedScene(scene, {
  outDirectory, indexPath, concurrency = 4, retries = 2,
  maxTotalBytes = 150 * 1024 * 1024, maxFileBytes = 64 * 1024 * 1024,
  maxFiles = 500, fetchFn = fetch, onProgress = () => {},
} = {}) {
  assert(scene?.source?.license === "CC BY 4.0", "This cache tool requires an explicit CC BY 4.0 registry license");
  const rootUrl = new URL(scene.assets.splatUrl);
  assert(rootUrl.protocol === "https:" && !rootUrl.username && !rootUrl.password && !rootUrl.search && !rootUrl.hash, "Invalid registry root URL");
  // Streamed SOG starts at lod-meta.json; a single (unstreamed) SOG at meta.json.
  assert(rootUrl.pathname.endsWith("/lod-meta.json") || rootUrl.pathname.endsWith("/meta.json"), "Expected a SOG scene root (lod-meta.json or meta.json)");
  assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4, "Concurrency must be 1–4");
  assert(Number.isInteger(retries) && retries >= 0 && retries <= 4, "Retries must be 0–4");
  assert(Number.isSafeInteger(maxFiles) && maxFiles > 0 && maxFiles <= 10000, "Invalid maxFiles");
  assert(Number.isSafeInteger(maxTotalBytes) && maxTotalBytes > 0 && Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0, "Invalid byte limits");
  assert(outDirectory && indexPath, "Explicit output directory and index path are required");
  const out = path.resolve(outDirectory), index = path.resolve(indexPath);
  await fs.mkdir(out, { recursive: true });
  const realOut = await fs.realpath(out);
  const rootFile = path.posix.basename(rootUrl.pathname);
  const queue = [{ path: rootFile, url: rootUrl.href }], seen = new Map([[rootFile, rootUrl.href]]), files = new Map(), failures = [];
  const startedAt = new Date().toISOString();
  let totalBytes = 0;
  const source = structuredClone(scene.source);
  const snapshot = (complete, state = "downloading") => ({
    schemaVersion: 1, kind: "offline-streamed-splat-bundle", sceneId: scene.id, complete, state,
    startedAt, updatedAt: new Date().toISOString(), source, rootSourceUrl: rootUrl.href,
    entrypoint: `${path.relative(path.dirname(index), out).split(path.sep).join("/")}/${rootFile}`,
    assetDirectory: path.relative(path.dirname(index), out).split(path.sep).join("/"),
    license: scene.source.license, attribution: scene.source.attribution, transform: scene.transform,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    totalFiles: files.size, totalDecodedBytes: [...files.values()].reduce((n, f) => n + f.decodedBytes, 0),
    discoveredFiles: seen.size, failures, limits: { concurrency, retries, maxTotalBytes, maxFileBytes, maxFiles },
    note: "Unchanged source file contents with preserved relative paths. HTTP decompression is handled by fetch; sizes and SHA-256 refer to decoded local bytes. No physical metre calibration is inferred.",
  });
  const writeIndex = async (complete, state) => {
    await fs.mkdir(path.dirname(index), { recursive: true });
    const temp = `${index}.partial`;
    await fs.writeFile(temp, `${JSON.stringify(snapshot(complete, state), null, 2)}\n`);
    await fs.rename(temp, index);
  };
  await writeIndex(false, "downloading");

  const save = async (item) => {
    const destination = path.resolve(out, item.path);
    assert(inside(out, destination), `Local path escaped asset directory: ${item.path}`);
    let bytes, contentType = null, contentEncoding = null, status;
    let failure;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetchFn(item.url, { redirect: "error", signal: AbortSignal.timeout(45000) });
        assert(response.ok, `HTTP ${response.status} for ${item.url}`);
        bytes = await boundedBody(response, maxFileBytes);
        contentType = response.headers.get("content-type"); contentEncoding = response.headers.get("content-encoding"); status = response.status;
        failure = null;
        break;
      } catch (error) {
        failure = error;
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }
    if (failure) throw failure;
    const references = item.path.endsWith(".json") ? assetReferences(JSON.parse(bytes.toString("utf8"))).map((ref) => resolveReference(ref, item.url, rootUrl.href)) : [];
    const additions = references.filter((r) => !seen.has(r.path));
    assert(seen.size + additions.length <= maxFiles, `Reference graph exceeds maxFiles=${maxFiles}`);
    assert(totalBytes + bytes.length <= maxTotalBytes, `Scene exceeds decoded total limit (${maxTotalBytes} bytes)`);
    totalBytes += bytes.length;
    for (const ref of references) {
      assert(!seen.has(ref.path) || seen.get(ref.path) === ref.url, `Conflicting URLs for ${ref.path}`);
      if (!seen.has(ref.path)) { seen.set(ref.path, ref.url); queue.push(ref); }
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    assert(inside(realOut, await fs.realpath(path.dirname(destination))), "Asset directory contains an escaping symlink");
    const temporary = `${destination}.partial`;
    await fs.writeFile(temporary, bytes);
    await fs.rename(temporary, destination);
    const record = { path: item.path, sourceUrl: item.url, decodedBytes: bytes.length, sha256: hash(bytes), contentType, contentEncoding, httpStatus: status, license: scene.source.license, creator: scene.source.creator, references: references.map((r) => r.path) };
    files.set(item.path, record);
    onProgress({ path: item.path, bytes: bytes.length, completed: files.size, discovered: seen.size });
  };
  try {
    while (queue.length) {
      const batch = queue.splice(0, concurrency);
      const results = await Promise.allSettled(batch.map(save));
      results.forEach((result, i) => { if (result.status === "rejected") failures.push({ path: batch[i].path, url: batch[i].url, error: String(result.reason?.message ?? result.reason) }); });
      await writeIndex(false, failures.length ? "failed" : "downloading");
      if (failures.length) throw new Error(`Failed ${failures.length} asset(s); incomplete bundle index saved at ${index}`);
    }
    assert(files.size === seen.size, "Not all discovered assets were downloaded");
    // Completion means the disk files and reference closure were checked,
    // rather than merely that all network requests returned.
    for (const record of files.values()) {
      const bytes = await fs.readFile(path.join(out, record.path));
      assert(bytes.length === record.decodedBytes && hash(bytes) === record.sha256, `Disk integrity failure for ${record.path}`);
      assert(record.references.every((ref) => files.has(ref)), `Missing dependency of ${record.path}`);
    }
    await writeIndex(true, "complete");
    return snapshot(true, "complete");
  } catch (error) {
    if (!failures.length) failures.push({ error: String(error.message ?? error) });
    await writeIndex(false, "failed");
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), root = ROOT) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--help") {
      console.log("Cache the approved canyon splat and all referenced tiles/textures:\nnode sim/tools/maps/cache_splat_scene.mjs --scene canyon\nOptions: --registry PATH --out DIRECTORY --index PATH --concurrency 1..4 --retries 0..4 --max-total-mib 150");
      return;
    }
    assert(["--scene", "--registry", "--out", "--index", "--concurrency", "--retries", "--max-total-mib"].includes(key) && argv[i + 1] && !argv[i + 1].startsWith("--"), `Invalid option ${key}`);
    options[key] = argv[++i];
  }
  const registry = JSON.parse(await fs.readFile(path.resolve(root, options["--registry"] ?? "sim/scenes/rescue-scenes.json"), "utf8"));
  const id = options["--scene"] ?? "canyon", scene = registry.scenes.find((s) => s.id === id);
  assert(scene, `Unknown registry scene ${id}`);
  const base = path.resolve(root, scene.assets.cacheDirectory);
  const result = await cacheStreamedScene(scene, {
    outDirectory: path.resolve(root, options["--out"] ?? path.join(base, "assets")),
    indexPath: path.resolve(root, options["--index"] ?? path.join(base, "asset-bundle.json")),
    concurrency: Number(options["--concurrency"] ?? 4), retries: Number(options["--retries"] ?? 2), maxTotalBytes: Number(options["--max-total-mib"] ?? 150) * 1024 * 1024,
    onProgress: ({ path: file, bytes }) => console.log(`${file} ${bytes} bytes`),
  });
  console.log(JSON.stringify({ sceneId: result.sceneId, complete: result.complete, files: result.totalFiles, decodedBytes: result.totalDecodedBytes, entrypoint: result.entrypoint }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
