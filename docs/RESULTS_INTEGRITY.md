# Integrity checks on Reach (2026-11-19)

An audit on 2026-11-19 raised three doubts about the navigation results: practice and test routes share places, the "two wind conditions" are nearly one, and the senses are exact. This page tests each one with no model calls: it splits flights that were already recorded, and re-flies frozen programs and scripted pilots on development routes.

**No published number changes.** The 65% factory figure stands as published. What changes is how it should be described: the test routes are not fully separate from the practice routes, the two winds are close to one condition, and the senses are exact. None of the three explains the 65%.

How to reproduce (run outputs are in `runs/integrity/`, which is git-ignored):

```bash
node sim/tools/study/integrity_overlap.mjs
node sim/tools/study/integrity_wind.mjs
node sim/tools/study/integrity_report.mjs
```

The sweeps were flown with `sim/tools/reach_eval.mjs --set dev --seeds 6 --conditions program@C3,reactive@C3,straight@C2 --program runs/reach/cap2/run3/best.js --random legacy` plus `--wind <level>` or `--noise <level>`.

## 1. Practice and test routes share waypoints

`makeReachSets` (`sim/src/gym/reach.js`) keeps a route and its reverse out of two sets, but nothing stops a test route from starting or ending at a waypoint a practice route also uses. The practice report in `reach_cap.mjs` gives the program the start and goal coordinates of every practice route, so in principle a program could learn places rather than learn to fly.

**How many routes share an endpoint with a practice route** (counted from the pinned scenario files):

| Map | Dev | Held-out | Test | Test routes whose goal is a practice endpoint | Test routes sharing both ends |
|---|---|---|---|---|---|
| Factory (v3) | 6/24 | 7/24 | 18/48 | 8 | 2 |
| Residential (v4) | 13/24 | 18/24 | 26/48 | 16 | 7 |
| Canyon (v4) | 5/24 | 6/24 | 9/48 | 4 | 0 |

These confirm the audit's counts.

**Does sharing help?** Recorded test flights, split by route. Reached flights / flights, 95% interval from a bootstrap over routes. The last column is the difference between the two groups with a bootstrap over the routes of each group.

Factory, methodology v3 (18 shared routes, 30 not; 2 wind seeds each):

| Controller | All | Shares an endpoint | Shares none | Shared minus none |
|---|---|---|---|---|
| Map + A* planner | 96/96 = 100% | 36/36 = 100% | 60/60 = 100% | 0 pp |
| Program Ripple wrote (cap2/run3) | 62/96 = 65% [51%, 77%] | 24/36 = 67% [44%, 86%] | 38/60 = 63% [47%, 80%] | +3 pp [-23, +29] |
| All 24 programs, pooled | 988/2304 = 43% | 378/864 = 44% [30%, 58%] | 610/1440 = 42% [31%, 54%] | +1 pp [-17, +19] |
| Avoider, tuned on train | 53/96 = 55% | 19/36 = 53% [33%, 72%] | 34/60 = 57% [40%, 73%] | -4 pp [-29, +22] |
| Avoider, hand-written | 45/96 = 47% | 16/36 = 44% [22%, 67%] | 29/60 = 48% [30%, 67%] | -4 pp [-32, +26] |
| Ripple live, best prompt on train | 42/96 = 44% | 18/36 = 50% [31%, 69%] | 24/60 = 40% [27%, 53%] | +10 pp [-14, +33] |
| Ripple live, plain prompt | 32/96 = 33% | 14/36 = 39% [19%, 58%] | 18/60 = 30% [17%, 45%] | +9 pp [-16, +34] |
| Straight-line flyer | 11/96 = 11% | 6/36 = 17% [3%, 33%] | 5/60 = 8% [0%, 18%] | +8 pp [-9, +27] |

On the 8 factory test routes whose goal is a practice endpoint, the program reached 10/16 (63%).

Outdoor, methodology v4, the program selected on each map:

| Map | Controller | All | Shares an endpoint | Shares none | Shared minus none |
|---|---|---|---|---|---|
| Residential | Program Ripple wrote here (run6) | 73/96 = 76% | 36/52 = 69% [52%, 85%] | 37/44 = 84% [70%, 95%] | -15 pp [-35, +6] |
| Residential | Avoider, tuned on train | 73/96 = 76% | 37/52 = 71% | 36/44 = 82% | -11 pp [-32, +11] |
| Residential | Avoider, hand-written | 71/96 = 74% | 42/52 = 81% | 29/44 = 66% | +15 pp [-9, +39] |
| Residential | Straight-line flyer | 32/96 = 33% | 21/52 = 40% | 11/44 = 25% | +15 pp [-9, +40] |
| Canyon | Program Ripple wrote here (run3) | 66/96 = 69% | 10/18 = 56% [22%, 89%] | 56/78 = 72% [58%, 85%] | -16 pp [-52, +18] |
| Canyon | Avoider, tuned on train | 54/96 = 56% | 9/18 = 50% | 45/78 = 58% | -8 pp [-41, +26] |
| Canyon | Avoider, hand-written | 50/96 = 52% | 9/18 = 50% | 41/78 = 53% | -3 pp [-37, +32] |
| Canyon | Straight-line flyer | 36/96 = 38% | 8/18 = 44% | 28/78 = 36% | +9 pp [-26, +44] |

