# Reach as a benchmark: text-only spatial control across open models

This turns the Reach task into a fixed benchmark that any chat model can be run on, so the Ripple numbers come with a yardstick.

## What it measures

One task, four control levels. Fly a drone from A to B through the factory scan from text senses only. Start and goal are 15–35 m apart, with no straight line of sight, and the route needs a detour of at least 15%. The episode is reached within 1 m, with a 90 s limit. The model decides once per simulated second, and sim time pauses while it thinks.

| Level | The model outputs | Who plans the path |
|---|---|---|
| C1 | the next waypoint (it sees the waypoint graph) | our A* |
| C2 | a free-space target point `[x, y, z]` | the model |
| C3 | a velocity `[vx, vy, vz]` | the model |
| C4 | body-frame turn / forward / climb, no coordinates | the model |

At C2–C4 nothing in the loop knows how to get from A to B except the model. The gap between C1 and C2–C4 is the headline. It separates picking from a menu from doing the spatial work.

## What is frozen

- **Harness v0:** the plain prompt in `sim/src/gym/reach_agents.js` with no features. Fourteen alternatives were tried on Ripple and none beat it ([HARNESS_CHANGELOG.md](HARNESS_CHANGELOG.md)).
- **Task:** `reach.js`, `core.js`, `world.js`, `engine.js`, the factory map and `sim/scenarios/reach-factory.json`. A hash of these files (`harnessHash` in `sim/tools/reach_metrics.mjs`) is written into every episode. The report refuses to mix episodes recorded under different hashes.
- **Sampling:** temperature 0.7 for every model, 400 output tokens per decision, and one format-repair retry. After that the previous command stands and the decision counts as invalid.
- **Thinking:** off wherever a model allows it, matching how Ripple runs. Models that think anyway show up as truncated replies.
- **Hosts:** one pinned host per model with a fixed precision and no fallbacks (`sim/bench/models.json`). The host is logged on every call.

## Metrics

| Metric | Definition | Why |
|---|---|---|
| **Reached** (primary) | Share of episodes that reach the goal, averaged over samples | The task |
| pass^k | Share of scenario + seed cells where all k samples reach | Reliability, as in τ-bench |
| **Low-touch reached** (secondary) | Reached while touching geometry ≤ 15% of the flight | Contact only slows the drone, and per-second Ripple slides along walls 51% of the time. The senses-only avoider sits at 6–9%. |
| Progress, touching, invalid and truncated replies | Diagnostics | — |
| Calls, tokens, estimated cost, hosts seen | Cost and provenance | ABC checklist |

CIs are 95% cluster bootstraps over scenarios, and paired differences match on scenario and seed. Anchors are run once per set: the map + A* planner (C1, upper bound), the straight-line flyer (C2) and the senses-only reactive avoider (C3).

## Protocol

1. **Dev pass** (this is what the runner defaults to): 24 dev scenarios × 2 wind seeds × **K = 5 samples** × 4 levels = 960 episodes per model. With K = 5 the minimum detectable difference drops well below the ~20–28 pp of the current single-sample design.
2. **Pre-register** before any held-out look: the model list, metrics, the low-touch threshold, the comparison family (each model vs Ripple, per level) and Holm correction. See [PREREGISTRATION_V3.md](PREREGISTRATION_V3.md) for an example.
3. **Held-out:** 24 held-out scenarios, same settings, one look per model. The runner refuses `--set heldout` without `--confirm-heldout`.

## Models

`sim/bench/models.json` lists these, each pinned to one host. Only Ripple has been flown so far.

| Id | Model | Pin | Why it's in |
|---|---|---|---|
| ripple-65b | `ricursiveai/ripple-65b-preview` | PrimeIntellect bf16 | Subject |
| qwen3.6-27b | `qwen/qwen3.6-27b` | DeepInfra fp8 | Dense ~27B, same generation |
| qwen3.6-35b-a3b | `qwen/qwen3.6-35b-a3b` | PrimeIntellect fp8 | Small MoE (3B active) |
| gemma-4-31b | `google/gemma-4-31b-it` | Crusoe bf16 | Dense ~31B, different family |
| nemotron-3-super | `nvidia/nemotron-3-super-120b-a12b` | DeepInfra bf16 | Larger MoE (12B active) |
| deepseek-v4-flash | `deepseek/deepseek-v4-flash` | GMICloud fp8 | Frontier-scale open MoE |

To pick or change a pin, list each host's precision and price:

```bash
node sim/tools/bench.mjs --endpoints qwen/qwen3.6-27b
```

Precision differs across the list: Ripple, Gemma and Nemotron are bf16; the Qwen and DeepSeek hosts serve only fp8 or lower. The report shows each model's pin; say which you used when you share a result.

## Running it

```bash
# Dry run: fake model, no key, no network
node sim/tools/bench.mjs --fake --models fake --baselines --set dev --limit 4 --samples 2 --out runs/bench/smoke

# Pilot: 2 scenarios, 1 seed, 2 samples (checks the host pin and output format)
node sim/tools/bench.mjs --models qwen3.6-27b --set dev --limit 2 --seeds 1 --samples 2 --out runs/bench/pilot

# Full dev pass and anchors; resumable, so re-run the same command after an interruption
node sim/tools/bench.mjs --baselines --models ripple-65b,qwen3.6-27b,qwen3.6-35b-a3b,gemma-4-31b,nemotron-3-super,deepseek-v4-flash \
  --set dev --seeds 2 --samples 5 --out runs/bench/dev-v1

# Leaderboard (re-flies every episode; writes LEADERBOARD.md and leaderboard.json)
node sim/tools/bench_report.mjs runs/bench/dev-v1 --ref ripple-65b
```

Account, auth and request errors (HTTP 400/401/402/403) abort the run, so they are never scored as model behavior. Transport retries are logged to `retries.jsonl`.
