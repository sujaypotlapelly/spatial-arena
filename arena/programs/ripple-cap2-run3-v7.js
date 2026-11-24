// ---------------------------------------------------------------------------
// v7: rewritten policy based on the stuck-state logs of v6.
//
// Diagnosis of v6 failures (from the stuck-state logs):
//   * Multiple flights ended with the drone pressed against a *corner* or a
//     wall while the goal was in a direction the policy considered
//     "admissible" but the clearance there was tiny (0.5-1.2 m).  The drone
//     then oscillated against the same surface for the rest of the flight.
//     Cause: the ADMISS threshold (0.5 m) was too permissive, and the
//     "back up along the largest-clearance direction" fallback could pick a
//     direction that was *perpendicular* to the wall, i.e. it slid along the
//     wall instead of escaping it.
//   * Flight 1 is the clearest example: at [-12.8,0.5,-1.4] the sensors show
//     north = 6.3, north_west = 12, west = 12, and the goal is at [-10.6,-0.9],
//     i.e. to the north-east.  The policy returned vz = +4.42 (north) but the
//     drone was sliding along the north wall; it needed to go *west* first
//     (west = 12 m free) to get around the corner, then north.
//     A pure "max alignment with goal" score cannot see around the corner.
//   * Flight 6 is the mirror case: the goal is directly north (dz = +4.7) and
//     north clearance is 2.8 m, but the drone was pressed against the south
//     wall (south = 2.5, south_west = 1.5) and the policy returned vz = +3.41
//     while vx = 0.  It was driving straight at the goal but the goal was not
//     in line of sight, so there was a wall between; the drone should have
//     gone around to the east or west first.
//   * Flight 5: the goal is south-east and the drone returned vx = +3.04
//     (east) while south_west/south/south_east were all 0.  It drove into a
//     dead-end corridor.
//   * Altitude was mostly fine in v6, but the "descend toward the goal" logic
//     combined with a low ceiling (up = 0.3 in flight 2) produced vertical
//     jitter that wasted time.
//
// New design (v7):
//   * Harder admissibility: a direction is only admissible if its clearance
//     is >= 1.0 m, OR the direction is the goal direction and clearance is
//     >= 0.75 m (we still want to approach when we can).  This prevents
//     driving into corners with 0.5-1.0 m gaps.
//   * The fallback when nothing is admissible is now a *deliberate wall
//     escape*: find the direction with the largest clearance, and if the
//     drone is pressed against a surface (>= 2 blocked sensors), prefer a
//     direction that is NOT parallel to the wall (i.e. turn away from the
//     wall) for at least one tick.  This is what fixes flights 1, 5 and 6.
//   * Added a "stuck detector" that fires when the drone has not reduced its
//     distance to the goal over the last N ticks AND its velocity is small
//     or it is pressed against a wall: on firing, it forces a 90-degree turn
//     away from the wall for a few ticks (memory.escapeUntil).
//   * Added a "corner detector": if two perpendicular sensors are blocked
//     (e.g. east and south both 0), the drone is in a corner; it must turn
//     toward the third open direction, not slide along either wall.
//   * Goal-seeking is now two-phase:
//       Phase A (far): head roughly toward the goal, but strongly prefer
//         directions that increase the *maximum clearance* (i.e. open up the
//         corridor) when the best alignment is weak or the goal is not in
//         line of sight.  This makes the drone naturally go around corners.
//       Phase B (close, LOS): drive straight at the goal.
//   * Altitude: cruise at 1.0 m, descend to the goal's altitude when lower and
//     there is room below, hard floor 0.45 m, and never ascend into a ceiling
//     with clearance < 0.6 m.  Vertical velocity is rate-limited and clamped.
//   * Speed: floor 2.0 m/s, scale with clearance, cap 5.5 m/s; when escaping
//     a wall, boost to 3.5 m/s for one tick to break contact quickly.
//   * Arrival: stop within 1.0 m; also stop if LOS and within 1.5 m and
//     closing.
//   * Visited grid is kept but only used as a weak tie-breaker; the main
//     exploration pressure now comes from the "open up the corridor" term.
// ---------------------------------------------------------------------------

