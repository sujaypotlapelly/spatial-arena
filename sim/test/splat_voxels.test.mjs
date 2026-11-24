import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { SplatVoxels, SplatVoxelWorld, convertSplatToMap } from "../src/splat_voxels.js";
import { World } from "../src/world.js";

const SOLID = 0xff000000;
const fixture = ({ words = [], masks = [], interiors = 0, mixed = 0, bounds = { min: [0, 0, 0], max: [8, 8, 8] }, depth = 1, transform = {}, outsideSolid = true } = {}) => {
  const meta = { version: "1.1", gridBounds: bounds, sceneBounds: bounds, voxelResolution: 1, leafSize: 4, treeDepth: depth, nodeCount: words.length, leafDataCount: masks.length, numInteriorNodes: interiors, numMixedLeaves: mixed };
  const binary = Buffer.alloc((words.length + masks.length) * 4);
  [...words, ...masks].forEach((word, i) => binary.writeUInt32LE(word >>> 0, i * 4));
  return new SplatVoxels(meta, binary, { transform, outsideSolid });
};

test("empty scenes are free inside and conservatively solid outside", () => {
  const scene = fixture();
  assert.equal(scene.isOccupied([4, 4, 4]), false);
  assert.equal(scene.sphereHits([4, 4, 4], 1), false);
  assert.equal(scene.sphereHits([0.1, 4, 4], 0.2), true);
  assert.equal(scene.isOccupied([-0.01, 4, 4]), true);
  assert.equal(scene.isOccupied([8, 4, 4]), true);
  assert.equal(fixture({ outsideSolid: false }).isOccupied([100, 4, 4]), false);
});

test("solid nodes may collapse at root or at any shallower depth", () => {
  const full = fixture({ words: [SOLID] });
  assert.equal(full.isOccupied([7.5, 7.5, 7.5]), true);
  const octant = fixture({ words: [(1 << 24) | 1, SOLID], interiors: 1, outsideSolid: false });
  assert.equal(octant.isOccupied([1, 1, 1]), true);
  assert.equal(octant.isOccupied([5, 1, 1]), false);
  assert.equal(octant.sphereHits([4.2, 2, 2], 0.21), true);
  assert.equal(octant.sphereHits([4.2, 2, 2], 0.19), false);
});

test("sparse child order and all 64 mixed-leaf bits use x-fastest ordering", () => {
  // Child 0 is fully solid, child 7 is a mixed block with bits 0,31,32,63.
  const scene = fixture({ words: [(0x81 << 24) | 1, SOLID, 0], masks: [0x80000001, 0x80000001], interiors: 1, mixed: 1, outsideSolid: false });
  for (let z = 0; z < 8; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const bit = (x & 3) + ((y & 3) << 2) + ((z & 3) << 4);
    const expected = x < 4 && y < 4 && z < 4 || x >= 4 && y >= 4 && z >= 4 && [0, 31, 32, 63].includes(bit);
    assert.equal(scene.isOccupiedVoxel(x, y, z), expected, `${x},${y},${z}`);
    assert.equal(scene.sphereHits([x + 0.5, y + 0.5, z + 0.5], 0.1), expected);
  }
});

test("transforms preserve occupancy, sphere radius, and inverse coordinates", () => {
  const scene = fixture({ words: [(1 << 24) | 1, SOLID], interiors: 1, transform: { position: [10, -5, 3], rotation: [31, -20, 90], scale: 2 } });
  for (const point of [[1, 2, 3], [5, 1, 2], [4.1, 2, 2]]) {
    const world = scene.toWorld(point), restored = scene.toSource(world);
    restored.forEach((n, k) => assert.ok(Math.abs(n - point[k]) < 1e-12));
  }
  assert.equal(scene.isOccupied(scene.toWorld([1, 1, 1])), true);
  assert.equal(scene.isOccupied(scene.toWorld([5, 1, 1])), false);
  assert.equal(scene.sphereHits(scene.toWorld([4.1, 2, 2]), 0.21), true);
  assert.equal(scene.sphereHits(scene.toWorld([4.1, 2, 2]), 0.19), false);
  assert.equal(scene.voxelResolution, 2);
});

test("deeper octants and non-cubic grid bounds preserve the documented frame", () => {
  const scene = fixture({ words: [(1 << 24) | 1, (0x80 << 24) | 2, 0], masks: [1, 0], interiors: 2, mixed: 1, depth: 2, bounds: { min: [-2, -3, -4], max: [10, 5, 4] } });
  // The root's low child, then its high child, selects voxel (4,4,4).
  assert.equal(scene.isOccupiedVoxel(4, 4, 4), true);
  assert.equal(scene.isOccupied([2.5, 1.5, 0.5]), true);
  assert.equal(scene.isOccupiedVoxel(5, 4, 4), false);
  assert.equal(scene.isOccupiedVoxel(12, 4, 4), true); // outside real grid, inside root cube
  assert.equal(scene.sphereHits([2.5, 1.5, 0.5], 0.1), true);
  assert.equal(scene.sphereHits([3.5, 1.5, 0.5], 0.1), false);
});

