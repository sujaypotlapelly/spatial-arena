// Independent reader of PlayCanvas's documented voxel format 1.1:
// https://developer.playcanvas.com/user-manual/splat-transform/voxel-format/
// The SuperSplat viewer is MIT (PlayCanvas Ltd., 2011–2026); its implementation
// was not copied here. V1.1 bounds are ALREADY in the engine coordinate frame.
// A scene unit is not necessarily a metre: scale must be calibrated separately.
import { World } from "./world.js";

const SOLID = 0xff000000;
const finite3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const popcount = (x) => { x -= (x >>> 1) & 0x55; x = (x & 0x33) + ((x >>> 2) & 0x33); return (x + (x >>> 4)) & 0x0f; };
const assert = (ok, message) => { if (!ok) throw new Error(`Splat voxels: ${message}`); };
const aabb = (b) => b && finite3(b.min) && finite3(b.max) && b.min.every((n, k) => n < b.max[k]);
const corners = (b) => Array.from({ length: 8 }, (_, i) => [0, 1, 2].map((k) => (i & (1 << k)) ? b.max[k] : b.min[k]));
const enclosing = (points) => ({ min: [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k]))), max: [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k]))) });
const overlap = (a, b) => a.min.every((n, k) => n < b.max[k] && a.max[k] > b.min[k]);

export class SplatVoxels {
  constructor(meta, binary, { transform = {}, outsideSolid = true, validate = true } = {}) {
    assert(meta?.version === "1.1", "only format 1.1 is supported (1.0 uses a different coordinate frame)");
    assert(aabb(meta.gridBounds), "invalid gridBounds");
    assert(meta.leafSize === 4, "leafSize must be 4");
    assert(Number.isFinite(meta.voxelResolution) && meta.voxelResolution > 0, "invalid voxelResolution");
    assert(Number.isInteger(meta.treeDepth) && meta.treeDepth >= 1 && meta.treeDepth <= 28, "invalid treeDepth");
    for (const key of ["nodeCount", "leafDataCount", "numInteriorNodes", "numMixedLeaves"]) {
      assert(Number.isSafeInteger(meta[key]) && meta[key] >= 0, `invalid ${key}`);
    }
    assert(meta.nodeCount <= 0x1000000 && meta.numMixedLeaves <= 0x1000000, "24-bit index limit exceeded");
    assert(meta.leafDataCount === 2 * meta.numMixedLeaves, "leafDataCount must be twice numMixedLeaves");
    this.meta = structuredClone(meta);
    this.sourceBounds = structuredClone(meta.gridBounds);
    this.resolution = meta.voxelResolution;
    this.dims = meta.gridBounds.min.map((n, k) => {
      const count = (meta.gridBounds.max[k] - n) / this.resolution;
      assert(Math.abs(count / 4 - Math.round(count / 4)) < 1e-5, "grid is not aligned to four-voxel blocks");
      const dim = Math.round(count);
      assert(dim > 0 && dim <= 4 * 2 ** meta.treeDepth, "grid exceeds root cube");
      return dim;
    });
    assert(binary instanceof ArrayBuffer || ArrayBuffer.isView(binary), "binary must be an ArrayBuffer or typed array");
    const bytes = binary instanceof ArrayBuffer ? new Uint8Array(binary) : new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
    assert(bytes.byteLength === (meta.nodeCount + meta.leafDataCount) * 4, "binary byte length does not match metadata (decode gzip first)");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const words = new Uint32Array(meta.nodeCount + meta.leafDataCount);
    for (let i = 0; i < words.length; i++) words[i] = view.getUint32(i * 4, true);
    this.nodes = words.subarray(0, meta.nodeCount);
    this.leafData = words.subarray(meta.nodeCount);
    this.outsideSolid = Boolean(outsideSolid);
    const { position = [0, 0, 0], rotation = [0, 0, 0], scale = 1 } = transform;
    assert(finite3(position) && finite3(rotation), "position and rotation must be finite triples");
    assert(Number.isFinite(scale) && scale > 0, "scale must be a positive uniform scalar");
    this.transform = { position: position.slice(), rotation: rotation.slice(), scale };
    // Right-handed rotations in degrees, applied X, then Y, then Z.
    const [x, y, z] = rotation.map((n) => n * Math.PI / 180);
    const [cx, cy, cz, sx, sy, sz] = [Math.cos(x), Math.cos(y), Math.cos(z), Math.sin(x), Math.sin(y), Math.sin(z)];
    this.rotation = [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz,
      cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz,
      -sy, sx * cy, cx * cy];
    this.bounds = enclosing(corners(this.sourceBounds).map((p) => this.toWorld(p)));
    this.voxelResolution = this.resolution * scale;
    if (validate) this.validateTree();
  }

