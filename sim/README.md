# sim/

The simulator, the tasks and the tools. Start from the [main README](../README.md).

```text
src/gym/            the tasks: reach.js (fly A to B), mission tasks (search, delivery), the drone and episode loop (core.js),
                    the live-steering prompt and scripted pilots (reach_agents.js), the sandbox for model-written programs
src/world.js        collision grid, line of sight, routes
src/engine.js       seeded random numbers and the fixed-step simulation
src/                everything else here is the earlier drone-versus-bird arena and the browser viewers
maps/               collision maps, one per place
scenes/             benchmark-sets.json: the places and how their route sets are built; places/ holds place descriptions
scenarios/          the pinned route and mission sets
bench/models.json   the model list
test/               node --test 'sim/test/*.test.mjs'
tools/              run things (see below)
```

## Tools

```text
tools/bench.mjs, bench_report.mjs      fly a list of models on the same routes and print the table
tools/reach_eval.mjs                   fly one pilot (live steering, a program, or a scripted pilot)
tools/reach_cap.mjs                    the practice loop: the model writes a program and revises it
tools/mission_eval.mjs, mission_cap.mjs   the same two for search and delivery
tools/reach_verify.mjs                 re-fly recorded flights and check they match exactly
tools/maps/                            add a place (add_place.mjs), build a map from a scan, build mission sets
tools/study/                           the scripts behind the published results (selection, test passes, reports, audits)
tools/legacy/                          the earlier drone-versus-bird arena (versions 1 and 2)
```

`ripple_client.mjs`, `cli_chat.mjs`, `benchmark_env.mjs` and `reach_metrics.mjs` are shared code the tools import.

## Watch a recorded flight

```sh
python3 sim/server.py 8765
```

Open the [recorded factory flight](http://127.0.0.1:8765/factory.html?recording=recordings/ripple-factory.json) to follow the drone. The photographic scan streams from PlayCanvas. Open the [same recording in the local dashboard](http://127.0.0.1:8765/?recording=recordings/ripple-factory.json) to inspect the model’s decisions, the scripted pilots and their outcomes. Both views use the saved flight and need no API key.

The [earlier flight experiments](LEGACY.md) describe the bird and drone roles, the scripted comparison and the original viewer. For the current simulator, start with the [control levels](../docs/CONTROL_LADDER.md), [environments and missions](../docs/ENVIRONMENTS.md), or the [example controller](../examples/goal-seeking.js).
