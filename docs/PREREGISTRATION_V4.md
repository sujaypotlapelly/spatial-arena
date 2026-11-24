# Pre-registration: methodology v4 (three environments, three tasks)

**Frozen 2026-11-15, approved by Sujay, committed before any v4 model call.** From this commit on, no harness, map, mission set, program or selection rule changes, and each test set is evaluated once. Two pieces of tooling listed at the end (the mission-baseline tuner and the test-pass script) are written afterwards; they must implement exactly the rules stated here.

## Question

Can Ripple write drone controllers that work across different environments and tasks, rather than only in the factory where it was developed?

v3 answered this for one building pair (factory, then a greybox building). v4 runs the same method on three real scanned environments and three tasks, with identical physics, sensors, prompt and budget in every cell. Only the scene changes.

## Environments

| Environment | Map | Source | Altitude rule | Units |
|---|---|---|---|---|
| Factory | `sim/maps/factory-full.json` (existing) | Factory scan collider | Real roof | metres |
| Canyon | `sim/maps/canyon.json` | Zohar riverbed SuperSplat collider, **rescaled ×8** (Amendment 2; originally ×2, then ×4) | Ceiling at y = 20, the ×1 ceiling of 2.5 scaled up | scene units ×8, treated as metres, not calibrated |
| Cottages | `sim/maps/residential.json` | Utlida SuperSplat collider | 4.5 above the surrounding terrain (lowest ground within 6) | scene units, roughly metres, not calibrated |

Rebuild with `node sim/tools/maps/build_splat_map.mjs --scene canyon|residential`, using the parameters in `sim/scenes/benchmark-maps.json`. Each map is a conservative 0.25-unit occupancy grid. Outdoors, the altitude rule is a flight rule, not scanned geometry: without it the drone could fly over every obstacle. The waypoint graph serves only route generation, the A* upper bound and progress metrics. Controllers never see it.

**The canyon ×2 scale was chosen after looking at dev baselines.** At scale 1, the canyon was too small for 15–35 m routes, and a hand-written explorer found 94% of hikers. Scale 2 lets every environment use the same route band, time limit and detection range. The capture's true scale is unknown at either setting.

## Tasks and sets

All sets: **train 12 / dev 24 / test 48** items, 2 wind seeds each (96 test flights per controller), disjoint and seeded. Each hiker spot and pad is used once, so test targets never appear in training. Every flight lasts at most 90 s. Decisions are made every 1 s in all cells.

| Task | Success | Generator | Cells |
|---|---|---|---|
| **Reach**: fly A to B; goal position known | Within 1 m of goal | `makeReachSets` (15–35 m, no line of sight, detour ≥ 1.15); `sim/scenarios/reach-*.json` | factory, canyon, cottages |
| **Search**: find a hidden hiker; position unknown | Within 5 m with clear line of sight | `make_mission_sets.mjs`; hiker 0.3 above ground, hidden at launch, 15–35 m away | factory, canyon, cottages |
| **Delivery**: hover over a pad, hold 2 s, parcel drops and must land on the pad | Parcel lands inside the 0.3 radius pad | `make_mission_sets.mjs`; flat pads, no straight line from launch, 15–35 m | factory, cottages |

There is no canyon delivery. At this resolution the rocky floor has only about 51 flat pad spots, too few for disjoint 12/24/48 sets.

Checks are in `sim/test/benchmark_envs.test.mjs`. Sets regenerate exactly, targets are disjoint, the oracle succeeds, and search observations never contain the hiker.

## Controllers (all selection on TRAIN only)

| Name | What | Selected how |
|---|---|---|
| **program** | Ripple-written controller for this cell | 24 loop runs × 8 versions (`reach_cap.mjs --map` / `mission_cap.mjs --map --task`). Each run keeps its best train version. The program is the run with the most train successes, then train progress, then run order |
| **programs (all 24)** | Every run's best, averaged per flight | No selection |
| **factory program, zero-shot** | Reach: v3's selected `cap2/run3` v7, unchanged. Missions: the factory cell's selected program | Fixed in advance |
| **cross-environment programs** | For each task, the program selected in environment A, flown on environment B's test set | Fixed by the rule above |
| **sensor-only baseline, tuned** | Reach: the avoider. Search: `explorer`. Delivery: `padSeeker` (`sim/src/gym/mission_agents.js`) | Best train score among 193 parameter sets, the same candidate budget as the loop (`reach_tune_avoider.mjs --map`; the mission tuner is still to be written) |
| sensor-only baseline, hand-written | Same baselines with default parameters | — |
| oracle / planner (privileged) | A* on the waypoint graph; for search it also knows where the hiker is | Upper bound |
| straight line | Reach only | Floor |

## Hypotheses

Primary metric is the success share. Comparisons are paired by item and wind seed, with a 95% cluster bootstrap over items (2,000 resamples) and Holm correction across all primary tests.

- **G1 (per cell, 8 tests).** In each environment × task cell, program > tuned sensor-only baseline (test set).
- **G2 (reach, 2 tests).** In canyon and cottages, the in-environment program > the factory program flown zero-shot. This tests whether re-running the method in a new place helps.
- **G3 (method-level, 8 tests).** programs (all 24, averaged) > hand-written sensor-only baseline, per cell.

Secondary, reported without correction: the full cross-environment transfer matrix, progress, contacts, time touching, and per-run spread.

## Disclosed looks before this draft

These were all on dev sets or train, never on test:

- Oracle, explorer and padSeeker on dev missions in every cell. These looks set the canyon scale, the canyon detection range and time limit, and the oracle viewpoint fix.
- A* planner, straight line, avoider, and the v3 factory program `cap2/run3` v7 on dev reach routes in canyon (scale 1 and scale 2) and cottages. Dev results for the factory program: canyon ×2 21%, cottages 0%. In the cottages it cruises at the factory's absolute altitude of 1.0, which is below ground there.
- No Ripple model calls have been made for v4.

