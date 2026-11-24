import test from 'node:test';
import assert from 'node:assert/strict';
import { voxelSurface } from '../src/voxel_surface.js';
test('surface preserves world coordinates, removes hidden interior, and retains cavity faces', () => {
  const full = { origin: [-1, 2, 4], cell: .5, dims: [3, 3, 3], firstValue: 1, runs: [27] };
  const surface = voxelSurface(full);
  assert.equal(surface.surfaceCells, 26);
  assert.equal(surface.occupiedCells, 27);
  assert.deepEqual(surface.positions.slice(0, 3), [-.75, 2.25, 4.25]);
  assert.equal(surface.positions.length, 78);
  const cavity = voxelSurface({ ...full, dims: [5, 5, 5], runs: [62, 1, 62] });
  assert.equal(cavity.occupiedCells, 124);
  assert.equal(cavity.surfaceCells, 104); // 98 outer cells plus six bordering the cavity.
});
test('empty space stays empty and malformed or oversized data cannot allocate unbounded grids', () => {
  const empty = { origin: [0, 0, 0], cell: 1, dims: [2, 2, 2], firstValue: 0, runs: [8] };
  assert.equal(voxelSurface(empty).surfaceCells, 0);
  assert.throws(() => voxelSurface({ ...empty, runs: [7] }), /cover/);
  assert.throws(() => voxelSurface({ ...empty, runs: [9] }), /length/);
  assert.throws(() => voxelSurface({ ...empty, dims: [100000, 100000, 100000] }), /limit/);
  assert.throws(() => voxelSurface({ ...empty, firstValue: 1 }, { maxInstances: 2 }), /instance/);
});