test("rotated dense cells conservatively cover occupied source voxels", () => {
  const scene = fixture({ words: [(1 << 24) | 1, 0], masks: [1, 0], interiors: 1, mixed: 1, transform: { rotation: [0, 45, 0], scale: 1.5 } });
  const center = scene.toWorld([0.5, 0.5, 0.5]);
  assert.equal(scene.boxHits({ min: center.map((n) => n - 0.1), max: center.map((n) => n + 0.1) }), true);
  assert.equal(scene.boxHits({ min: [30, 30, 30], max: [31, 31, 31] }), true); // uncaptured space
});

test("bounded conservative conversion is compatible with World and limits allocations", () => {
  const scene = fixture({ words: [(1 << 24) | 1, 0], masks: [1, 0], interiors: 1, mixed: 1 });
  const bounds = { min: [0, 0, 0], max: [8, 8, 8] };
  const map = convertSplatToMap(scene, { bounds, cell: 0.5, maxCells: 5000 });
  assert.equal(map.splatCollision.cells, 4096);
  assert.equal(map.splatCollision.solidCells, 8);
  assert.equal(map.voxels.runs.reduce((a, b) => a + b), 4096);
  const world = new World(map);
  assert.ok(world.sphereHits([0.5, 0.5, 0.5], 0.1));
  assert.equal(world.sphereHits([2, 2, 2], 0.1), null);
  assert.throws(() => convertSplatToMap(scene, { bounds, cell: 0.01 }), /exceeds maxCells/);
  assert.throws(() => convertSplatToMap(scene, { cell: 1 }), /explicit finite crop/);
  // Small crops extending beyond capture space remain blocked there.
  const outside = convertSplatToMap(scene, { bounds: { min: [-1, 0, 0], max: [0, 1, 1] }, cell: 1 });
  assert.equal(outside.voxels.firstValue, 1);
});

test("direct World adapter blocks the scan, map boundaries, and sliding motion", () => {
  const voxels = fixture({ words: [(1 << 24) | 1, SOLID], interiors: 1 });
  const world = new SplatVoxelWorld({ waypoints: { a: [5, 2, 2], b: [7, 2, 2] }, edges: [["a", "b"]], physics: {} }, voxels);
  assert.ok(world.sphereHits([2, 2, 2], 0.25));
  assert.equal(world.sphereHits([5, 2, 2], 0.25), null);
  assert.equal(world.segmentClear([5, 2, 2], [2, 2, 2], 0.25), false);
  assert.deepEqual(world.path("a", "b"), ["a", "b"]);
  assert.deepEqual(world.moveSphere([5, 2, 2], [3, 2, 3], 0.25), [5, 2, 3]);
});

test("malformed versions, bytes, tree pointers, and masks fail closed", () => {
  const valid = fixture();
  assert.throws(() => new SplatVoxels({ ...valid.meta, version: "1.0" }, Buffer.alloc(0)), /only format 1.1/);
  assert.throws(() => new SplatVoxels(valid.meta, Buffer.alloc(4)), /byte length/);
  assert.throws(() => fixture({ words: [(1 << 24) | 2], interiors: 1 }), /child pointer/);
  assert.throws(() => fixture({ words: [0], masks: [1, 0], mixed: 1 }), /treeDepth/);
  assert.throws(() => fixture({ words: [(1 << 24) | 1, 0], masks: [0, 0], mixed: 1, interiors: 1 }), /empty or full/);
  assert.throws(() => fixture({ transform: { scale: 0 } }), /positive uniform/);
});

for (const id of ["church", "canyon"]) {
  const dir = new URL(`../../cache/splat-scenes/${id}/`, import.meta.url);
  test(`cached ${id} collision validates, checksums match, and real queries agree`, { skip: !existsSync(new URL("scene.voxel.bin", dir)) }, () => {
    const meta = JSON.parse(readFileSync(new URL("scene.voxel.json", dir))), bin = readFileSync(new URL("scene.voxel.bin", dir));
    const provenance = JSON.parse(readFileSync(new URL("provenance.json", dir)));
    assert.equal(createHash("sha256").update(bin).digest("hex"), provenance.files.find((f) => f.path === "scene.voxel.bin").sha256);
    const scene = new SplatVoxels(meta, bin);
    let solid = 0, free = 0;
    for (let i = 0; i < 300; i++) {
      const v = scene.dims.map((n, k) => (i * [197, 307, 401][k] + [13, 29, 43][k]) % n);
      const p = v.map((n, k) => scene.sourceBounds.min[k] + (n + 0.5) * scene.resolution);
      const occupied = scene.isOccupiedVoxel(...v);
      assert.equal(scene.isOccupied(p), occupied);
      assert.equal(scene.sphereHits(p, scene.resolution * 0.2), occupied);
      occupied ? solid++ : free++;
    }
    assert.ok(solid > 0 && free > 0, `${id}: ${solid} solid / ${free} free`);
  });
}