function policy(obs, memory) {
  // ---- tunables ---------------------------------------------------------
  const MAX_SPD  = 5.5;
  const HOVER_H  = 1.0;
  const LOW_H    = 0.45;
  const ARRIVE   = 1.0;
  const ADMISS   = 1.0;    // minimum clearance to consider a direction
  const ADMISS_G = 0.75;   // ...but allow the goal direction at this clearance
  const CELLSZ   = 2.0;

  // ---- state init -------------------------------------------------------
  if (!memory.init) {
    memory.init = true;
    memory.steps = 0;
    memory.visited = {};
    memory.lastDir = -1;
    memory.lastContacts = -1;
    memory.stuckTicks = 0;
    memory.escapeUntil = 0;   // ticks remaining in a forced escape
    memory.escapeDir = -1;    // direction index to escape toward
    memory.lastGoalDist = 1e9;
    memory.goalStallTicks = 0;
  }

  memory.steps++;

  const pos   = obs.position;
  const vel   = obs.velocity;
  const g     = obs.goal.position;
  const gDist = obs.goal.distance_m;
  const los   = obs.goal.in_line_of_sight;
  const fs    = obs.free_space_m;

  // ---- arrival ----------------------------------------------------------
  if (gDist <= ARRIVE) {
    return { velocity: [0, 0, 0] };
  }
  if (los && gDist < 1.6) {
    const closing = (pos[0] - vel[0]) * (g[0] - pos[0]) +
                    (pos[2] - vel[2]) * (g[2] - pos[2]);
    if (closing > 0) return { velocity: [0, 0, 0] };
  }

  // ---- bookkeeping ------------------------------------------------------
  const contacts = obs.wall_contacts_so_far;
  if (contacts !== memory.lastContacts) {
    memory.stuckTicks = 0;
    memory.lastContacts = contacts;
  } else {
    memory.stuckTicks++;
  }

  // Visited grid.
  const cx = Math.round(pos[0] / CELLSZ);
  const cz = Math.round(pos[2] / CELLSZ);
  memory.visited[cx + "," + cz] = memory.steps;

  // ---- goal geometry ----------------------------------------------------
  const dx = g[0] - pos[0];
  const dz = g[2] - pos[2];
  const dH = Math.hypot(dx, dz) || 1e-3;
  const gx = dx / dH;
  const gz = dz / dH;

  // ---- altitude ---------------------------------------------------------
  let altTarget = HOVER_H;
  if (g[1] < pos[1] - 0.3 && fs.down > 0.6) {
    altTarget = Math.max(g[1] + 0.25, LOW_H);
  }
  if (fs.up < 0.6) altTarget = Math.min(altTarget, pos[1]);

  let dy = 2.2 * (altTarget - pos[1]);
  if (pos[1] < LOW_H) dy = Math.max(dy, 2.0);
  if (fs.up < 0.6)    dy = Math.min(dy, -0.4);
  dy = Math.max(-2.2, Math.min(2.2, dy));

  // ---- direction tables -------------------------------------------------
  const NAMES = ["east","north_east","north","north_west",
                 "west","south_west","south","south_east"];
  const VX = [1, 0.7071, 0, -0.7071, -1, -0.7071, 0, 0.7071];
  const VZ = [0, 0.7071, 1, 0.7071, 0, -0.7071, -1, -0.7071];

  const CLEAR = NAMES.map((n) => Math.max(0, fs[n]));
  const ALIGN = NAMES.map((_, i) => VX[i] * gx + VZ[i] * gz);

  // Goal direction index (nearest of the 8).
  let gDir = 0;
  let gBest = -2;
  for (let i = 0; i < 8; i++) {
    if (ALIGN[i] > gBest) { gBest = ALIGN[i]; gDir = i; }
  }

  // Which sensors are blocked?
  const blocked = NAMES.map((_, i) => CLEAR[i] < ADMISS);

  // Count blocked sensors and detect a corner (two perpendicular blocked).
  const nBlocked = blocked.filter(Boolean).length;
  let inCorner = false;
  for (let i = 0; i < 8; i++) {
    if (!blocked[i]) continue;
    const perp = (i + 2) % 8;
    if (blocked[perp]) { inCorner = true; break; }
  }

  // ---- stuck / escape handling -----------------------------------------
  // If we are pressed against a wall and have not made progress toward the
  // goal for a while, force an escape for a few ticks.
  if (memory.escapeUntil > 0) memory.escapeUntil--;
  if (memory.escapeUntil <= 0) memory.escapeDir = -1;

  const gDistNow = gDist;
  if (gDistNow < memory.lastGoalDist - 0.5) {
    memory.goalStallTicks = 0;
  } else {
    memory.goalStallTicks++;
  }
  memory.lastGoalDist = gDistNow;

  const pressed = nBlocked >= 2;
  const slow = Math.hypot(vel[0], vel[2]) < 1.2;
  const needEscape =
    (pressed && memory.goalStallTicks > 6) ||
    (inCorner && memory.goalStallTicks > 4) ||
    (memory.stuckTicks > 12 && memory.goalStallTicks > 8);

  if (needEscape && memory.escapeUntil <= 0) {
    // Choose an escape direction: the admissible direction with the largest
    // clearance that is NOT parallel to the wall we are pressed against.
    let bestEsc = -1;
    let bestEscScore = -Infinity;
    for (let i = 0; i < 8; i++) {
      if (CLEAR[i] < ADMISS) continue;
      // Penalise directions parallel to a blocked wall.
      const par1 = (i + 2) % 8;
      const par2 = (i + 6) % 8;
      let pen = 0;
      if (blocked[par1] || blocked[par2]) pen = 1.0;
      const sc = Math.min(CLEAR[i], 6.0) - pen * 1.5;
      if (sc > bestEscScore) { bestEscScore = sc; bestEsc = i; }
    }
    if (bestEsc >= 0) {
      memory.escapeDir = bestEsc;
      memory.escapeUntil = 4;
      memory.goalStallTicks = 0;
    }
  }

  // ---- direction scoring ------------------------------------------------
  let bestI = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < 8; i++) {
    // Admissibility: hard threshold, except the goal direction gets a little
    // slack so we can still approach when the gap is 0.75-1.0 m.
    if (CLEAR[i] < ADMISS && !(i === gDir && CLEAR[i] >= ADMISS_G)) continue;

    // Escape override: while escaping, strongly prefer the escape direction.
    if (memory.escapeUntil > 0 && memory.escapeDir === i) {
      bestI = i;
      bestScore = 1e6;
      continue;
    }

    let score = 0;

    // Phase A vs B: when the goal is in LOS we can drive straight at it.
    // Otherwise we want to open up the corridor.
    const phaseStraight = los || gDist < 4.0;

    if (phaseStraight) {
      // Dominant alignment term.
      score += ALIGN[i] * 4.0;
      // Clearance reward (saturating).
      score += Math.min(CLEAR[i], 4.0) * 0.5;
    } else {
      // Open-up term: prefer directions with large clearance even if they
      // are not perfectly aligned.  This is what lets the drone go around
      // a corner instead of sliding along a wall.
      score += Math.min(CLEAR[i], 6.0) * 0.55;
      score += ALIGN[i] * 1.6;
      // Bonus for directions that are *not* parallel to a blocked wall.
      const par1 = (i + 2) % 8;
      const par2 = (i + 6) % 8;
      if (blocked[par1] || blocked[par2]) score -= 0.8;
    }

    // Wall-slide bonus: moving along a wall is good when it is not the only
    // option (i.e. we are not in a corner).
    const perp1 = (i + 2) % 8;
    const perp2 = (i + 6) % 8;
    if (!inCorner && (blocked[perp1] || blocked[perp2])) score += 0.7;

    // Penalty for reversing.
    if (memory.lastDir === (i + 4) % 8) score -= 1.5;

    // Weak exploration tie-breaker.
    const nx = Math.round((pos[0] + VX[i] * 2.0) / CELLSZ);
    const nz = Math.round((pos[2] + VZ[i] * 2.0) / CELLSZ);
    const lastVisit = memory.visited[nx + "," + nz] || -1e9;
    const age = memory.steps - lastVisit;
    if (Math.abs(ALIGN[i]) < 0.5) score += Math.min(age, 60) * 0.015;

    if (score > bestScore) {
      bestScore = score;
      bestI = i;
    }
  }

  // ---- fallback: nothing admissible ------------------------------------
  if (bestI < 0) {
    // Back up along the direction with the largest clearance, but never the
    // direction we were just driving into.
    let bi = 0;
    for (let i = 1; i < 8; i++) {
      if (CLEAR[i] > CLEAR[bi]) bi = i;
    }
    if (memory.lastDir === bi) bi = (bi + 2) % 8;
    bestI = bi;
  }

  memory.lastDir = bestI;

  // ---- speed ------------------------------------------------------------
  const corridor = Math.max(CLEAR[bestI], 0.5);
  let speed = Math.min(MAX_SPD, 2.0 + corridor * 0.35);
  if (memory.escapeUntil > 0) speed = Math.min(MAX_SPD, 3.5);

  let vx = VX[bestI] * speed;
  let vz = VZ[bestI] * speed;

  // ---- final 3D speed cap ----------------------------------------------
  const sp = Math.hypot(vx, dy, vz);
  if (sp > MAX_SPD) {
    const k = MAX_SPD / sp;
    vx *= k; dy *= k; vz *= k;
  }

  return { velocity: [vx, dy, vz] };
}