  validateTree() {
    const { treeDepth, numInteriorNodes, numMixedLeaves } = this.meta;
    const depths = new Int8Array(this.nodes.length).fill(-1);
    if (depths.length) depths[0] = 0;
    let interiors = 0, mixed = 0;
    const masks = new Uint8Array(numMixedLeaves);
    for (let i = 0; i < this.nodes.length; i++) {
      const word = this.nodes[i], depth = depths[i];
      assert(depth >= 0, `unreachable node ${i}`);
      if (word === SOLID) continue;
      const mask = word >>> 24;
      if (!mask) {
        assert(depth === treeDepth, `mixed leaf ${i} is not at treeDepth`);
        assert(word < numMixedLeaves && !masks[word], `invalid or repeated leaf data index at node ${i}`);
        masks[word] = 1;
        const lo = this.leafData[word * 2], hi = this.leafData[word * 2 + 1];
        assert((lo !== 0 || hi !== 0) && (lo !== 0xffffffff || hi !== 0xffffffff), `mixed leaf ${i} is empty or full`);
        mixed++;
      } else {
        assert(depth < treeDepth, `interior node ${i} is below treeDepth`);
        const first = word & 0xffffff, count = popcount(mask);
        assert(first > i && first + count <= this.nodes.length, `invalid child pointer at node ${i}`);
        for (let j = first; j < first + count; j++) {
          assert(depths[j] === -1, `node ${j} has multiple parents`);
          depths[j] = depth + 1;
        }
        interiors++;
      }
    }
    assert(interiors === numInteriorNodes && mixed === numMixedLeaves, "tree statistics do not match binary");
    return true;
  }

  toWorld(p) {
    const R = this.rotation, { position: t, scale: s } = this.transform;
    return [0, 1, 2].map((k) => t[k] + s * (R[k * 3] * p[0] + R[k * 3 + 1] * p[1] + R[k * 3 + 2] * p[2]));
  }

  toSource(p) {
    const R = this.rotation, { position: t, scale: s } = this.transform;
    const q = p.map((n, k) => (n - t[k]) / s);
    return [0, 1, 2].map((k) => R[k] * q[0] + R[k + 3] * q[1] + R[k + 6] * q[2]);
  }

  isOccupied(p) {
    assert(finite3(p), "point must be a finite triple");
    const q = this.toSource(p);
    return this.isOccupiedVoxel(...q.map((n, k) => Math.floor((n - this.sourceBounds.min[k]) / this.resolution)));
  }

  isOccupiedVoxel(x, y, z) {
    const v = [x, y, z];
    assert(v.every(Number.isInteger), "voxel coordinates must be integers");
    if (v.some((n, k) => n < 0 || n >= this.dims[k])) return this.outsideSolid;
    if (!this.nodes.length) return false;
    let i = 0;
    for (let d = 0; d <= this.meta.treeDepth; d++) {
      const word = this.nodes[i];
      if (word === SOLID) return true;
      const mask = word >>> 24;
      if (!mask) {
        const bit = (x & 3) + ((y & 3) << 2) + ((z & 3) << 4);
        return Boolean((this.leafData[2 * word + (bit >>> 5)] >>> (bit & 31)) & 1);
      }
      const shift = this.meta.treeDepth + 1 - d;
      const oct = ((x >>> shift) & 1) | (((y >>> shift) & 1) << 1) | (((z >>> shift) & 1) << 2);
      if (!(mask & (1 << oct))) return false;
      i = (word & 0xffffff) + popcount(mask & ((1 << oct) - 1));
    }
    throw new Error("Splat voxels: invalid traversal");
  }

  // Visit only tree volumes overlapping the query, rather than iterating all
  // 5 cm voxels inside a drone-sized sphere. touching counts as collision.
  _intersects(testBox) {
    if (!this.nodes.length) return false;
    const rootSize = this.resolution * 4 * 2 ** this.meta.treeDepth;
    const visit = (index, min, size) => {
      const box = { min, max: min.map((n) => n + size) };
      if (!testBox(box)) return false;
      const word = this.nodes[index];
      if (word === SOLID) return true;
      const mask = word >>> 24;
      if (!mask) {
        const lo = this.leafData[word * 2], hi = this.leafData[word * 2 + 1];
        for (let bit = 0; bit < 64; bit++) {
          if (!(((bit < 32 ? lo : hi) >>> (bit & 31)) & 1)) continue;
          const p = [bit & 3, (bit >>> 2) & 3, bit >>> 4].map((n, k) => min[k] + n * this.resolution);
          if (testBox({ min: p, max: p.map((n) => n + this.resolution) })) return true;
        }
        return false;
      }
      const half = size / 2;
      let child = word & 0xffffff;
      for (let oct = 0; oct < 8; oct++) if (mask & (1 << oct)) {
        const childMin = min.map((n, k) => n + ((oct & (1 << k)) ? half : 0));
        if (visit(child++, childMin, half)) return true;
      }
      return false;
    };
    return visit(0, this.sourceBounds.min, rootSize);
  }

