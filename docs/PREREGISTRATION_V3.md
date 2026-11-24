# Pre-registration: methodology v3 (one look at fresh routes)

Written 2026-11-15, **before** any controller is run on the routes below, and committed before the evaluation. Each evaluation set below is evaluated once. No harness, program, parameter or selection rule changes after this file is committed. Results are reported whatever they show.

## Why v3

The v2 headline (Ripple's program reaches 44% of held-out routes, 2.6× per-second Ripple) left three openings (launch review of 2026-11-15):

1. **Unequal budgets.** The program got 8 rounds of training-route feedback and best-of-8 selection. Per-second Ripple and the hand-written avoider got neither.
2. **Forking paths.** 5 loop runs were added after the first held-out look.
3. **One building.**

v3 gives every controller the same training-route budget and selection rule, and evaluates once on routes nobody has looked at, plus a second building.

## Evaluation sets (never used for anything before this)

| Set | Routes | Wind seeds | Flights per controller | Source |
|---|---|---|---|---|
| **Factory test** | 48 (`X1`–`X48`) | the 2 listed per route | 96 | `sim/scenarios/reach-factory-test.json`, `makeReachSets(..., test: 48)`, disjoint from train/dev/held-out |
| **Building transfer** | 40 (`X1`–`X40`) | the 2 listed per route | 80 | the two-floor greybox `sim/maps/building.json`, same physics, same route rule |

## Controllers and selection rules (all selection on the 12 TRAIN routes only)

| Name | What | Selected how |
|---|---|---|
| **program** | Ripple-written controller | Of all 24 loop runs (`runs/reach/cap/run0-2`, `cap2/run0-4`, `cap3/run0-15`), each run's frozen `best.js`. The one with the highest train **reached**, ties broken by train progress, then run order. (This is the rule that picked the v2 headline program.) |
| **programs (all 24)** | Every run's frozen `best.js`, averaged per flight | No selection: the method-level result |
| **per-second v0** | Ripple, one velocity per second, plain prompt | None |
| **per-second, tuned** | Ripple, one velocity per second | The prompt variant with the highest train progress (then reached) among 13: v0, rel, struct, ascii, trail, all four, named, warn, named+warn, lean, notes, lean+notes, dt2 (`runs/reach/v3train-*`) |
| **avoider** | Hand-written reactive avoider, default parameters | None |
| **avoider, tuned** | Same avoider, parameters tuned | Best train progress (then reached) among 193 parameter sets (`runs/reach/avoider-tuned/best.json`), the same number of candidates the 24 loop runs evaluated |
| planner (map + A*) | Upper bound | — |
| straight line | Floor | — |

Per-second controllers run only on the factory test set: their prompt describes the factory, and they have nothing learned to transfer.

## Hypotheses (primary metric: share of flights that reach the goal)

Paired by route and wind seed, 95% cluster bootstrap over routes (2,000 resamples), Holm correction across the four:

- **H1.** program > per-second, tuned (factory test)
- **H2.** program > avoider, tuned (factory test)
- **H3.** programs (all 24, averaged) > per-second v0 (factory test)
- **H4.** program > avoider, tuned (building transfer)

Secondary, reported without correction: progress toward the goal, share of time touching walls, flights reached with no wall contact, and every other pairing in the tables.

## What would change the write-up

- H1 and H2 hold: the headline becomes "beats per-second Ripple and a tuned controller given the same training budget, on fresh routes".
- H3 holds: the claim no longer depends on picking the best run.
- H4 holds: "and it transfers to a building it never saw".
- Any that fail are reported as failed, in the write-up, next to the ones that hold.
