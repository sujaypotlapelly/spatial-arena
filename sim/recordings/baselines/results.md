## Held-out baselines (12 scenarios × 4 seeds = 48 trials)

| Condition | Success [95% CI] | Intercepted | Crashed | Solved |
|---|---|---|---|---|
| Ripple + strategy (930b632 run) | 77% [63–87] | 6% [2–17] | 17% [9–30] | 10/12 |
| Ripple original (930b632 run) | 71% [57–82] | 27% [17–41] | 2% [0–11] | 9/12 |
| Ripple original (recording) | 69% [55–80] | 23% [13–37] | 8% [3–20] | 9/12 |
| Ripple + strategy (recording) | 67% [53–78] | 8% [3–20] | 25% [15–39] | 9/12 |
| Tuned fixed (train-only sweep: clearance, 4.2/0.6/4m/0.4/replan) | 83% [70–91] | 17% [9–30] | 0% [0–7] | 11/12 |
| Bird-aware heuristic (clearance route + controller ON) | 79% [66–88] | 19% [10–32] | 2% [0–11] | 10/12 |
| Shortest route + controller ON | 48% [34–62] | 35% [23–50] | 17% [9–30] | 6/12 |
| Shortest comparator (controller OFF) | 8% [3–20] | 92% [80–97] | 0% [0–7] | 1/12 |
| *Oracle fixed (picked on held-out: clearance, 4.8/0.9/4m/0.7/replan)* | 100% [93–100] | 0% [0–7] | 0% [0–7] | 12/12 |

Sweep: 3375 configs (9 route selectors × 375 controller settings) on 16 training scenarios. Tuned pick: train 64/64, held-out 40/48. Top-10 training configs on held-out: 40, 40, 28, 27, 31, 36, 36, 39, 42, 31 /48.

Paired per-scenario comparison (Ripple vs baseline; wins/ties/losses on reached-of-4, two-sided sign test):

| Ripple run | vs | Δ success (pp) | W/T/L | sign-test p |
|---|---|---|---|---|
| ripple_rec_original | shortest_ctrl | +20.8 | 4/8/0 | 0.125 |
| ripple_rec_original | heuristic | -10.4 | 0/9/3 | 0.250 |
| ripple_rec_original | tuned | -14.6 | 1/6/5 | 0.219 |
| ripple_rec_original | shortest | +60.4 | 9/2/1 | 0.021 |
| ripple_rec_strategy | shortest_ctrl | +18.7 | 6/2/4 | 0.754 |
| ripple_rec_strategy | heuristic | -12.5 | 2/4/6 | 0.289 |
| ripple_rec_strategy | tuned | -16.7 | 1/6/5 | 0.219 |
| ripple_rec_strategy | shortest | +58.3 | 11/1/0 | 0.001 |
| ripple_930_original | shortest_ctrl | +22.9 | 5/5/2 | 0.453 |
| ripple_930_original | heuristic | -8.3 | 2/7/3 | 1.000 |
| ripple_930_original | tuned | -12.5 | 3/6/3 | 1.000 |
| ripple_930_original | shortest | +62.5 | 8/4/0 | 0.008 |
| ripple_930_strategy | shortest_ctrl | +29.2 | 5/6/1 | 0.219 |
| ripple_930_strategy | heuristic | -2.1 | 1/8/3 | 0.625 |
| ripple_930_strategy | tuned | -6.2 | 2/6/4 | 0.688 |
| ripple_930_strategy | shortest | +68.8 | 10/2/0 | 0.002 |

Recomputed Ripple success matches recorded: true; held-out scenario mismatches vs heldout.json: recording 0, 930b632 0. Ripple decisions re-simulated on the current engine with a different outcome: ripple_rec_original 0/12, ripple_rec_strategy 0/12, ripple_930_original 0/12, ripple_930_strategy 0/12. sim/src state: 0b6df16 + uncommitted edits (M  sim/src/app.js; A  sim/src/factory.js; M  sim/src/render.js).
