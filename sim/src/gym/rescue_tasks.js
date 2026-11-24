// Small mission-specific C3 environments over the existing FreeDrone physics.
// Unlike Reach, find-beacon never tells the controller the hidden target's
// position, distance, or bearing. A beacon is a simulated hiker proxy, not a
// claim of visual person recognition. Works with SplatVoxelWorld; no dense
// floor grid, waypoint planner, or privileged diagnostic route is required.
import { v } from '../world.js';
import { FreeDrone, clearance, lineOfSight, r1, r2 } from './core.js';
import { Control } from './control.js';

const finite3 = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const positive = (value, name) => {
  if (!(Number.isFinite(value) && value > 0)) throw new Error(`${name} must be positive`);
  return value;
};
const round = value => Math.round(value * 1e6) / 1e6;

export function normalizeMission(input) {
  if (!['find-beacon', 'delivery-checkpoint', 'package-delivery', 'package-drop'].includes(input?.kind)) throw new Error('Unknown rescue mission kind');
  if (!finite3(input.start) || !finite3(input.targetPosition)) throw new Error('Mission start and targetPosition must be finite triples');
  const spec = {
    id: input.id || input.kind,
    kind: input.kind,
    start: input.start.slice(),
    targetPosition: input.targetPosition.slice(),
    timeLimitSeconds: positive(input.timeLimitSeconds ?? 90, 'timeLimitSeconds'),
  };
  if (input.kind === 'find-beacon') {
    spec.detectionRange = positive(input.detectionRange ?? 6, 'detectionRange');
    // Optional search sector (missions v2): the area the hiker is known to be
    // in, as a rescue team would assign it. { min: [x, z], max: [x, z] }.
    if (input.searchArea) {
      const a = input.searchArea;
      if (!(Array.isArray(a.min) && Array.isArray(a.max) && a.min.length === 2 && a.max.length === 2 && [...a.min, ...a.max].every(Number.isFinite) && a.max[0] > a.min[0] && a.max[1] > a.min[1])) throw new Error('searchArea must be { min: [x, z], max: [x, z] }');
      spec.searchArea = { min: a.min.slice(), max: a.max.slice() };
    }
  } else if (input.kind === 'package-drop') Object.assign(spec, {
    // Missions v2 delivery: carry the parcel to the pad, descend, and release
    // it with an explicit { release: true } command. Delivered when the parcel
    // lands on the pad surface within padRadius of its centre, released from
    // no higher than maxReleaseHeight above the pad.
    padRadius: positive(input.padRadius ?? .5, 'padRadius'),
    maxReleaseHeight: positive(input.maxReleaseHeight ?? 2, 'maxReleaseHeight'),
    parcelRadius: positive(input.parcelRadius ?? .1, 'parcelRadius'),
    gravity: positive(input.gravity ?? 9.81, 'gravity'),
    landingHeightTolerance: positive(input.landingHeightTolerance ?? .2, 'landingHeightTolerance'),
  });
  else Object.assign(spec, {
    padRadius: positive(input.padRadius ?? .6, 'padRadius'),
    maxHoldSpeed: positive(input.maxHoldSpeed ?? .35, 'maxHoldSpeed'),
    requiredHoldSeconds: positive(input.requiredHoldSeconds ?? 2, 'requiredHoldSeconds'),
    requireNoContactDuringHold: input.requireNoContactDuringHold !== false,
  });
  if (input.kind === 'package-delivery') Object.assign(spec, {
    releaseHeight: positive(input.releaseHeight ?? 1, 'releaseHeight'),
    parcelRadius: positive(input.parcelRadius ?? .08, 'parcelRadius'),
    gravity: positive(input.gravity ?? 9.81, 'gravity'),
    landingHeightTolerance: positive(input.landingHeightTolerance ?? .4, 'landingHeightTolerance'),
  });
  return spec;
}

