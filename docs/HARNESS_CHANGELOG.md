# Harness changelog

Every harness change tried, kept or not. Rule: one change at a time on the dev set, paired by scenario and seed, and keep it only if the paired 95% CI of the primary metric (progress toward the goal) excludes zero in its favour. Rows are appended by `sim/tools/study/reach_compare.mjs --log`.

## Harness v1 (2026-11-18): rules for plugged-in models

A code audit before the public release found five defects in how flights were scored and analysed. They are fixed for new runs. The published results (methodology v3 and v4) were flown and analysed under v0 and are not changed: all 5,276 recorded v3 flights still re-fly exactly, and `RESULTS_V3.md` regenerates to the same numbers. `sim/tools/bench_report.mjs` labels each report with its harness version and refuses to mix versions. Tests: `sim/test/harness_v1.test.mjs`.

| Defect in v0 | What v1 does |
|---|---|
| A reply that parsed as JSON but had the wrong shape (no `velocity`, two numbers instead of three) became a hover and was not counted as invalid. | The reply is checked. A wrong shape gets the same one retry as an unparseable reply, then the previous command stands and the decision is counted invalid. |
| At C4 (turn, forward, climb), an invalid reply repeated the previous command, so the drone turned again. One 90° turn and three invalid replies made a full circle. | The previous command stands with the turn removed: the drone keeps its heading. |
| When the host or the network failed after every retry, the step was recorded as an invalid decision by the model. | The flight is dropped and not scored. `bench.mjs` flies it again when the same command is re-run; `reach_eval.mjs` stops without writing a summary. |
| A program's `Math.random` used the same generator and seed as the wind, so a program could in principle reproduce the gusts. | `reach_eval.mjs` and `reach_cap.mjs` give programs a separate seed by default (`--random separate`). `--random legacy` re-flies a published program as recorded. |
| The bootstrap's random generator lost precision and repeated every 10,466 draws; one bootstrap needs about 96,000. | New reports draw from the simulator's generator with 10,000 resamples. |

**Recheck of the published tests.** With a correct generator and 20,000 resamples (six seeds), every pre-registered v3 conclusion is the same. H1, the program against tuned live steering, is +21 pp [+6, +35] with p between 0.0047 and 0.0058, against 0.012 as published. H2, H3 and H4 remain unsupported. The v3 and v4 report scripts keep the old generator so that the published tables regenerate exactly.

**Not changed in v1.** The prompt, the observation, the physics and the route sets are the same as v0. The primary score still ignores wall contact, the test routes are public, and the practice loop still runs one model. Those are design decisions for a later version.

### Does v1 line up with the published results? (2026-11-18)

Checked without new model calls, because the model's host was rate-limited that night.

- **Live steering.** Every recorded Ripple reply in 35 published and development runs was re-scored under the v1 rules. Of 94,479 replies, 30 (0.03%) have a shape v1 would reject and v0 flew as a hover; in the two published test runs it is 2 of 13,925. No decision in the published test runs was a network failure scored as invalid. So for Ripple, v1 and v0 score the same flights the same way to within 0.03% of decisions.
- **Programs and scripted pilots.** Flown again under v1 on all 48 test routes in 2 winds: Ripple's selected program 65%, tuned hand-written pilot 55%, default hand-written pilot 47%, straight-line 11%, planner 100%. These match the published table, and all 96 program flights are identical to the recorded ones.
- **Not yet done.** A fresh live Ripple run under v1, the practice loop under v1, and any measurement of the memory feature below.

### Added with v1, all opt-in

- **Memory for live steering** (`--features memory`). The model writes a note of up to 40 words each second and gets it back the next second, with a list of where it was and what it commanded over the last 8 seconds. Without it the model sees only its last three commands. It is off by default: the published prompt is unchanged, and 13 earlier prompt changes on Ripple did not help, so this one needs a measurement before it becomes the default.
- **Any place.** `sim/tools/maps/add_place.mjs` builds a place from a size and a list of walls, makes its route sets by the usual rule, flies the scripted pilots, and refuses to register a place where the planner fails or flying straight succeeds. `bench.mjs --map` flies any registered place. The example is `sim/scenes/places/warehouse.json` (planner 100%, hand-written pilot 58%, straight-line 38% on its development routes).
- **Any model.** `reach_eval.mjs`, `reach_cap.mjs` and `mission_cap.mjs` take `--model <id>` from `sim/bench/models.json`. An entry with `baseUrl` points at any OpenAI-compatible endpoint, such as a local server.

## Integrity checks (2026-11-19): route overlap, wind, sensor noise

No harness file changed and no published number moved; details and tables in [RESULTS_INTEGRITY.md](RESULTS_INTEGRITY.md).