**What this means for the 65%.** On the factory, the program does about as well on routes that share no waypoint with practice (63%) as on routes that do (67%). Outdoors it does worse on shared routes, not better. There is no sign that it memorised places. The intervals are wide, though: with 18 shared routes the test could miss an advantage of up to about 30 points. The honest statement is that the overlap is real, it is not what produces the result, and future sets should not have it.

**Fix for future sets.** `sim/src/gym/reach_sets_v2.js` adds `makeReachSetsDisjoint`: every waypoint belongs to at most one set, so no start or goal used by train appears in dev, held-out or test, and by default endpoints of different sets are at least 3 m apart. The route rule (15 to 35 m, no straight line of sight, a detour of at least 15%) is unchanged. It fills the usual 12 / 24 / 24 / 48 routes on the factory, residential and canyon maps; on the factory the nearest test endpoint is 3.5 m from any practice endpoint. It throws rather than return a short set. `makeReachSets` and every published set are unchanged. `sim/test/reach_integrity.test.mjs` checks the property on three maps.

## 2. The two wind conditions are close to one

Each route is flown under two wind seeds. The gusts are an Ornstein-Uhlenbeck acceleration with a standard deviation of 0.8 m/s² and a 1.5 s correlation time, against a velocity loop with a 0.25 s time constant (`FreeDrone.step` in `core.js`).

**Measured disturbance** (open air, 400 seeds, 25 s each after 5 s to settle; `runs/integrity/wind-disturbance.json`). Hovering and cruising at 3 m/s give the same numbers.

| Wind | Velocity off command, mean / 95th pct | Drift over one 1 s decision, mean / 95th pct | Drift over 5 s, mean / 95th pct | Average velocity offset over 25 s |
|---|---|---|---|---|
| Published gusts (0.8 m/s²) | 0.25 / 0.47 m/s | 0.24 / 0.45 m | 0.88 / 1.64 m | 0.09 m/s |
| Light: steady 1.5 m/s², gusts x2 | 0.60 / 1.11 m/s | 0.58 / 1.06 m | 2.46 / 4.35 m | 0.40 m/s |
| Moderate: steady 3 m/s², gusts x3 | 1.12 / 2.37 m/s | 1.08 / 2.28 m | 4.87 / 10.39 m | 0.87 m/s |
| Strong: steady 4.5 m/s², gusts x4 | 2.25 / 5.50 m/s | 2.19 / 5.45 m | 10.32 / 24.26 m | 1.91 m/s |

The published gusts move the drone about a quarter of a metre per decision, a quarter of the 1 m goal radius, and average out over a flight. That is why the selected program had the same outcome under both seeds on 44 of 48 test routes (the hand-written avoider 47 of 48, the straight-line flyer 45 of 48).

**New opt-in wind.** `sim/src/gym/reach_perturb.js` adds `WindyDrone`: a steady horizontal wind (a constant push from a direction drawn once per flight) plus the same gust process scaled up. It is seeded from the flight's wind seed and replays exactly. With no steady wind and unscaled gusts it is identical to `FreeDrone` (tested). Select it with `reach_eval.mjs --wind light|moderate|strong`.

**Dev routes, 24 routes x 6 wind seeds = 144 flights per cell.** The change is paired with the no-wind run by route and seed, with a bootstrap over routes.

| Wind | Controller | Reached | 95% CI | Change vs published gusts [95% CI] | Routes with the same outcome on all 6 seeds |
|---|---|---|---|---|---|
| Published gusts | Program (cap2/run3) | 87/144 = 60% | 43% to 77% | | 14/24 |
| Published gusts | Avoider, hand-written | 61/144 = 42% | 24% to 62% | | 22/24 |
| Published gusts | Straight-line flyer | 4/144 = 3% | 0% to 8% | | 22/24 |
| Light | Program | 90/144 = 63% | 46% to 78% | +2 pp [-5, +9] | 16/24 |
| Light | Avoider | 57/144 = 40% | 23% to 58% | -3 pp [-10, +3] | 19/24 |
| Light | Straight-line | 8/144 = 6% | 1% to 10% | +3 pp [-1, +7] | 19/24 |
| Moderate | Program | 84/144 = 58% | 44% to 72% | -2 pp [-10, +6] | 9/24 |
| Moderate | Avoider | 56/144 = 39% | 22% to 57% | -3 pp [-14, +5] | 18/24 |
| Moderate | Straight-line | 23/144 = 16% | 9% to 24% | +13 pp [+6, +21] | 11/24 |
| Strong | Program | 62/144 = 43% | 31% to 56% | -17 pp [-28, -7] | 7/24 |
| Strong | Avoider | 46/144 = 32% | 19% to 46% | -10 pp [-22, +0] | 13/24 |
| Strong | Straight-line | 25/144 = 17% | 10% to 24% | +15 pp [+7, +22] | 10/24 |