// Range to the first surface along each ray (thin rays, 0.25-unit steps, 20 max).
// Bearings are degrees counter-clockwise from east (+x) toward north (+z).
export function lidarScan(world, p, maxRange = 20, step = 0.25) {
  const ray = (d) => { let s = 0; while (s < maxRange && !world.sphereHits(v.add(p, v.scale(d, s + step)), 0.05)) s += step; return Math.round(s * 10) / 10; };
  const ring = (elev, n) => Array.from({ length: n }, (_, i) => {
    const a = (i * 2 * Math.PI) / n, e = (elev * Math.PI) / 180;
    return ray([Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)]);
  });
  return { bearings_deg: Array.from({ length: 16 }, (_, i) => i * 22.5), horizontal_m: ring(0, 16), up30_m: ring(30, 8), down30_m: ring(-30, 8), max_range: maxRange,
    note: 'horizontal_m[i] is the distance at bearings_deg[i]; up30_m/down30_m are every 45 deg starting east, tilted 30 deg up/down' };
}

export class RescueMission {
  #spec;
  #target;

  // opts.sensors: "basic" (default; free_space_m only) or "lidar" (adds a
  // 32-ray scan to 20 units: 16 horizontal bearings, 8 tilted 30 deg up and 8
  // tilted 30 deg down). The lidar is a v5 harness option; the default keeps
  // every earlier recording identical.
  // opts.sensors also takes "map" (lidar plus an onboard map built only from
  // the drone's own scans, missions v2) and "map-v5pilot" (the v5 pilot's map,
  // kept unchanged so its recordings re-fly; it read the true geometry for
  // straight_line_clear and chose frontiers for the program).
  constructor(world, input, seed, opts = {}) {
    this.sensors = opts.sensors ?? 'basic';
    if (!['basic', 'lidar', 'map', 'map-v5pilot'].includes(this.sensors)) throw new Error(`unknown sensors ${this.sensors}`);
    this.#spec = normalizeMission(input);
    this.#target = this.#spec.targetPosition;
    const spec = this.#spec;
    if (world.sphereHits(spec.start, world.physics.droneRadius)) throw new Error('Mission start collides');
    if (spec.kind !== 'package-delivery' && spec.kind !== 'package-drop' && world.sphereHits(this.#target, .1)) throw new Error('Mission target proxy collides');
    if (spec.kind === 'package-drop' && world.sphereHits(v.add(this.#target, [0, 1, 0]), world.physics.droneRadius)) throw new Error('No room to hover above the pad');
    if (spec.kind === 'find-beacon' && lineOfSight(world, spec.start, this.#target, spec.detectionRange)) throw new Error('Search target must be hidden at launch');
    if (spec.kind === 'package-drop') {
      if (Math.hypot(spec.start[0] - this.#target[0], spec.start[2] - this.#target[2]) <= spec.padRadius) throw new Error('Delivery must start outside the pad');
    } else if (spec.kind !== 'find-beacon' && v.dist(spec.start, this.#navigationTarget()) <= spec.padRadius) throw new Error('Delivery must start outside the pad');
    if (spec.kind === 'package-delivery') {
      if (spec.releaseHeight <= world.physics.droneRadius + 2 * spec.parcelRadius + .05) throw new Error('Release height leaves no space for the parcel');
      if (world.sphereHits(this.#navigationTarget(), world.physics.droneRadius)) throw new Error('Delivery hover target collides');
    }
    this.world = world;
    this.P = world.physics;
    this.drone = new FreeDrone(world, spec.start, seed);
    // A target-facing initial heading would leak an unknown hiker direction.
    this.ctl = new Control(world, this.drone, 'C3', { heading: 0 });
    this.t = 0;
    this.step = 0;
    this.done = false;
    this.outcome = null;
    this.foundAt = null;
    this.holdSeconds = 0;
    this.touchSeconds = 0;
    this.frames = [];
    this.events = [];
    this.payload = spec.kind === 'package-delivery' || spec.kind === 'package-drop' ? { status: 'carried', position: null, velocity: null, releasedAt: null, landedAt: null } : null;
    this.payloadFrames = [];
    this.record();
  }

  get heading() { return this.ctl.heading; }

  // v5 pilot onboard mapping (sensors "map-v5pilot"; it was "map" in the v5
  // pilot, see docs/HARNESS_CHANGELOG.md). Kept byte-for-byte so those
  // recordings re-fly. Two faults, fixed in #updateMap below: straight_line_clear
  // read the true collision geometry, and nearest_unsearched was frontier
  // selection done by the harness, a plan. Original note: a 2.5-unit top-down
  // grid built ONLY from the drone's own lidar rays. A cell is "seen" when a
  // ray passed through its free space, and "searched" when that happened
  // within detection range. Frontiers are seen-but-unsearched cells: places
  // the drone knows are open but has not yet looked at closely. Nothing here
  // reads the hidden target.
  #map = null;
  #updateMapV5Pilot(p, scan) {
    const C = 2.5, range = this.#spec.detectionRange ?? 5;
    if (!this.#map) this.#map = { seen: new Map(), searched: new Set() };
    const key = (x, z) => `${Math.floor(x / C)},${Math.floor(z / C)}`;
    const rays = [];
    scan.horizontal_m.forEach((dist, i) => rays.push([0, (i * 2 * Math.PI) / 16, dist]));
    scan.up30_m.forEach((dist, i) => rays.push([Math.PI / 6, (i * 2 * Math.PI) / 8, dist]));
    scan.down30_m.forEach((dist, i) => rays.push([-Math.PI / 6, (i * 2 * Math.PI) / 8, dist]));
    for (const [e, a, dist] of rays) {
      const d = [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
      for (let s = 0; s <= dist; s += 1) {
        const q = v.add(p, v.scale(d, s)), k = key(q[0], q[2]);
        if (!this.#map.seen.has(k)) this.#map.seen.set(k, r1(q));
        if (s <= range) this.#map.searched.add(k);
      }
    }
    const frontiers = [];
    for (const [k, q] of this.#map.seen) if (!this.#map.searched.has(k)) frontiers.push(q);
    frontiers.sort((a, b) => v.dist(a, p) - v.dist(b, p));
    const COMPASS = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
    return {
      cell_m: C, seen_cells: this.#map.seen.size, searched_cells: this.#map.searched.size,
      nearest_unsearched: frontiers.slice(0, 6).map((q) => ({ position: q, distance_m: Math.round(v.dist(q, p) * 10) / 10,
        direction: COMPASS[((Math.round(Math.atan2(q[2] - p[2], q[0] - p[0]) / (Math.PI / 4)) % 8) + 8) % 8],
        straight_line_clear: this.world.segmentClear(p, q, this.P.droneRadius) })),
      note: 'Built only from your own range scans this flight. "Searched" = seen within detection range. nearest_unsearched lists open places you have seen but not yet searched, nearest first.',
    };
  }

  // Onboard map (sensors "map", missions v2). A top-down grid of 1-unit cells
  // built ONLY from the drone's own lidar rays this flight; nothing reads the
  // collision geometry or the hidden target. Per cell: unknown until a ray
  // crosses it; free once a horizontal ray passed through it; obstacle where a
  // horizontal ray stopped short of its maximum range (the obstacle mark wins,
  // since it was seen at some flying height); searched once any ray passed
  // within detection range. known_clear_m walks the grid only, so unknown
  // stays unknown. The program gets raw coverage and does its own planning.
  #grid = null;
  #updateMap(p, scan) {
    const C = 1, range = this.#spec.detectionRange ?? 5;
    if (!this.#grid) this.#grid = new Map(); // "i,j" -> { free, obstacle, searched }
    const G = this.#grid;
    const cellAt = (x, z) => { const k = `${Math.floor(x / C)},${Math.floor(z / C)}`; let c = G.get(k); if (!c) { c = { free: false, obstacle: false, searched: false }; G.set(k, c); } return c; };
    const rays = [];
    scan.horizontal_m.forEach((dist, i) => rays.push([0, (i * 2 * Math.PI) / 16, dist, true]));
    scan.up30_m.forEach((dist, i) => rays.push([Math.PI / 6, (i * 2 * Math.PI) / 8, dist, false]));
    scan.down30_m.forEach((dist, i) => rays.push([-Math.PI / 6, (i * 2 * Math.PI) / 8, dist, false]));
    for (const [e, a, dist, horizontal] of rays) {
      const d = [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
      for (let s = 0; s <= dist; s += 0.5) {
        const q = v.add(p, v.scale(d, s)), c = cellAt(q[0], q[2]);
        if (horizontal) c.free = true;
        if (s <= range) c.searched = true;
      }
      if (horizontal && dist < scan.max_range) { const q = v.add(p, v.scale(d, dist + 0.3)); cellAt(q[0], q[2]).obstacle = true; }
    }
    const charOf = (i, j) => { const c = G.get(`${i},${j}`); return !c ? '?' : c.obstacle ? '#' : c.free ? (c.searched ? 's' : '.') : (c.searched ? 's' : '?'); };
    const area = this.#spec.searchArea;
    const x0 = area ? Math.floor(area.min[0] / C) - 2 : Math.floor(p[0] / C) - 20, x1 = area ? Math.ceil(area.max[0] / C) + 2 : Math.floor(p[0] / C) + 20;
    const z0 = area ? Math.floor(area.min[1] / C) - 2 : Math.floor(p[2] / C) - 20, z1 = area ? Math.ceil(area.max[1] / C) + 2 : Math.floor(p[2] / C) + 20;
    const rows = [];
    for (let j = z0; j < z1; j++) { let r = ''; for (let i = x0; i < x1; i++) r += charOf(i, j); rows.push(r); }
    const known_clear_m = {};
    for (const [name, dx, dz] of [['east', 1, 0], ['north_east', Math.SQRT1_2, Math.SQRT1_2], ['north', 0, 1], ['north_west', -Math.SQRT1_2, Math.SQRT1_2], ['west', -1, 0], ['south_west', -Math.SQRT1_2, -Math.SQRT1_2], ['south', 0, -1], ['south_east', Math.SQRT1_2, -Math.SQRT1_2]]) {
      let s = 0, stop = 'range';
      while (s < 20) {
        const ch = charOf(Math.floor((p[0] + dx * (s + 0.5)) / C), Math.floor((p[2] + dz * (s + 0.5)) / C));
        if (ch === '?') { stop = 'unknown'; break; }
        if (ch === '#') { stop = 'obstacle'; break; }
        s += 0.5;
      }
      known_clear_m[name] = { m: s, stops_at: stop };
    }
    let seen = 0, searched = 0;
    for (const c of G.values()) { if (c.free || c.obstacle) seen++; if (c.searched) searched++; }
    return {
      cell_m: C, x0: x0 * C, z0: z0 * C, rows, seen_cells: seen, searched_cells: searched, known_clear_m,
      note: 'Built only from your own range scans this flight. rows[k] covers z from z0+k to z0+k+1 (south to north); character i covers x from x0+i to x0+i+1 (west to east). ? unknown, . seen open but not yet searched, s searched (a ray passed within detection range), # obstacle seen at some flying height. known_clear_m walks these cells only: it stops at the first unknown or obstacle cell.',
    };
  }

  #navigationTarget() {
    return this.#spec.kind === 'package-delivery'
      ? v.add(this.#target, [0, this.#spec.releaseHeight, 0])
      : this.#target;
  }

  record() {
    this.frames.push([Math.round(this.t * 100) / 100, ...r2(this.drone.pos), Math.round(this.heading * 1000) / 1000]);
    if (this.payload) this.payloadFrames.push({ t: Math.round(this.t * 100) / 100, status: this.payload.status,
      position: r2(this.payload.position || v.add(this.drone.pos, [0, -this.P.droneRadius - this.#spec.parcelRadius - .02, 0])),
      velocity: r2(this.payload.velocity || this.drone.vel) });
  }

  observe() {
    const spec = this.#spec, d = this.drone;
    const observation = {
      task: spec.kind,
      units: 'scene units; physical scale requires separate calibration',
      time_s: Math.round(this.t * 10) / 10,
      time_left_s: Math.max(0, Math.round((spec.timeLimitSeconds - this.t) * 10) / 10),
      position: r1(d.pos), velocity: r1(d.vel), wall_contacts_so_far: d.contacts.length,
      free_space_m: clearance(this.world, d.pos, this.P.droneRadius),
    };
    if (this.sensors !== 'basic') observation.scan = lidarScan(this.world, d.pos);
    if (this.sensors === 'map-v5pilot') observation.map = this.#updateMapV5Pilot(d.pos, observation.scan);
    if (this.sensors === 'map') observation.map = this.#updateMap(d.pos, observation.scan);
    if (spec.kind === 'find-beacon') {
      observation.search = {
        objective: 'Locate one hidden beacon representing a lost hiker. Its position is unknown until detected.',
        target_location_known: this.foundAt !== null,
        detection_range: spec.detectionRange,
        detection_rule: 'Within range and unobstructed line of sight; no image-based person recognition.',
        target: this.foundAt === null ? null : { position: r1(this.#target), found_at_s: this.foundAt },
      };
      if (spec.searchArea) observation.search.area = { min: spec.searchArea.min.slice(), max: spec.searchArea.max.slice(), note: 'The hiker is on open floor somewhere inside this rectangle, [x, z] corners.' };
    } else if (spec.kind === 'package-drop') {
      const pad = this.#target;
      // Line of sight to a point 0.3 above the pad centre (the surface point itself touches the floor).
      observation.goal = { position: r1(pad), distance_m: Math.round(v.dist(d.pos, pad) * 10) / 10, in_line_of_sight: lineOfSight(this.world, d.pos, v.add(pad, [0, 0.3, 0]), 40) };
      observation.delivery = {
        objective: 'Carry the parcel to the marked pad, descend over it, and release it with { release: true }. It falls under gravity and keeps the drone\'s velocity at release.',
        pad_position: r1(pad), pad_radius: spec.padRadius, max_release_height: spec.maxReleaseHeight,
        height_above_pad: Math.round((d.pos[1] - pad[1]) * 100) / 100,
        horizontal_offset: [Math.round((d.pos[0] - pad[0]) * 100) / 100, Math.round((d.pos[2] - pad[2]) * 100) / 100],
        parcel_status: this.payload.status,
      };
    } else {
      const navigationTarget = this.#navigationTarget();
      observation.goal = { position: r1(navigationTarget), distance_m: Math.round(v.dist(d.pos, navigationTarget) * 10) / 10,
        in_line_of_sight: lineOfSight(this.world, d.pos, navigationTarget, 40) };
      observation.delivery = {
        objective: 'Reach the marked delivery checkpoint and hold position. Parcel release is not simulated.',
        pad_radius: spec.padRadius, maximum_hold_speed: spec.maxHoldSpeed,
        required_hold_s: spec.requiredHoldSeconds, continuous_hold_s: round(this.holdSeconds),
        contact_free_hold_required: spec.requireNoContactDuringHold,
      };
      if (spec.kind === 'package-delivery') Object.assign(observation.delivery, {
        objective: 'Hover above the marked pad. A parcel automatically releases after the stable hold and falls under simplified gravity. Success requires landing inside the pad.',
        pad_position: r1(this.#target), release_height: spec.releaseHeight,
        automatic_release: true, parcel_status: this.payload.status,
      });
    }
    return observation;
  }

  apply(command = {}) {
    const applied = this.ctl.apply(command);
    // package-drop only: an explicit release, recorded in the applied command
    // so replay re-applies it.
    if (this.#spec.kind === 'package-drop' && command?.release === true && this.payload.status === 'carried' && !this.done) {
      this.#releaseParcel();
      return { ...applied, release: true };
    }
    return applied;
  }

  tick(dt) {
    if (this.done) return;
    const spec = this.#spec, d = this.drone;
    this.ctl.tick();
    d.step(dt, this.t);
    this.t += dt; this.step++;
    if (d.touching) this.touchSeconds += dt;
    if (Math.hypot(d.vel[0], d.vel[2]) > .1) this.ctl.heading = Math.atan2(d.vel[2], d.vel[0]);
    if (spec.kind === 'find-beacon') {
      if (lineOfSight(this.world, d.pos, this.#target, spec.detectionRange)) {
        this.foundAt = round(this.t); this.finish('found');
      }
    } else if (spec.kind === 'package-drop') {
      if (this.payload.status === 'falling') this.#stepParcel(dt);
    } else {
      const holding = v.dist(d.pos, this.#navigationTarget()) <= spec.padRadius
        && v.len(d.vel) <= spec.maxHoldSpeed
        && (!spec.requireNoContactDuringHold || !d.touching);
      if (!this.payload || this.payload.status === 'carried') this.holdSeconds = holding ? this.holdSeconds + dt : 0;
      if (this.holdSeconds >= spec.requiredHoldSeconds - 1e-9) {
        if (spec.kind === 'delivery-checkpoint') this.finish('delivery_checkpoint');
        else if (this.payload.status === 'carried') this.#releaseParcel();
      }
      if (this.payload?.status === 'falling') this.#stepParcel(dt);
    }
    // A parcel already falling is allowed to land (package-drop only).
    if (!this.done && this.t >= spec.timeLimitSeconds - 1e-9 && !(spec.kind === 'package-drop' && this.payload.status === 'falling')) this.finish('timeout');
    if (this.step % 6 === 0 || this.done) this.record();
  }

  finish(outcome) { this.done = true; this.outcome = outcome; }

  #releaseParcel() {
    const parcel = this.payload, spec = this.#spec;
    parcel.position = v.add(this.drone.pos, [0, -this.P.droneRadius - spec.parcelRadius - .02, 0]);
    parcel.velocity = this.drone.vel.slice();
    parcel.releasedAt = round(this.t);
    if (spec.kind === 'package-drop') {
      parcel.releaseHeight = round(this.drone.pos[1] - this.#target[1]);
      parcel.releaseSpeed = round(v.len(this.drone.vel));
    }
    if (this.world.sphereHits(parcel.position, spec.parcelRadius)) {
      parcel.status = 'blocked'; this.events.push({ type: 'release_blocked', t: round(this.t), position: r2(parcel.position) });
      this.finish('payload_collision'); return;
    }
    parcel.status = 'falling';
    this.events.push({ type: 'payload_released', t: round(this.t), position: r2(parcel.position), velocity: r2(parcel.velocity),
      gravity: spec.gravity, mode: spec.kind === 'package-drop' ? 'commanded' : 'automatic_after_stable_hover' });
  }

  #stepParcel(dt) {
    const parcel = this.payload, spec = this.#spec;
    parcel.velocity[1] -= spec.gravity * dt;
    const from = parcel.position.slice(), to = v.add(from, v.scale(parcel.velocity, dt));
    const steps = Math.max(1, Math.ceil(v.dist(from, to) / Math.max(.02, spec.parcelRadius * .5)));
    let previous = from;
    for (let i = 1; i <= steps; i++) {
      const p = v.lerp(from, to, i / steps), hit = this.world.sphereHits(p, spec.parcelRadius);
      if (hit) {
        parcel.position = previous;
        const downwardSurface = p[1] < previous[1] && hit.id !== 'bounds'
          && this.world.sphereHits([previous[0], p[1], previous[2]], spec.parcelRadius);
        parcel.status = downwardSurface ? 'landed' : 'blocked';
        parcel.velocity = [0, 0, 0]; parcel.landedAt = round(this.t);
        const horizontalDistance = Math.hypot(previous[0] - this.#target[0], previous[2] - this.#target[2]);
        const heightError = Math.abs(previous[1] - this.#target[1]);
        const delivered = downwardSurface && horizontalDistance <= spec.padRadius && heightError <= spec.landingHeightTolerance;
        this.events.push({ type: downwardSurface ? 'payload_landed' : 'payload_collision', t: round(this.t), position: r2(previous),
          horizontalDistance: round(horizontalDistance), heightError: round(heightError), insidePad: Boolean(delivered) });
        if (spec.kind === 'package-drop') {
          parcel.landingError = round(horizontalDistance); parcel.landingHeightError = round(heightError);
          const tooHigh = parcel.releaseHeight > spec.maxReleaseHeight + 1e-9;
          this.finish(!downwardSurface ? 'payload_collision' : tooHigh ? 'released_too_high' : delivered ? 'delivered' : 'missed_pad');
          return;
        }
        this.finish(delivered ? 'delivered' : downwardSurface ? 'misdelivered' : 'payload_collision');
        return;
      }
      previous = p;
    }
    parcel.position = to;
  }

  result() {
    const out = {
      outcome: this.outcome, task: this.#spec.kind, time: round(this.t),
      targetFound: this.foundAt !== null, foundAt: this.foundAt,
      continuousHoldSeconds: round(this.holdSeconds),
      contacts: this.drone.contacts.length, touchSeconds: round(this.touchSeconds),
      touchFraction: round(this.t ? this.touchSeconds / this.t : 0),
      pathLength: round(this.drone.pathLength), endPos: r2(this.drone.pos),
      payload: this.payload ? structuredClone(this.payload) : null,
      events: structuredClone(this.events),
    };
    // Extra fields only for missions v2 delivery, so earlier results are unchanged.
    if (this.#spec.kind === 'package-drop') {
      const p = this.payload;
      out.drop = { released: p.releasedAt !== null, releasedAt: p.releasedAt, releaseHeight: p.releaseHeight ?? null, releaseSpeed: p.releaseSpeed ?? null,
        landingError: p.landingError ?? null, landingHeightError: p.landingHeightError ?? null, padRadius: this.#spec.padRadius, maxReleaseHeight: this.#spec.maxReleaseHeight };
    }
    return out;
  }
}