  sphereHits(p, radius) {
    assert(finite3(p) && Number.isFinite(radius) && radius >= 0, "invalid sphere");
    const q = this.toSource(p), r = radius / this.transform.scale;
    if (this.outsideSolid && q.some((n, k) => n - r < this.sourceBounds.min[k] || n + r >= this.sourceBounds.max[k])) return true;
    if (r === 0) return this.isOccupied(p);
    return this._intersects((box) => World.boxDist2(q, box) <= r * r);
  }

  boxHits(bounds) {
    assert(aabb(bounds), "invalid query bounds");
    // A rotated world cell becomes an OBB; enclosing it in source space is
    // deliberately conservative. Direct sphere queries remain exact.
    const box = enclosing(corners(bounds).map((p) => this.toSource(p)));
    if (this.outsideSolid && box.min.some((n, k) => n < this.sourceBounds.min[k] || box.max[k] > this.sourceBounds.max[k])) return true;
    return this._intersects((node) => overlap(node, box));
  }
}

// Direct collision adapter for Reach/FreeDrone; no dense grid allocation.
// Fog Search and grid planners need convertSplatToMap instead.
export class SplatVoxelWorld extends World {
  constructor(map, voxels) {
    assert(voxels instanceof SplatVoxels, "SplatVoxelWorld requires SplatVoxels");
    assert(!map.voxels, "do not combine octree and dense-grid collision maps");
    super({ boxes: [], waypoints: {}, edges: [], bounds: voxels.bounds, ...map });
    this.splatVoxels = voxels;
  }

  sphereHits(p, r) {
    const base = super.sphereHits(p, r);
    return base || (this.splatVoxels.sphereHits(p, r) ? { id: "scan", kind: "scan" } : null);
  }

  moveSphere(from, to, r) {
    if (!this.sphereHits(to, r)) return to.slice();
    for (const mask of [[1, 0, 1], [1, 1, 0], [0, 1, 1], [1, 0, 0], [0, 0, 1], [0, 1, 0]]) {
      const p = from.map((n, k) => mask[k] ? to[k] : n);
      if (!this.sphereHits(p, r)) return p;
    }
    return from.slice();
  }

  resolve(p) { return p.slice(); }
}

export function convertSplatToMap(voxels, { bounds, cell, maxCells = 2_000_000, ...map } = {}) {
  assert(voxels instanceof SplatVoxels && aabb(bounds), "conversion requires explicit finite crop bounds");
  assert(Number.isFinite(cell) && cell > 0, "conversion requires a positive cell size");
  assert(Number.isSafeInteger(maxCells) && maxCells > 0, "invalid maxCells");
  const dims = bounds.min.map((n, k) => Math.ceil((bounds.max[k] - n) / cell));
  const count = dims.reduce((n, d) => n * d, 1);
  assert(Number.isSafeInteger(count) && count <= maxCells, `crop needs ${count} cells, exceeds maxCells=${maxCells}`);
  const runs = [];
  let previous, run = 0, firstValue, solidCells = 0;
  for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
    const min = [x, y, z].map((n, k) => bounds.min[k] + n * cell);
    const value = Number(voxels.boxHits({ min, max: min.map((n) => n + cell) }));
    if (firstValue === undefined) firstValue = value;
    if (previous !== undefined && previous !== value) { runs.push(run); run = 0; }
    previous = value; run++; solidCells += value;
  }
  if (run) runs.push(run);
  return {
    name: "Imported SuperSplat voxel crop", notes: "Conservative occupancy of a bounded crop. Coordinates are scene units unless separately calibrated to metres.",
    boxes: [], waypoints: {}, edges: [], ...map, bounds: structuredClone(bounds),
    voxels: { origin: bounds.min.slice(), cell, dims, firstValue, runs },
    splatCollision: { format: "1.1", transform: voxels.transform, sourceBounds: voxels.sourceBounds, calibration: "unverified", conversion: "conservative-cell-overlap", solidCells, cells: count },
  };
}
