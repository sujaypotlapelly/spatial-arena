# Missions v2: search and delivery as working tasks (2026-11-19)

Dev set only, demonstration level. Nothing here is a significance test, and no test set was built or flown. Run output is in the main checkout under `runs/missions-v2/`.

## 1. Three defects, verified and fixed

Each fix has a legacy option. Under the legacy options every recorded v4 and v5 pilot mission run re-derives exactly (section 2).

**1. Search selection used the hidden hiker.** `mission_cap.mjs` broke ties between versions with equal find counts by "progress", the closest approach to the hiker's true position. It did so both for the version a run revised from and for the version it froze, while the feedback text told the model nothing about the hiker. In the v4 runs that tie-break switched the base version 21 times in the factory, 36 in the canyon and 44 in the cottages. 1 of 24 factory runs, 7 of 24 canyon runs and 8 of 24 cottage runs froze a version that found nobody on train; the hidden-target distance chose which one. **Fix:** `--select earned` (default). Ties go to the ground the drone's own detector looked at (`sensedCoverage` in `sim/src/gym/mission_select.js`: 25 downward rays, once per second, out to the detection range, cells where a ray meets a surface; inside the assigned sector when there is one), then the earliest version. Delivery keeps progress as its tie-break, because the pad position is given to the program. `--select legacy` is the old rule.

Re-flying every recorded v4 search version shows how much the old rule mattered. Under the earned rule the frozen version changes in 4 of 24 factory runs, 5 of 24 canyon runs and 9 of 24 cottage runs. The zero-find frozen versions remain (1, 7 and 8), because in those runs no version found anyone.

The same tie-break also chose across runs. `runs/v5pilot/eval.sh` picked the run carried to dev by train finds, then progress. For search, progress is closest approach to the hidden hiker. That script lives in `runs/` and is not changed here. The practice run below picks across runs by finds, then ground covered.

**2. Programs shared the wind's random seed.** `mission_cap.mjs` and `mission_eval.mjs` passed only `seed`, so a program's `Math.random` produced the same sequence as the gust generator. **Fix:** `--random separate` (default), using `programRandomSeed` from `policy_sandbox.js` as the Reach tools do; `--random legacy` re-flies published programs.

**3. The v5 onboard map was not senses-only.** `straight_line_clear` called `world.segmentClear` on the true collision grid, and `nearest_unsearched` was frontier selection done by the harness, which is a plan. **Fix:** `--sensors map` now gives raw 1 m cells built only from the drone's own lidar rays (unknown, open, searched, obstacle) and `known_clear_m`, which walks scanned cells only and stops at the first unknown one. The program does its own planning. The old map is kept unchanged as `--sensors map-v5pilot`, so the v5 pilot re-flies. This affects the v5 pilot only, not any published number.

## 2. Replay proof (no model calls)

`sim/tools/mission_replay_check.mjs`, output in `runs/missions-v2/replay-proof/`.

| Check | What is compared | Result |
|---|---|---|
| A. Selection | Base version per revision and frozen version, recomputed from recorded curves with `--select legacy` | 120/120 v4 runs, 64/64 v5 pilot runs identical |
| B. Train evaluation, frozen versions | Success, progress, contacts per minute, runtime errors, compile error and the full feedback text, re-flown with `--random legacy --select legacy` | 184/184 identical |
| B. Train evaluation, every version | Same, for all 1,536 recorded versions (960 v4, 576 v5 pilot) | 1,535/1,536 identical; see below |
| C. Dev episodes | Result, every command and every frame of recorded dev flights (programs, explorer, pad seeker, oracle, v5 frontier explorer on `map-v5pilot`) | 576/576 identical |
| Unit test | Hash of observations, result and frames of a scripted flight on three v4 and v5 pilot missions (basic, lidar, v5 map), pre-v2 code against new code | identical (`sim/test/missions_v2.test.mjs`) |

The single difference is v4 factory-search run0 v6, not a frozen version. In that pass it showed runtime errors that the recording does not have. Re-flown alone three times, it matches the recording exactly (4/12 found, 0 errors). The cause is the sandbox's 50 ms wall-clock limit per policy call, which fired while three heavy jobs shared the machine. That limit can make any recording that ran near 50 ms per call non-reproducible under load. It predates this work and is not changed here.

## 3. What a search drone knows (checked in code)

