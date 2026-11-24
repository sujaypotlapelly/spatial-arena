# Contribute an environment

For a room or building, start with the [example warehouse](../sim/scenes/places/warehouse.json). For a first run, copy it to `workshop.json` in the repository root and change its `id` to `warehouse-workshop`. Leave the walls in place for this run. Then register and check the new place.

```sh
node sim/tools/maps/add_place.mjs workshop.json
node sim/tools/env/admit.mjs warehouse-workshop
node sim/tools/env/sync_registries.mjs --check
```

The first command builds the collision map and pins the routes. It checks that a map-aware planner reaches most goals and that a pilot flying straight ahead usually needs a detour. With the example layout and ID, the planner reaches all 24 development goals, flying straight reaches 9, and all 72 flights replay exactly. For your own layout, choose a fresh ID, change the walls and dimensions in metres, and write the description the pilot will see. Use `--dry-run` on the first command to try a layout before registering it.

The second command writes a report under `sim/environments/reports/`. Include the description, manifest, generated map, route set, registry changes and report in your pull request.

## Starting from a scan

The scan importer uses SuperSplat scenes with a published collider, downloads enabled and CC BY selected by the owner. Keep the source link, creator credit, license and any scale or geometry changes in the scene manifest. Install the optional tools for measuring scan density and rendering stills.

```sh
npm ci --prefix sim/tools/env
(cd sim/tools/env && npx playwright install chromium)
```

Pass the eight-character ID from the scene URL, a new local ID, words from the scene title and the description shown to pilots.

```sh
node sim/tools/env/add_scene.mjs --hash SCENE_ID --id my-place --search "scene title" --describe "A courtyard with two connected halls."
node sim/tools/env/render_stills.mjs my-place
```

Check the rendered scene and its report. The report shows the review decision (stage 0), checks on geometry and scan coverage (stage 1), and checks on route sets, baseline performance and exact replays (stage 2). It records scale and license information separately. A scorecard shows the stage reached when the model flew. Later demonstrations and published comparisons need their own flight evidence.