The mission prompt says that ground height varies by place. It is the same in every cell, and it is a generic statement, not a route.

## Budget and order

1. `reach_cap.mjs --map canyon|residential --runs 24 --iters 8`: 2 × 192 calls.
2. `mission_cap.mjs --map M --task T --runs 24 --iters 8` for 5 cells: 5 × 192 calls. Factory reach already has its 24 runs.
3. Tune sensor-only baselines on train: free.
4. Freeze selections, then one test pass of every controller in every cell, plus the transfer matrix: free. Programs run locally.

That is about 1,350 calls in total. v3 used about 4.4k prompt and 3.2k completion tokens per coding call, so expect roughly 6M prompt and 4.3M completion tokens. Each cell is about 10–20 minutes of wall time with 24 runs in parallel.

Optional and much larger: per-second Ripple ("live steering") in the new cells needs about 90 calls per flight. Its prompt also describes an indoor factory and would need a scene-neutral variant first.

## Still to build before the test pass

- A tuner for the explorer and padSeeker baselines, mirroring `reach_tune_avoider.mjs`.
- A v4 select/run/report script, mirroring `reach_v3_select.mjs` / `reach_v3_run.mjs` / `reach_v3_report.mjs`, that refuses to run twice.

## Exact coding-loop commands

```sh
node sim/tools/reach_cap.mjs   --map canyon      --runs 24 --iters 8 --out runs/reach/v4cap/canyon
node sim/tools/reach_cap.mjs   --map residential --runs 24 --iters 8 --out runs/reach/v4cap/residential
node sim/tools/mission_cap.mjs --map factory     --task search   --runs 24 --iters 8 --out runs/missions/v4cap/factory-search
node sim/tools/mission_cap.mjs --map canyon      --task search   --runs 24 --iters 8 --out runs/missions/v4cap/canyon-search
node sim/tools/mission_cap.mjs --map residential --task search   --runs 24 --iters 8 --out runs/missions/v4cap/residential-search
node sim/tools/mission_cap.mjs --map factory     --task delivery --runs 24 --iters 8 --out runs/missions/v4cap/factory-delivery
node sim/tools/mission_cap.mjs --map residential --task delivery --runs 24 --iters 8 --out runs/missions/v4cap/residential-delivery
```

Factory reach reuses v3's 24 runs (`runs/reach/cap`, `cap2`, `cap3`), selected by the same rule.

## Amendment 1 (2026-11-15, before any test look): canyon rescaled from ×2 to ×4

**Why.** Sujay reviewed the canyon in the 3D viewer and found the drone far larger than a bush on the canyon floor that looks about 1 m tall. Measuring the collider supports this. At scale 1, isolated floor objects (bushes and rocks) are 0.25–0.45 units tall, and the walls rise 5–7 units from floor to rim. At ×4 a bush is about 1 m and the walls are about 20–28 m. At ×2 the drone was oversized relative to the scene.

**What changed.**
- `sim/maps/canyon.json` was rebuilt at ×4 with a ceiling at y = 10, the ×1 ceiling of 2.5 scaled up. Parameters are in `sim/scenes/benchmark-maps.json`.
- `sim/scenarios/reach-canyon.json` and `sim/scenarios/mission-canyon-search.json` were regenerated with the same seeds and rules.
- The canyon's route band, time limit and detection range are unchanged, the same as every other environment.
- No other cell changed.

**What was discarded.** The ×2 canyon coding loops (reach and search) were stopped part-way and the ×2 tuned baselines were set aside. They are kept under `runs/reach/v4cap/canyon-x2-abandoned` and `runs/missions/v4cap/canyon-search-x2-abandoned` (and the `v4tune` equivalents). None of their programs is used. No test set was evaluated at either scale.

**Looks at ×4 before relaunch (dev only).**
- Reach: A* 100%, straight line 38%, avoider 52%, the v3 factory program 2%.
- Search: oracle 100%, explorer 2%.

The canyon loops and tuners are rerun with the exact commands listed above.

## Amendment 2 (2026-11-15, before any test look): canyon rescaled from ×4 to ×8

**Why.** Sujay placed a correctly scaled drone in a lower channel of the canyon in the 3D viewer and chose ×8 by eye. At ×8 the narrowest pinch of that channel is about 6 m. The video also needs the voxel view to look fine-grained there. The collider's native 0.05-unit voxels become 0.4 m at ×8, so the benchmark grid now uses 0.4 m cells. That is the collider's own resolution, with no false precision.

**Considered and rejected.** A benchmark confined to the lower channels. At ×8 the scan's collider splits those channels into separate pockets, joined only over the rim. Whole-canyon flights still pass through the channels where they connect. Video shots through the channels will be chosen from recorded flights, separately from the benchmark.

**What changed.**
- The ×8 crop covers the same region as at ×4, and the ceiling rule is unchanged (2.5 at ×1, so y = 20).
- The waypoint graph has 220 samples, edges up to 24 m long, and 213 connected waypoints. These serve only routes, the oracle and metrics.
- `sim/scenarios/reach-canyon.json` and `sim/scenarios/mission-canyon-search.json` were regenerated with the same seeds and rules.
- No other cell changed.

**What was discarded.** The partial ×4 canyon loops and tuners, kept under `*-x4-abandoned` and unused. No test set has been evaluated at any scale.

**Looks at ×8 before relaunch (dev only).**
- Reach: A* 100%, straight line 19%, avoider 40%, the v3 factory program 0%.
- Search: oracle 100%, explorer 2%.
