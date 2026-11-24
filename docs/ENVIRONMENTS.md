# Environments and missions

A place defines the world the pilot moves through. A task defines the goal, what the pilot observes and what counts as success. To see how those fit together, compare the [warehouse layout](../sim/scenes/places/warehouse.json), the [warehouse environment](../sim/environments/warehouse.json) and its [generated routes](../sim/scenarios/reach-warehouse.json).

For a new place, follow the [environment guide](CONTRIBUTING_ENVIRONMENTS.md). To change how a pilot flies within an existing place, start with the [example controller](../examples/goal-seeking.js).

## Missions

In search, the pilot flies until it detects a target. In delivery, it carries a parcel to a pad. These commands run one development mission each with a scripted pilot. Both save the flight under `runs/` and check that the recorded commands reproduce it.

```sh
node sim/tools/mission_eval.mjs --map canyon --task search --set dev --limit 1 --seeds 1 --conditions explorer --out runs/my-search
node sim/tools/mission_eval.mjs --map residential --task delivery --set dev --limit 1 --seeds 1 --conditions padseeker --out runs/my-delivery
```

The [canyon manifest](../sim/environments/canyon.json) holds its search settings under `harness.missions`. For a new search mission on the same terrain, copy that manifest to `sim/environments/canyon-workshop.json`. Set its `id` to `canyon-workshop`, give it an unused `registryOrder` and replace its `admission` block with `{"stage":null,"checkedAt":null,"commit":null,"gates":{},"signoffs":{}}` so the copy starts without the original’s review. Under `harness.missions.search`, try a 75-second time limit, 3 training missions, 4 development missions, 4 test missions and a seed of 1234. Keep the remaining search settings.

```sh
node sim/tools/env/sync_registries.mjs
node sim/tools/maps/make_mission_sets.mjs --map canyon-workshop --task search
node sim/tools/mission_eval.mjs --map canyon-workshop --task search --set dev --limit 1 --seeds 1 --conditions explorer --out runs/workshop-search
```

The generator names the file `sim/scenarios/mission-canyon-workshop-search.json`. Running it again checks that the same settings reproduce the saved missions.

To change the task itself, start with [the mission rules](../sim/src/gym/rescue_tasks.js) and [the episode loop](../sim/src/gym/core.js). The [mission results](RESULTS_MISSIONS_V2.md) explain the later search and delivery variants, including what the pilot sees in each.
