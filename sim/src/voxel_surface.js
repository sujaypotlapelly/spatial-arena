// Rendering-only surface cells of an RLE occupancy grid. Physics continues to
// use the recorded authoritative collider, never this coarser display export.
export function voxelSurface(grid, { maxCells = 2_000_000, maxInstances = 500_000 } = {}) {
  const { origin, cell, dims, firstValue, runs } = grid || {};
  if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite)
    || !(Number.isFinite(cell) && cell > 0) || !Array.isArray(dims) || dims.length !== 3
    || !dims.every(n => Number.isSafeInteger(n) && n > 0)
    || ![0, 1].includes(firstValue) || !Array.isArray(runs)) throw new Error('Invalid voxel display grid');
  const count = dims.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(count) || count > maxCells) throw new Error('Voxel display exceeds cell limit');
  const occupancy = new Uint8Array(count);
  let offset = 0, value = firstValue, occupied = 0;
  for (const length of runs) {
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > count) throw new Error('Invalid voxel run length');
    if (value) { occupancy.fill(1, offset, offset + length); occupied += length; }
    offset += length; value = 1 - value;
  }
  if (offset !== count) throw new Error('Voxel runs do not cover the grid');
  const [nx, ny, nz] = dims, index = (x, y, z) => x + nx * (y + ny * z);
  const solid = (x, y, z) => x >= 0 && x < nx && y >= 0 && y < ny && z >= 0 && z < nz && occupancy[index(x, y, z)];
  const positions = [];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (!solid(x, y, z)) continue;
    if (solid(x - 1, y, z) && solid(x + 1, y, z) && solid(x, y - 1, z)
      && solid(x, y + 1, z) && solid(x, y, z - 1) && solid(x, y, z + 1)) continue;
    if (positions.length / 3 >= maxInstances) throw new Error('Voxel display exceeds instance limit');
    positions.push(...[x, y, z].map((n, k) => Math.round((origin[k] + (n + .5) * cell) * 1e6) / 1e6));
  }
  return { schemaVersion: 1, kind: 'render-only-voxel-surface', cell, origin: origin.slice(), dims: dims.slice(), occupiedCells: occupied, surfaceCells: positions.length / 3, positions };
}
