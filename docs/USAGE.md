# Running Spatial Arena

[Back to the main README](../README.md)

Requires Node 22+. Run commands from the repository root.

## Add your model

Add one entry to [sim/bench/models.json](../sim/bench/models.json). No code changes.

```json
{ "id": "my-model", "model": "vendor/model-name", "provider": "HostName", "quantizations": ["bf16"], "maxTokens": 400 }
```

For a model on [OpenRouter](https://openrouter.ai), put a key in `.env` (`python3 scripts/ripple_api.py setup`) and pick a host with `node sim/tools/bench.mjs --endpoints vendor/model-name`. For a local server or any OpenAI-compatible endpoint, give its address instead of a host:

```json
{ "id": "my-local", "model": "llama3.3", "baseUrl": "http://localhost:11434/v1" }
```

Then fly it:

```bash
node sim/tools/bench.mjs --models my-model --baselines --set dev --seeds 2 --samples 1 --levels C3 --out runs/bench/my-model   # steering live
node sim/tools/bench_report.mjs runs/bench/my-model
node sim/tools/reach_cap.mjs --model my-model --runs 3 --iters 8 --out runs/reach/cap-my-model                                # the practice loop
```

`C3` is one velocity command per second, the level used in the write-up. Add `--features memory` to give the model its own notes and a trail of where it has been. Add `--map canyon` (or `building`, `residential`, `warehouse`) to fly somewhere else.

## Write a pilot

The [example controller](../examples/goal-seeking.js) flies straight toward its goal. Copy it, change its decisions and run it locally.

```sh
node sim/tools/reach_eval.mjs --map warehouse --set dev --limit 2 --seeds 1 --conditions program@C3 --program examples/goal-seeking.js --out runs/my-pilot
```

The simulator calls `policy(obs, memory)` once per simulated second. At C3, `obs.position` and `obs.goal.position` are world coordinates, and `obs.free_space_m` contains the obstacle distances. Return a three-component `velocity` in metres per second. Use `memory` for state you want to carry between calls. Inspect `runs/my-pilot/episodes.jsonl` to see each command, its outcome and the replay check.

## Add your own place

Describe a place as a size and a list of walls, like [sim/scenes/places/warehouse.json](../sim/scenes/places/warehouse.json), then:

```bash
node sim/tools/maps/add_place.mjs my-place.json
node sim/tools/bench.mjs --map my-place --baselines --set dev --out runs/bench/my-place
```

The tool creates routes with the start and goal 15–35 m apart, out of sight of each other and requiring a detour. It runs the scripted pilots and checks that the routes meet the benchmark rules before adding the environment. For a 3D scan, follow the [environment contribution guide](CONTRIBUTING_ENVIRONMENTS.md).

## How scoring works

- A flight reaches the goal if the drone gets within 1 m in 90 s. A 60 Hz physics simulator flies each command for one second, with wind gusts. The clock pauses while the model thinks.
- The model gets position and distance readings, plus memory when enabled. It chooses its own route and avoids obstacles itself.
- A reply that can't be used gets one retry, then counts as invalid and the previous command stands. A network failure is never scored against the model.
- We replay every flight from its recorded commands and check that the result matches exactly.
- The practice loop: the model writes a JavaScript function `policy(obs, memory)`, flies it on 12 practice routes, reads what went wrong, and revises it, up to 8 versions per run. Programs run in an isolated sandbox with a 50 ms limit per call.

[What each pilot is given, and earlier versions](DETAILS.md) · [How models are compared](BENCHMARK.md)

## Share a result

Open a pull request with a folder under [results/](../results/README.md) containing your run's `config.json`, `leaderboard.json` and flights. Anyone can verify the result by replaying the flights. Results are marked "self-reported" until someone else checks them.

## Fair comparison

- **Versions.** The results above use harness v0. New runs use v1, with stricter rules for malformed replies and network failures ([what changed](HARNESS_CHANGELOG.md)). Reports keep results from different versions, environments and prompts separate.
- **Route sets.** Each environment has fixed practice, development and test routes in `sim/scenarios/`. Tune on practice and development routes. The factory test routes are public and have already been used, so factory test scores aren't a fresh evaluation on unseen routes.
- **Sampling.** Every model runs at temperature 0.7 on one pinned host.

## Reproduce the published results

The reproduction commands use Python 3, curl and two checksum-verified run archives. Start with the factory and building recordings (v3). The downloader keeps existing runs and checks any overlapping files for an exact match. The verifier re-flies 5,276 flights. The report uses the 5,120 test flights.

```sh
scripts/fetch_runs.sh
node sim/tools/reach_verify.mjs runs/reach/v3*
node sim/tools/study/reach_v3_report.mjs
```

For the outdoor and mission comparisons (v4), keep the v3 data and add the second download. The factory comparison uses the original v3 flights. The v4 report reads the recorded outcomes and replay checks and regenerates [the published tables](RESULTS_V4.md).

```sh
scripts/fetch_runs.sh --v4
node sim/tools/study/v4_report.mjs
```

To fly one of Ripple's programs, pass `--program path/to/best.js --conditions program@C3 --random legacy` to the evaluator.

## Limits

- We've tested one model in four environments built from scans or by hand. For each environment, we selected the best of 24 flight programs. An example warehouse is also included.
- These are simulated flights. The model receives numbers, not images, and hasn't flown a real drone.
- The model runs through OpenRouter on one pinned host (PrimeIntellect, bf16) at temperature 0.7 with thinking off. Live-steering results are one sample per flight.
- The program's 50 ms per-call limit is wall-clock time, so a much slower machine could time out where ours didn't.
