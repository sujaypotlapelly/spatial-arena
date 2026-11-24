// How the mission coding loop (sim/tools/mission_cap.mjs) picks which version
// a run revises from and which version it freezes.
//
//  legacy (the v4 and v5 pilot runs): success count, then "progress", then the
//    earliest version. For search, progress was the closest approach to the
//    hidden hiker, so the tie-break used information the program never had.
//    Kept only so those runs can be re-derived exactly.
//  earned (default for new runs): success count, then a measure the program
//    could have earned with its own sensors, then the earliest version. For
//    search that measure is `coverage`: the ground the drone's own detector
//    looked at (sensedCoverage below). For delivery the pad position is given
//    to the program, so closing in on it is earned information and progress
//    stays the tie-break.
import { v } from "../world.js";

export const SELECT_MODES = ["earned", "legacy"];

export function checkSelectMode(mode) {
  if (!SELECT_MODES.includes(mode)) throw new Error(`--select must be ${SELECT_MODES.join(" or ")}, not ${mode}`);
  return mode;
}

// The secondary key for a task under a selection mode.
export const tieKey = (mode, task) => (checkSelectMode(mode) === "earned" && task === "search" ? "coverage" : "progress");

// Is result `a` strictly better than `b`? (b may be null.) Rows carry
// { success, progress, coverage }. Ties keep b, so the earliest version wins.
export function better(a, b, mode, task) {
  if (!b) return true;
  const k = tieKey(mode, task);
  return a.success > b.success || (a.success === b.success && (a[k] ?? 0) > (b[k] ?? 0));
}

// The version a run freezes, from its curve rows (each with version, success,
// progress, coverage, compileError, finish).
export function pickFrozen(curve, mode, task) {
  const k = tieKey(mode, task);
  const usable = curve.filter((c) => !c.compileError && c.finish !== "length");
  return [...(usable.length ? usable : curve)].sort((a, b) => b.success - a.success || (b[k] ?? 0) - (a[k] ?? 0) || a.version - b.version)[0];
}

// Ground the drone's own detector looked at during a flight, in 1 x 1 unit
// top-down cells. Once per second of recorded flight, 25 rays (straight down,
// and 8 bearings at 15, 40 and 70 degrees below horizontal) go out to the
// detection range; the cell where a ray meets a surface counts as looked at.
// This uses only where the drone was and what its sensor could see from
// there, never the hiker. A beacon on the ground inside a looked-at cell is
// very likely, but not certain, to have been detected.
// With `area` ({ min: [x, z], max: [x, z] }, the assigned search sector the
// program is told about), only cells inside it count.
export function sensedCoverage(world, frames, range, { every = 1, step = 0.25, area = null } = {}) {
  const dirs = [[0, -1, 0]];
  for (const e of [15, 40, 70]) for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4, el = (-e * Math.PI) / 180;
    dirs.push([Math.cos(el) * Math.cos(a), Math.sin(el), Math.cos(el) * Math.sin(a)]);
  }
  const cells = new Set();
  let lastT = -Infinity;
  for (const f of frames) {
    if (f[0] - lastT < every - 1e-9) continue;
    lastT = f[0];
    const p = [f[1], f[2], f[3]];
    for (const d of dirs) {
      for (let s = step; s <= range; s += step) {
        const q = v.add(p, v.scale(d, s));
        if (world.sphereHits(q, 0.05)) {
          if (!area || (q[0] >= area.min[0] && q[0] <= area.max[0] && q[2] >= area.min[1] && q[2] <= area.max[1])) cells.add(`${Math.floor(q[0])},${Math.floor(q[2])}`);
          break;
        }
      }
    }
  }
  return cells.size;
}