All 1,728 flights in the four wind runs re-flew exactly from their recorded commands.

**What this means for the 65%.** The 65% was measured in light air, so it says nothing about flying in wind; "two wind conditions" should be read as "two draws of near-calm air". The program holds up in light and moderate wind (within 2 points) and loses 17 points in strong wind, where the drone is pushed several metres per second off its command. The avoider loses 10. The straight-line flyer gets better with wind, because a push sideways sometimes slides it around the wall it would otherwise press against; that is a property of this sliding-contact physics, not skill. In stronger wind the seeds also stop agreeing (the program gives the same outcome on all 6 seeds for 14 of 24 routes in published gusts, 7 of 24 in strong wind), so more seeds per route would buy more information there.

## 3. The senses are exact

Position, velocity, goal coordinates and `free_space_m` are reported without noise, and `free_space_m` is a sphere-cast of the drone's own size, not a ranged sensor.

**New opt-in noise.** `PerturbedReach` in `sim/src/gym/reach_perturb.js` adds Gaussian noise to the reported position (and recomputes the goal distance from it) and velocity, multiplicative range noise on each free-space reading, and dropout, where a direction reports no return (the 12 m maximum) as a real range sensor does. It has its own generator, seeded from the wind seed, so it never changes the physics and every flight replays exactly. Select it with `reach_eval.mjs --noise low|medium|high|severe`. Goal coordinates are not perturbed: they are the task, not a reading.

| Level | Position (m, per axis) | Velocity (m/s, per axis) | Range noise | Dropout |
|---|---|---|---|---|
| Low | 0.1 | 0.1 | 5% | 2% |
| Medium | 0.3 | 0.2 | 10% | 5% |
| High | 0.6 | 0.4 | 20% | 10% |
| Severe | 1.0 | 0.6 | 30% | 20% |

**Dev routes, 144 flights per cell, published gusts unless stated.**

| Noise | Controller | Reached | 95% CI | Change vs exact senses [95% CI] |
|---|---|---|---|---|
| None | Program (cap2/run3) | 87/144 = 60% | 43% to 77% | |
| None | Avoider, hand-written | 61/144 = 42% | 24% to 62% | |
| None | Straight-line flyer | 4/144 = 3% | 0% to 8% | |
| Low | Program | 92/144 = 64% | 47% to 81% | +3 pp [-5, +12] |
| Low | Avoider | 62/144 = 43% | 24% to 63% | +1 pp [-1, +3] |
| Medium | Program | 92/144 = 64% | 47% to 79% | +3 pp [-3, +12] |
| Medium | Avoider | 62/144 = 43% | 24% to 62% | +1 pp [-5, +8] |
| High | Program | 96/144 = 67% | 51% to 81% | +6 pp [-2, +16] |
| High | Avoider | 69/144 = 48% | 30% to 66% | +6 pp [-3, +15] |
| Severe | Program | 83/144 = 58% | 42% to 73% | -3 pp [-9, +3] |
| Severe | Avoider | 72/144 = 50% | 33% to 67% | +8 pp [-1, +17] |
| Moderate wind + medium noise | Program | 72/144 = 50% | 36% to 64% | -10 pp [-19, -1] |
| Moderate wind + medium noise | Avoider | 66/144 = 46% | 28% to 63% | +3 pp [-3, +10] |
| Moderate wind + medium noise | Straight-line | 23/144 = 16% | 9% to 24% | +13 pp [+6, +21] |

The straight-line flyer is 4/144 at every noise level: it steers only by the goal coordinates, which are not perturbed. All 2,160 flights in the five noise runs re-flew exactly.

**What this means for the 65%.** Neither the program nor the avoider depends on exact senses. Noise up to a metre of position error and 20% dropout does not measurably hurt either, and at the middle levels both do slightly better (not significant). The likely reason is that both fail mainly by getting stuck in a repeating pattern against geometry, and noise jitters them out of it. So exact senses do not inflate the 65%, but this benchmark also does not test perception: a sensor model this simple cannot be the reason a controller succeeds or fails. The one combination that hurt was moderate wind with medium noise on the program (-10 pp [-19, -1]), larger than either alone; one combination is not enough to call that an interaction.

## What is not verified

- No test set was flown. All sweeps are on factory DEV routes with the frozen program `cap2/run3` and the hand-written avoider; the tuned avoider and live Ripple were not flown under wind or noise (live Ripple would need model calls).
- The node-disjoint generator has not been used to fly anything. Moving the benchmark to it would change every set and needs its own pre-registration.
- The wind and noise levels are chosen by hand to span "barely noticeable" to "pushed off course". They are not calibrated to any real drone or sensor.
- The overlap splits are post hoc and underpowered; they rule out a large memorisation effect, not a small one.