- **Correction to DETAILS.md.** It said the v3 evaluation fixed the overlap between practice and test routes. It did not: `makeReachSets` only keeps reversed pairs apart, and 18 of 48 factory test routes (26 of 48 residential, 9 of 48 canyon) share a start or goal waypoint with a practice route. On the recorded flights the selected program reached 67% on shared routes and 63% on the rest, so the sentence is corrected rather than the result. New sets can use `makeReachSetsDisjoint` (`sim/src/gym/reach_sets_v2.js`), where no waypoint is in two sets.
- **Opt-in wind** (`reach_eval.mjs --wind light|moderate|strong`, `sim/src/gym/reach_perturb.js`): a steady wind plus stronger gusts. The published gusts move the drone about 0.24 m per decision.
- **Opt-in sensor noise** (`reach_eval.mjs --noise low|medium|high|severe`): position and velocity noise, range noise and dropout on free space.
- **Defaults are unchanged.** Without `--wind` or `--noise` the evaluator builds the plain `Reach`. Re-flown with the edited evaluator, `runs/reach/baselines-dev` (144 flights) and `runs/reach/heldout6-cap2-run3` (144 flights) are identical to the recorded ones in outcome, every command and every frame.

## Missions v2 (2026-11-19): search and delivery

An audit found three defects in the mission tools. They are fixed for new runs. Each fix has a legacy option, and under it every recorded v4 and v5 pilot mission run re-derives exactly (`sim/tools/mission_replay_check.mjs`; results in [RESULTS_MISSIONS_V2.md](RESULTS_MISSIONS_V2.md)).

| Defect | What missions v2 does | Re-fly old runs with |
|---|---|---|
| `mission_cap.mjs` broke ties between search versions on closest approach to the hidden hiker, for both the version a run revised from and the version it froze. | Ties go to the ground the drone's own detector looked at (inside the assigned sector when there is one), then the earliest version (`--select earned`, default). Delivery keeps progress, since the pad position is given. | `--select legacy` |
| `mission_cap.mjs` and `mission_eval.mjs` gave a program's `Math.random` the wind's seed. | A separate seed, as in the Reach tools (`--random separate`, default). | `--random legacy` |
| The v5 pilot's onboard map (`--sensors map`) checked `straight_line_clear` against the true collision geometry, and its `nearest_unsearched` list was frontier selection done by the harness: a plan. | `--sensors map` now gives raw cells built only from the drone's own scans (unknown stays unknown) and `known_clear_m` computed over scanned cells only. The program does its own planning. | `--sensors map-v5pilot` |

New mission kinds: search with an assigned sector (`searchArea`), and `package-drop` (explicit release, landing error and release height recorded). New sets: `sim/scenarios/mission-v2-factory-{search,delivery}.json` (train 12, dev 24, no test set).

## Noise floor: the same v0 harness, run six times (C3, 24 dev scenarios × 1 seed)

An accident made this measurement possible. Five runs launched as feature tests silently ran plain v0: the shell passed `--features X` as a single argument, which the parser ignored. Every summary recorded `features: []`. They are relabelled as v0 repeats. The runner now rejects merged arguments and derives its harness label from the features actually enabled.

| Run | Reached | Progress |
|---|---|---|
| `runs/reach/c3-none` | 50% | 77% |
| `runs/reach/c3-v0-repeat1` | 42% | 73% |
| `runs/reach/c3-v0-repeat2` | 33% | 71% |
| `runs/reach/c3-v0-repeat3` | 38% | 69% |
| `runs/reach/c3-v0-repeat4` | 33% | 76% |
| `runs/reach/c3-v0-repeat5` | 33% | 68% |

Identical configuration: reached ranges **33–50%**, progress **68–77%**. Single-run differences of this size are noise. Feature tests therefore use 24 scenarios × 2 seeds, paired, and pre-fix single-seed feature results are not used for decisions.

All 360 Reach episodes from these runs re-fly exactly from their recorded commands (`sim/tools/reach_verify.mjs`).

## Changes tried

