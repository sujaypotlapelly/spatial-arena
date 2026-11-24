// A simple, model-free check for a program that hard-codes its flight height
// (the transfer study found such programs score well on factory practice and
// fail outdoors). The probe puts the drone in open air, level with a goal
// 20 m east and in plain sight, at three heights, and steps the program for
// 5 s with simple kinematics (position += command). A program that steers by
// the goal's height stays level; one that pulls toward a fixed height drifts
// away. Height-locked = it ends more than 1 m above or below the goal's
// height in any probe. This is a behavioural check on the program alone; it
// is not the transfer study's definition (which flies the outdoor dev routes).
import { compilePolicy } from "../../src/gym/policy_sandbox.js";

export const PROBE_HEIGHTS = [1, 4, 8];
export function heightLock(code) {
  const drifts = [];
  for (const h of PROBE_HEIGHTS) {
    const p = compilePolicy(code);
    if (p.error) return { locked: null, error: p.error, drifts: [] };
    p.newMemory();
    let pos = [0, h, 0], vel = [0, 0, 0];
    for (let t = 0; t < 5; t++) {
      const dx = 20 - pos[0], dy = h - pos[1];
      const r = (x) => Math.round(x * 10) / 10;
      const obs = {
        time_s: t, time_left_s: 90 - t, wall_contacts_so_far: 0, position: pos.map(r), velocity: vel.map(r),
        goal: { position: [20, h, 0], distance_m: r(Math.hypot(dx, dy, pos[2])), in_line_of_sight: true },
        free_space_m: { east: 12, north_east: 12, north: 12, north_west: 12, west: 12, south_west: 12, south: 12, south_east: 12, up: 12, down: Math.min(12, Math.max(0, Math.floor(pos[1] * 4) / 4)) },
      };
      let cmd = [0, 0, 0];
      try { const out = p.call(obs); if (Array.isArray(out?.velocity) && out.velocity.every((x) => Number.isFinite(Number(x)))) cmd = out.velocity.map(Number); } catch {}
      const L = Math.hypot(...cmd);
      vel = L > 5.5 ? cmd.map((x) => (x * 5.5) / L) : cmd;
      pos = pos.map((x, i) => x + vel[i]);
    }
    drifts.push(Math.round((pos[1] - h) * 10) / 10);
  }
  return { locked: drifts.some((d) => Math.abs(d) > 1), drifts };
}