Before detection, a search observation holds the time, the drone's own position and velocity, `free_space_m`, optionally lidar and the onboard map, and `search` = { objective, `target_location_known: false`, detection range, detection rule, `target: null` }. The initial heading is fixed at 0, not toward the hiker. A test checks that two missions differing only in the hiker's position give identical observations over 20 seconds of flight. The feedback text never mentions the hiker's position.

## 4. Why v4 search reached only 10 to 14%

- **Unreachable or uncaptured hiding places** (canyon, from the research log): 28 of 48 canyon test hikers were in closed hollows under the scanned ground.
- **No search area.** The hiker could be 15 to 35 m away in any direction, in a 2,664 m² factory, with 90 s to look. Even the hand-written explorer found 18% on the factory test set. That is a needle-in-a-building task, not a search pattern.
- **Hiding places not where a person could be.** Of the 36 v4 factory train and dev hikers, 8 are not on the main walkable floor by the v2 rule below.
- **Selection on the hidden target** (defect 1), which picked among zero-find versions by information the program never had.

## 5. The v2 search task (factory)

`sim/src/gym/mission_v2.js`, sets in `sim/scenarios/mission-v2-factory-search.json` (generator `sim/tools/mission_sets_v2.mjs`).

- **Where a person can be.** Floor columns with 1.8 m of headroom, joined by steps of at most 0.35 m into the building's main floor; a hiding place also needs its 8 neighbours on that floor (room to lie down). The beacon sits 0.3 m above the floor.
- **Where the drone can reach.** A 0.5 m flight lattice built from the collision map. Every hiker must be visible, with 0.5 m to spare, from a lattice node reachable from the launch point.
- **Search sector.** A 24 × 24 m rectangle given to the drone (`obs.search.area`), with the hiker uniformly placed inside it. The drone launches inside the sector at least 8 m from the hiker, without line of sight to it.
- **Detection.** Within 5 m with a clear straight line (the mission's existing rule). 90 s per flight.
- **Sets.** 12 train and 24 dev missions, two wind seeds each, hiding places at least 4 m apart, so no train target is a dev target. No test set.

### Reference points (dev, 24 missions × 2 seeds = 48 flights, no model calls)

| Controller | What it knows | Found | 95% CI | Mean time when found | Contacts / flight | Hiding places seen |
|---|---|---|---|---|---|---|
| Map oracle | map and hiker | 48/48 | 100–100% | 6.2 s | 2.5 | 25% |
| Map cover | map, not the hiker: greedy coverage tour over the walkable floor | 47/48 | 94–100% | 12.7 s | 5.4 | 48% |
| Coverage sweep | own scans only: shortest path over its own map to the nearest unsearched or frontier cell | 27/48 | 38–75% | 31.6 s | 22.4 | 38% |
| Lane sweep | own sensors only: parallel lanes across the sector, free-space avoidance | 24/48 | 33–69% | 37.5 s | 38.9 | 27% |
| Random walk | own sensors only: random headings, kept inside the sector | 19/48 | 23–56% | 38.4 s | 24.0 | 29% |
| v4 explorer | own sensors only (no sector) | 16/48 | 19–50% | 28.6 s | 22.0 | 26% |
| Hover | nothing | 0/48 | 0–0% | | 41.3 | 11% |

"Hiding places seen" is the fraction of the sector's hiding places (one per 1 m cell) that were ever within 5 m with line of sight (privileged analysis, not shown to any controller). Flights stop at a find, so it is lower for controllers that find quickly. CIs are bootstrapped over missions.

The sensor-only references fall short of the map-equipped one mainly on time. They spend the first part of the flight learning the layout, and in clutter they bump along walls (22 to 39 contacts per flight).

## 6. Ripple's practice run (search, v2)

Ripple (`ricursiveai/ripple-65b-preview`, pinned host) wrote search controllers with the repaired loop: `mission_cap.mjs --sets v2 --task search --sensors map --runs 3 --iters 6`, so `--select earned --random separate`. It saw the 12 train missions (wind seed 1 only) and nothing from dev. Each run froze its best train version (most finds, then most ground covered by its own detector, then earliest), and that program was flown unchanged on dev with the same sensors. The host was heavily rate limited (other sessions had priority): 19 replies took 43 minutes and 157 rate-limit retries. Run output: `runs/missions-v2/search-practice/` and `runs/missions-v2/search-practice-dev-run*/`.

Train curves (found out of 12, per version v1 to v6; `x` = the reply did not compile):

| Run | v1 | v2 | v3 | v4 | v5 | v6 | Frozen |
|---|---|---|---|---|---|---|---|
| run 0 | 0 | 0 | 0 | 0 | 1 | 2 | v6 (2/12) |
| run 1 | 0 | 2 | 1 | x | 2 | 1 | v5 (2/12; ties v2 on finds, more ground covered) |
| run 2 | 0 | 1 | 2 | 5 | 2 | 3 | v4 (5/12) |

Dev (24 missions × 2 seeds = 48 flights), next to the references from section 5:

| Controller | Found | 95% CI | Contacts / flight | Hiding places seen |
|---|---|---|---|---|
| Map cover (knows the map) | 47/48 | 94–100% | 5.4 | 48% |
| Coverage sweep (own scans) | 27/48 | 38–75% | 22.4 | 38% |
| Lane sweep | 24/48 | 33–69% | 38.9 | 27% |
| Random walk | 19/48 | 23–56% | 24.0 | 29% |
| **Ripple run 2, v4** (best on train) | **13/48** | 10–44% | 87.9 | 27% |
| Ripple run 1, v5 | 12/48 | 10–42% | 90.0 | 28% |
| Ripple run 0, v6 | 4/48 | 0–19% | 31.4 | 18% |
| Ripple, all three frozen programs | 29/144 (20%) | | | |

**How far the model's program is.** The best-on-train Ripple program found the hiker in 13 of 48 dev flights. The coverage sweep, which uses the same sensors and the same onboard map, found 27. Map cover, which also knows the building's layout, found 47. So Ripple's program finds about half as many as the sensor-only sweep and about a quarter as many as the map-equipped upper bound. It also does worse than a random walk (19 of 48). It spends much of each flight against walls, with about 90 contacts per flight against 22 to 39 for the hand-written sensor-only controllers. Its own comments describe lane sweeps with a reactive avoidance layer, and most of its revisions were about getting unstuck. The other two runs did no better (12 and 4 of 48); across all three frozen programs Ripple found 29 of 144 (20%). Run 0 never found more than 2 of 12 on train. With 3 runs of 6 versions, this is a demonstration of the repaired task and loop, not an estimate of what Ripple can do with a larger budget. The intervals overlap with the lane sweep and random walk; the gap to the coverage sweep and to map cover is the plain finding.

On these runs the earned and legacy selection rules happen to freeze the same versions.

## 7. The v2 delivery task (factory)

Kind `package-drop` in `sim/src/gym/rescue_tasks.js`, sets in `sim/scenarios/mission-v2-factory-delivery.json`.

- **Before:** `package-delivery` gave the pad position (and said so), held position 1 m above it for 2 s, and released automatically.
- **Now:** the program carries the parcel to the pad, descends, and releases with `{ release: true }`. The parcel falls with the drone's velocity at release. **Delivered** means it lands on the pad surface within **0.5 m** of the centre (and within 0.2 m of the pad's height), released from no more than **2 m** above the pad. Other outcomes: `missed_pad`, `released_too_high`, `payload_collision`, `timeout` (never released). Every flight records the release height, release speed and landing error.
- **Sets.** Flat open pads 15 to 35 m from launch with no straight path to them, a clear hover point 1 m above, 12 train and 24 dev, no test set.

