import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { assetReferences, resolveReference, cacheStreamedScene } from "../tools/maps/cache_splat_scene.mjs";

const rootUrl = "https://example.test/approved/v1/lod-meta.json";
const scene = { id: "fixture", source: { license: "CC BY 4.0", creator: "Fixture author", attribution: "Fixture attribution" }, assets: { splatUrl: rootUrl }, transform: { splat: { rotation: [0, 0, 180] } } };
const setup = async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "splat-cache-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { outDirectory: path.join(dir, "assets"), indexPath: path.join(dir, "bundle.json"), retries: 0 };
};
const hash = (b) => createHash("sha256").update(b).digest("hex");

test("resolves nested assets but rejects traversal, external URLs, and ambiguous paths", () => {
  assert.deepEqual(resolveReference("means_l.webp", "https://example.test/approved/v1/0_0/meta.json", rootUrl), { path: "0_0/means_l.webp", url: "https://example.test/approved/v1/0_0/means_l.webp" });
  for (const ref of ["../outside.webp", "%2e%2e/outside.webp", "https://evil.test/a.webp", "//evil.test/a.webp", "/absolute.webp", "a\\b.webp", "a.webp?token=secret", "a.webp#frag", "a%252fb.webp", "./a.webp"]) {
    assert.throws(() => resolveReference(ref, rootUrl, rootUrl), undefined, ref);
  }
  assert.deepEqual(assetReferences({ filenames: ["0/meta.json"], tree: { lods: { file: 0 } }, environment: { files: ["env/sky.hdr"] }, means: { files: ["means_l.webp"] }, asset: { generator: "splat-transform v2.7.1" } }), ["0/meta.json", "env/sky.hdr", "means_l.webp"]);
});

test("mirrors the entire nested graph, including environment assets, with hashes", async (t) => {
  const options = await setup(t), documents = new Map([
    [rootUrl, JSON.stringify({ filenames: ["0/meta.json", "1/meta.json"], environment: { url: "env/sky.hdr" } })],
    [new URL("0/meta.json", rootUrl).href, JSON.stringify({ means: { files: ["means.webp"] } })],
    [new URL("1/meta.json", rootUrl).href, JSON.stringify({ means: { files: ["means.webp"] } })],
    [new URL("0/means.webp", rootUrl).href, Buffer.from([1, 2, 3])],
    [new URL("1/means.webp", rootUrl).href, Buffer.from([4, 5, 6])],
    [new URL("env/sky.hdr", rootUrl).href, Buffer.from([7, 8, 9])],
  ]);
  let active = 0, peak = 0;
  const fetchFn = async (url, request) => {
    assert.equal(request.redirect, "error");
    active++; peak = Math.max(active, peak);
    await new Promise((resolve) => setTimeout(resolve, 1)); active--;
    return new Response(documents.get(url), { headers: { "content-type": url.endsWith("json") ? "application/json" : "application/octet-stream" } });
  };
  const result = await cacheStreamedScene(scene, { ...options, fetchFn });
  assert.equal(result.complete, true);
  assert.equal(result.totalFiles, 6);
  assert.ok(peak <= 4);
  assert.equal(result.entrypoint, "assets/lod-meta.json");
  for (const file of result.files) {
    const bytes = await fs.readFile(path.join(options.outDirectory, file.path));
    assert.equal(hash(bytes), file.sha256);
    assert.equal(bytes.length, file.decodedBytes);
    assert.equal(file.license, "CC BY 4.0");
  }
  assert.equal(JSON.parse(await fs.readFile(options.indexPath)).complete, true);
});

test("failed public access and oversized files leave an explicitly incomplete index", async (t) => {
  const options = await setup(t);
  const fetchFn = async (url) => url === rootUrl ? new Response(JSON.stringify({ filenames: ["missing/meta.json"] })) : new Response("missing", { status: 404 });
  await assert.rejects(() => cacheStreamedScene(scene, { ...options, fetchFn }), /incomplete bundle/);
  let index = JSON.parse(await fs.readFile(options.indexPath));
  assert.equal(index.complete, false);
  assert.equal(index.state, "failed");
  assert.equal(index.totalFiles, 1);
  assert.match(index.failures[0].error, /HTTP 404/);
  await assert.rejects(() => cacheStreamedScene(scene, { ...options, maxFileBytes: 4, fetchFn: async () => new Response("12345") }), /incomplete bundle/);
  index = JSON.parse(await fs.readFile(options.indexPath));
  assert.equal(index.complete, false);
  assert.match(index.failures[0].error, /file limit/);
});

test("external metadata references fail before an external fetch; retries are bounded", async (t) => {
  const options = await setup(t), calls = [];
  await assert.rejects(() => cacheStreamedScene(scene, { ...options, fetchFn: async (url) => { calls.push(url); return new Response(JSON.stringify({ files: ["https://evil.test/secret.webp"] })); } }), /incomplete bundle/);
  assert.deepEqual(calls, [rootUrl]);
  let attempts = 0;
  await assert.rejects(() => cacheStreamedScene(scene, { ...options, retries: 1, fetchFn: async () => { attempts++; return new Response("down", { status: 503 }); } }), /incomplete bundle/);
  assert.equal(attempts, 2);
});
