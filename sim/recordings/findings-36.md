# Findings

Generated 2026-11-14T02:30:13.353Z. Grouped by condition key.

**Counts:** 2 file(s), 36 distinct scenarios, 360 decisions, 1440 trials (bootstrap: 2000 resamples, seed 20261113).

## Outcomes and beliefs

| condition | files | scen | decisions | trials | success [95% CI] | solved | family acc | behavior acc | danger err | 3s pred err |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| shortest | 2 | 36 | 72 | 288 | 5% [2%–8%] | 6% | - | - | - | - |
| raw | 1 | 36 | 36 | 144 | 56% [43%–69%] | 67% | 53% [36%–69%] | 42% [25%–56%] | 9.0 m [7.3 m–10.8 m] | 7.6 m [6.3 m–8.9 m] |
| tools | 1 | 36 | 36 | 144 | 56% [43%–69%] | 58% | 61% [47%–78%] | 42% [25%–58%] | 8.5 m [7.3 m–9.7 m] | 5.4 m [4.5 m–6.4 m] |
| structured | 1 | 36 | 36 | 144 | 59% [46%–72%] | 64% | 44% [28%–61%] | 39% [22%–56%] | 9.5 m [7.6 m–11.5 m] | 5.9 m [4.9 m–6.8 m] |
| feedback | 1 | 36 | 36 | 144 | 61% [49%–72%] | 78% | 44% [30%–61%] | 28% [14%–42%] | 8.7 m [7.1 m–10.5 m] | 6.7 m [5.7 m–7.8 m] |
| tools_structured | 1 | 36 | 36 | 144 | 58% [45%–72%] | 67% | 33% [19%–50%] | 33% [19%–50%] | 8.2 m [7.1 m–9.5 m] | 5.5 m [4.4 m–6.7 m] |
| tools_feedback | 1 | 36 | 36 | 144 | 56% [42%–69%] | 67% | 47% [33%–64%] | 39% [25%–56%] | 9.6 m [8.0 m–11.2 m] | 4.9 m [3.9 m–6.0 m] |
| structured_feedback | 1 | 36 | 36 | 144 | 69% [56%–80%] | 81% | 33% [17%–50%] | 25% [11%–39%] | 9.5 m [8.0 m–11.2 m] | 6.3 m [5.3 m–7.2 m] |
| think | 1 | 36 | 36 | 144 | 65% [52%–78%] | 69% | 31% [17%–47%] | 25% [11%–39%] | 8.8 m [5.0 m–12.8 m] | 5.3 m [4.2 m–6.4 m] |

Success is reached/trials (CI: cluster bootstrap over decisions). Family/behavior accuracy count invalid decisions as wrong. Errors are means over decisions that stated a value.

## Process

| condition | invalid | median latency | tool calls/dec | hosts | success per file |
| --- | --- | --- | --- | --- | --- |
| shortest | 0 | - | - | - | 5% 5% |
| raw | 0 | 3.0 s | 0.0 | GMICloud, PrimeIntellect | 56% |
| tools | 0 | 4.5 s | 1.4 | PrimeIntellect | 56% |
| structured | 0 | 3.4 s | 0.0 | GMICloud, PrimeIntellect | 59% |
| feedback | 0 | 2.8 s | 0.0 | PrimeIntellect, GMICloud | 61% |
| tools_structured | 0 | 4.5 s | 1.3 | PrimeIntellect | 58% |
| tools_feedback | 2 | 4.1 s | 1.6 | PrimeIntellect | 56% |
| structured_feedback | 0 | 3.3 s | 0.0 | GMICloud, PrimeIntellect | 69% |
| think | 3 | 146.7 s | 0.0 | Together, PrimeIntellect | 65% |

## Paired vs raw

| condition | vs raw | paired scen | Δ success [95% CI] | Δ family acc [95% CI] |
| --- | --- | --- | --- | --- |
| shortest | raw | 36 | -51pp [-66pp, -37pp] * | - |
| tools | raw | 36 | 0pp [-13pp, +13pp] | +8pp [-14pp, +33pp] |
| structured | raw | 36 | +3pp [-8pp, +14pp] | -8pp [-31pp, +14pp] |
| feedback | raw | 36 | +5pp [-7pp, +17pp] | -8pp [-28pp, +14pp] |
| tools_structured | raw | 36 | +2pp [-11pp, +16pp] | -19pp [-42pp, +3pp] |
| tools_feedback | raw | 36 | -1pp [-16pp, +14pp] | -6pp [-25pp, +14pp] |
| structured_feedback | raw | 36 | +13pp [+1pp, +24pp] * | -19pp [-39pp, 0pp] |
| think | raw | 36 | +9pp [-8pp, +26pp] | -22pp [-44pp, 0pp] |

Paired by scenario id (replicates averaged, common seeds only); bootstrap over scenarios. `*` = 95% CI excludes zero.

## What the data says

- structured_feedback has the highest trial success rate (69%, CI 56%–80%); difference vs raw is +13pp (CI +1pp to +24pp, 36 paired scenarios), distinguishable from zero.
- tools has the highest behavior-family accuracy (61%, CI 47%–78%); difference vs raw is +8pp (CI -14pp to +33pp, 36 paired scenarios), not distinguishable from zero.
- Paired differences vs raw whose 95% CI excludes zero: shortest success -51pp; structured_feedback success +13pp.
- Shortest-path comparator succeeds on 5% of trials (CI 2%–8%).
- Invalid decisions (scored as failed flights and wrong beliefs): tools_feedback 2/36, think 3/36.
- shortest: per-replicate success ranges 5%–5% over 2 runs.

## Files

- included: `sim/recordings/batch/h36-fast.json`
- included: `sim/recordings/batch/h36-think.json`