| Date | Env · level | Change | From → to run | n | Reached | Progress (primary) | Wall contacts / min | Verdict |
|---|---|---|---|---|---|---|---|---|
| 2026-11-15 | reach · ripple@C3 | rel: goal as relative vector + compass word (sensor) | `runs/reach/c3s2-v0` → `runs/reach/c3s2-rel` | 48 | 29% → 25% (Δ -4 pp [-19, 10]) | 76% → 65% (Δ -11 pp [-21, 0]) | 73.8 → 47.0 (Δ -26.8 [-37.6, -16.9]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | struct: name goal / blocked / chosen direction before acting (structure) | `runs/reach/c3s2-v0` → `runs/reach/c3s2-struct` | 48 | 29% → 25% (Δ -4 pp [-19, 8]) | 76% → 71% (Δ -5 pp [-13, 3]) | 73.8 → 68.7 (Δ -5.0 [-11.5, 2.1]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | ascii: 15x15 m top-down obstacle map from sensors (representation) | `runs/reach/c3s2-v0` → `runs/reach/c3s2-ascii` | 48 | 29% → 33% (Δ 4 pp [-8, 17]) | 76% → 71% (Δ -5 pp [-15, 4]) | 73.8 → 80.9 (Δ 7.1 [-2.3, 17.1]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | trail: own recent positions + recent wall contacts (memory) | `runs/reach/c3s2-v0` → `runs/reach/c3s2-trail` | 48 | 29% → 35% (Δ 6 pp [-6, 21]) | 76% → 71% (Δ -5 pp [-17, 6]) | 73.8 → 73.7 (Δ -0.1 [-12.3, 12.9]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | all four together | `runs/reach/c3s2-v0` → `runs/reach/c3s2-all` | 48 | 29% → 35% (Δ 6 pp [-8, 21]) | 76% → 77% (Δ 1 pp [-8, 10]) | 73.8 → 70.3 (Δ -3.5 [-11.1, 4.3]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | named: command = compass direction + speed, harness converts to velocity (action encoding) | `runs/reach/c3s2-v0` → `runs/reach/c3s2-named` | 48 | 29% → 19% (Δ -10 pp [-29, 6]) | 76% → 66% (Δ -10 pp [-21, 1]) | 73.8 → 66.5 (Δ -7.3 [-13.2, -0.8]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | warn: proximity + time-to-contact sensor | `runs/reach/c3s2-v0` → `runs/reach/c3s2-warn` | 48 | 29% → 21% (Δ -8 pp [-17, 0]) | 76% → 61% (Δ -15 pp [-24, -5]) | 73.8 → 76.5 (Δ 2.7 [-5.5, 11.1]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | named + warn together | `runs/reach/c3s2-v0` → `runs/reach/c3s2-named-warn` | 48 | 29% → 8% (Δ -21 pp [-35, -8]) | 76% → 44% (Δ -32 pp [-43, -19]) | 73.8 → 67.0 (Δ -6.8 [-13.4, 1.1]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | notes: Ripple's own notes from 2 rounds of verified training flights (train set only) | `runs/reach/c3s2-v0` → `runs/reach/c3s2-notes` | 48 | 29% → 38% (Δ 8 pp [-6, 23]) | 76% → 70% (Δ -6 pp [-16, 3]) | 73.8 → 71.6 (Δ -2.2 [-10.1, 5.4]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | placebo: generic advice, length-matched to the notes (control) | `runs/reach/c3s2-v0` → `runs/reach/c3s2-placebo` | 48 | 29% → 31% (Δ 2 pp [-10, 17]) | 76% → 63% (Δ -13 pp [-25, -1]) | 73.8 → 76.6 (Δ 2.8 [-7.8, 14.1]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | notes vs placebo (content control) | `runs/reach/c3s2-placebo` → `runs/reach/c3s2-notes` | 48 | 31% → 38% (Δ 6 pp [-8, 19]) | 63% → 70% (Δ 7 pp [-3, 17]) | 76.6 → 71.6 (Δ -5.0 [-16.1, 5.1]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | lean: compact observation + short rules, goal-distance forecast only (subtraction) | `runs/reach/c3s2-v0` → `runs/reach/c3s2-lean` | 48 | 29% → 29% (Δ 0 pp [-12, 13]) | 76% → 70% (Δ -6 pp [-14, 3]) | 73.8 → 72.4 (Δ -1.4 [-12.1, 9.1]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | lean + its own notes compressed to 5 facts (~70 words) | `runs/reach/c3s2-v0` → `runs/reach/c3s2-lean-notes` | 48 | 29% → 31% (Δ 2 pp [-8, 15]) | 76% → 68% (Δ -8 pp [-17, 3]) | 73.8 → 64.0 (Δ -9.8 [-19.5, 0.1]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | dt2: one decision every 2 s instead of every 1 s | `runs/reach/c3s2-v0` → `runs/reach/c3s2-dt2` | 48 | 29% → 29% (Δ 0 pp [-17, 17]) | 76% → 64% (Δ -12 pp [-21, -4]) | 73.8 → 70.3 (Δ -3.4 [-12.6, 6.8]) | **revert** |
| 2026-11-15 | reach · ripple@C3 | short notes on top of lean (lean+notes vs lean) | `runs/reach/c3s2-lean` → `runs/reach/c3s2-lean-notes` | 48 | 29% → 31% (Δ 2 pp [-15, 19]) | 70% → 68% (Δ -2 pp [-12, 10]) | 72.4 → 64.0 (Δ -8.4 [-22.3, 5.6]) | **revert** |
| 2026-11-15 | reach · ripple@C3 → program@C3 | code as policy: Ripple-written program (run 0, frozen best-on-train v7) instead of per-second velocity decisions | `runs/reach/c3s2-v0` → `runs/reach/cap-dev-run0` | 48 | 29% → 46% (Δ 17 pp [0, 33]) | 76% → 67% (Δ -9 pp [-18, 2]) | 73.8 → 33.9 (Δ -39.8 [-47.3, -32.6]) | **revert** |
| 2026-11-15 | reach · ripple@C3 → program@C3 | code as policy: Ripple-written program (run 1, frozen best-on-train v8) instead of per-second velocity decisions | `runs/reach/c3s2-v0` → `runs/reach/cap-dev-run1` | 48 | 29% → 52% (Δ 23 pp [2, 44]) | 76% → 75% (Δ -1 pp [-12, 11]) | 73.8 → 83.1 (Δ 9.3 [-2.1, 22.0]) | **revert** |
| 2026-11-15 | reach · ripple@C3 → program@C3 | code as policy: Ripple-written program (run 2, frozen best-on-train v7) instead of per-second velocity decisions | `runs/reach/c3s2-v0` → `runs/reach/cap-dev-run2` | 48 | 29% → 60% (Δ 31 pp [17, 46]) | 76% → 82% (Δ 6 pp [-2, 16]) | 73.8 → 77.2 (Δ 3.4 [-7.4, 15.3]) | **revert** |

**Code as policy, loop fix (2026-11-15):** loop 1 (`runs/reach/cap-loop1-truncated`) lost half its versions to compile errors. Every one was a reply cut off at the 3,500-token output limit (`finish: length`, programs ~12k characters), and the broken code was then fed back as "your current program". Loop 2 raises the limit to 8,000 tokens and always revises from the best *working* version, reporting the failed attempt's error. That's a plumbing change, not help to the model. In loop 2, only 1 of 24 versions failed to compile (not a truncation).

**Selection rule for the headline program:** the program with the best TRAIN score across runs (run 2 v7, 7/12 reached and 88% progress on train) is the one carried forward. Dev numbers for the other runs are reported but were not used to choose.
| 2026-11-15 | reach · ripple@C3 → program@C3 | HELD-OUT look 1/3: code as policy (run 2 v7, chosen on train) vs per-second Ripple | `runs/reach/heldout-ripple-v0` → `runs/reach/heldout-program-run2` | 48 | 23% → 38% (Δ 15 pp [-4, 33]) | 70% → 75% (Δ 5 pp [-4, 14]) | 70.1 → 70.7 (Δ 0.6 [-10.0, 9.7]) | **revert** |
| 2026-11-15 | reach · reactive@C3 → program@C3 | HELD-OUT look 1/3: code as policy (run 2 v7) vs hand-written reactive avoider | `runs/reach/heldout-baselines` → `runs/reach/heldout-program-run2` | 48 | 21% → 38% (Δ 17 pp [-2, 33]) | 61% → 75% (Δ 14 pp [3, 25]) | 26.0 → 70.7 (Δ 44.7 [37.0, 53.1]) | **KEEP** |
| 2026-11-15 | reach · reactive@C3 → program@C3 | HELD-OUT look 2/3 (6 seeds): code as policy, program chosen on train across 8 runs (cap2 run 3 v7) vs hand-written reactive avoider | `runs/reach/heldout6-baselines` → `runs/reach/heldout6-cap2-run3` | 144 | 22% → 44% (Δ 22 pp [8, 38]) | 61% → 74% (Δ 13 pp [3, 25]) | 28.0 → 43.0 (Δ 15.0 [8.9, 21.6]) | **KEEP** |
| 2026-11-15 | reach · ripple@C3 → program@C3 | HELD-OUT look 2/3 (6 seeds): code as policy, program chosen on train across 8 runs (cap2 run 3 v7) vs per-second Ripple | `runs/reach/heldout6-ripple-v0` → `runs/reach/heldout6-cap2-run3` | 144 | 17% → 44% (Δ 27 pp [9, 44]) | 65% → 74% (Δ 9 pp [1, 16]) | 77.5 → 43.0 (Δ -34.5 [-40.0, -29.0]) | **KEEP** |

**Held-out bookkeeping:** look 1 (2 seeds, 3 runs) and look 2 (6 seeds, 8 runs) are logged above. Look 2's selected program is the best on TRAIN across all 8 runs (cap2 run 3 v7). It replaced look 1's choice (cap run 2 v7) only because a new run scored higher on train, not because of any held-out number. One held-out look remains.
