# Findings

Generated 2026-11-14T02:31:42.256Z. Grouped by condition key.

**Counts:** 3 file(s), 12 distinct scenarios, 192 decisions, 768 trials (bootstrap: 2000 resamples, seed 20261113).

## Outcomes and beliefs

| condition | files | scen | decisions | trials | success [95% CI] | solved | family acc | behavior acc | danger err | 3s pred err |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| shortest | 3 | 12 | 36 | 144 | 8% [3%–14%] | 8% | - | - | - | - |
| raw | 3 | 12 | 36 | 144 | 78% [67%–87%] | 86% | 50% [33%–67%] | 36% [22%–53%] | 9.1 m [7.4 m–10.9 m] | 7.4 m [6.2 m–8.7 m] |
| think | 2 | 12 | 24 | 96 | 69% [55%–81%] | 83% | 58% [38%–79%] | 42% [25%–63%] | 7.1 m [4.0 m–11.4 m] | 6.4 m [4.8 m–8.0 m] |
| tools | 3 | 12 | 36 | 144 | 60% [47%–72%] | 67% | 53% [36%–69%] | 22% [11%–36%] | 9.6 m [8.1 m–11.2 m] | 6.4 m [5.3 m–7.6 m] |
| structured | 3 | 12 | 36 | 144 | 69% [57%–81%] | 72% | 47% [31%–64%] | 33% [19%–50%] | 7.7 m [6.3 m–9.2 m] | 6.5 m [5.3 m–7.7 m] |
| feedback | 1 | 12 | 12 | 48 | 67% [46%–85%] | 83% | 50% [25%–75%] | 25% [0%–50%] | 7.5 m [5.2 m–9.9 m] | 6.9 m [5.2 m–8.7 m] |
| tools_structured | 1 | 12 | 12 | 48 | 73% [52%–92%] | 83% | 33% [8%–58%] | 25% [0%–50%] | 8.5 m [6.5 m–10.5 m] | 6.4 m [4.1 m–8.8 m] |

Success is reached/trials (CI: cluster bootstrap over decisions). Family/behavior accuracy count invalid decisions as wrong. Errors are means over decisions that stated a value.

## Process

| condition | invalid | median latency | tool calls/dec | hosts | success per file |
| --- | --- | --- | --- | --- | --- |
| shortest | 0 | - | - | - | 8% 8% 8% |
| raw | 0 | 3.2 s | 0.0 | GMICloud, PrimeIntellect | 77% 77% 79% |
| think | 2 | 160.9 s | 0.0 | PrimeIntellect, Together | 67% 71% |
| tools | 0 | 4.3 s | 1.7 | PrimeIntellect | 60% 58% 60% |
| structured | 0 | 3.5 s | 0.0 | GMICloud, PrimeIntellect | 73% 60% 73% |
| feedback | 0 | 2.8 s | 0.0 | PrimeIntellect, GMICloud | 67% |
| tools_structured | 0 | 5.1 s | 2.2 | PrimeIntellect | 73% |

## Paired vs raw

| condition | vs raw | paired scen | Δ success [95% CI] | Δ family acc [95% CI] |
| --- | --- | --- | --- | --- |
| shortest | raw | 12 | -69pp [-89pp, -48pp] * | - |
| think | raw | 12 | -9pp [-24pp, +5pp] | +8pp [-15pp, +33pp] |
| tools | raw | 12 | -18pp [-35pp, -3pp] * | +3pp [-22pp, +28pp] |
| structured | raw | 12 | -9pp [-19pp, +1pp] | -3pp [-19pp, +14pp] |
| feedback | raw | 12 | -11pp [-38pp, +15pp] | +0pp [-28pp, +28pp] |
| tools_structured | raw | 12 | -5pp [-12pp, +3pp] | -17pp [-39pp, +8pp] |

Paired by scenario id (replicates averaged, common seeds only); bootstrap over scenarios. `*` = 95% CI excludes zero.

## What the data says

- raw has the highest trial success rate (78%, CI 67%–87%) — this is the baseline.
- think has the highest behavior-family accuracy (58%, CI 38%–79%); difference vs raw is +8pp (CI -15pp to +33pp, 12 paired scenarios), not distinguishable from zero.
- Paired differences vs raw whose 95% CI excludes zero: shortest success -69pp; tools success -18pp.
- Shortest-path comparator succeeds on 8% of trials (CI 3%–14%).
- Invalid decisions (scored as failed flights and wrong beliefs): think 2/24.
- shortest: per-replicate success ranges 8%–8% over 3 runs.
- raw: per-replicate success ranges 77%–79% over 3 runs.
- think: per-replicate success ranges 67%–71% over 2 runs.
- tools: per-replicate success ranges 58%–60% over 3 runs.
- structured: per-replicate success ranges 60%–73% over 3 runs.
- Only 12 distinct scenarios: CIs are wide, and differences inside them should not be reported as effects.

## Files

- included: `sim/recordings/ripple-harness-AD.json`
- included: `sim/recordings/ripple-demo.json`
- included: `sim/recordings/batch/h12-rep2.json`