| Controller (dev, 48 flights) | Delivered | 95% CI | Median landing error | Contacts / flight |
|---|---|---|---|---|
| Map oracle (lattice path, settle, release on predicted landing point) | 48/48 | 100–100% | 0.22 m | 3.8 |
| Pad seeker (own sensors and the given pad position, same release rule) | 20/48 | 21–62% | 0.19 m | 28.9 |
| Hover | 0/48 | 0–0% | | 40.4 |

The release rule both references share (release when the predicted landing point is within 0.3 m and the drone moves slower than 0.4 m/s) was tuned on train after a first version that rarely released in gusts. The pad seeker's failures are navigation timeouts (28 of 28 failures), not bad drops. No model has flown v2 delivery yet.

## 8. What is not verified

- One environment (the factory). The v2 generator should apply to the outdoor scenes but was not run there.
- The sensor-only search references are first versions, not tuned; a better hand-written sweep may close more of the gap to map cover.
- The hiding-place prior (uniform over walkable floor in the sector) and the 24 m sector size are design choices, not calibrated to real search data.
- `sensedCoverage` counts surfaces the detector's rays reached, which tracks but does not equal the chance of detecting a hiker there.
- Dev results are 24 missions × 2 seeds. Ripple's numbers come from 3 runs of 6 versions on a rate-limited host.
