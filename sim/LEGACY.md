# Earlier flight experiments

The rest of this page describes versions 1 and 2, kept because the adversary experiment in the write-up uses them.

A drone-versus-bird simulation used to evaluate 3D spatial planning. Ripple-65B plays two roles: the **attacker** designs a bird scenario, and the **defender** picks the drone's route and flight settings. A deterministic simulator flies both and decides what happened. Model text is never treated as an outcome.

## Run it

```bash
python3 sim/server.py 8765
```

Open http://localhost:8765. The key can also go in `.env` at the repo root (ignored by Git). It stays in the local server; the browser only calls `/api/*`. The default model is `ricursiveai/ripple-65b-preview`. Set `RIPPLE_MODEL` to change it.

Without a key, the page runs on rule-based stand-ins. Every decision they produce is labelled "heuristic". Those are not Ripple results.

Click **Generate attack** to use Ripple for both the bird scenario and the drone's decision. **Run baseline** uses a fixed shortest-path comparator and makes no model calls. The connection status confirms success after a model reply; a configured key alone doesn't verify live access.

The output limit defaults to 32,768 tokens, including reasoning (the server caps any request at that). By default the harnesses use Ripple's hosts with thinking off, which answer in about 3 s. The thinking harness turns reasoning on: Ripple then uses 6,000 to 16,000+ thinking tokens per spatial decision (1–2 minutes), and its hosts ignore OpenRouter's reasoning-budget and effort settings, so the limit is the only control. If responses are cut off, set `RIPPLE_MAX_TOKENS` and restart the server. The browser receives only final decision text for parsing; model reasoning is displayed separately in the decision details.

To load a Gaussian splat (`.spz`, `.ply`, `.splat`), set `splat.url` and its transform in `maps/building.json`, or open `?splat=<url>`. Then switch on **Colliders** and **Waypoints** and adjust the transform until the magenta boxes line up with the walls. The splat is only visual. Collisions use the boxes in the map file.

## Factory flight preview

With the server running, open [Factory flight](http://localhost:8765/factory.html) or follow **Open factory flight preview** from the arena. **Angled** opens above the building at a slant to show wall faces and flight height. **Top-down** shows the floor plan. **Track flight** keeps both actors in a closer angled shot as they move. The roof slider starts at **2.3 m**. The exposed edge fades into a neutral concrete tone just below the slice. Drag any overhead shot to pan, Shift-drag or right-drag to orbit, and scroll to zoom. On touchscreens, drag with one finger, pinch to zoom, and twist to rotate. Dragging releases **Track flight** at its current position. Select a shot again to restore its framing. **Chase** follows the DJI with the roof visible. **Pause flight** holds both actors and the eagle’s wing animation while you compare views.

The preview streams Christoph Schindelar’s factory scan and the matching collision mesh from [Iakov Sumygin’s PlayCanvas project](https://playcanvas.com/project/1480299). It requires internet access. The renderer uses the project’s −90° X rotation for the scan and the collider translation of (−4.695, 0.438, 11.397) metres. All camera shots clip the scan at the shared wall along the southern corridor. Both the corridor trim and roof cut affect only the rendered splats. The chase camera checks the physical shell before moving behind the drone.

The default preview plays scripted loops in one hall. A clearance check sampled 1,440 positions per loop against the transformed source collider. The minimum distance from each actor’s centre to a triangle was 1.17 m for the drone and 1.24 m for the eagle. For a scored flight, open the [recorded factory replay](http://localhost:8765/factory.html?recording=recordings/ripple-factory.json). It flies the saved Ripple decisions using the factory collision map and waypoint graph. Angled, Top-down and Track flight are available during replay.

Both views use these GLBs from [Objaverse](https://huggingface.co/datasets/allenai/objaverse). The bundled copies retain the original materials and artist credits, with a parent transform added for scale, pivot and forward direction.

- **White Eagle Animation Fast Fly** by GremorySaiyan. Its embedded 0.60-second flight clip loops during playback. [Model](https://sketchfab.com/3d-models/white-eagle-animation-fast-fly-30203bf39e5145f19c79e83c550139d3) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- **DJI FPV** by Vitalii Sushko. The asset is a static mesh, oriented by its flight direction at runtime. [Model](https://sketchfab.com/3d-models/dji-fpv-28321515f60346c0becb244ed094c1f8) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

## The four controls

1. **Run baseline.** The shortest-path comparator flies against the default chasing bird.
2. **Generate attack.** Runs one training episode. Ripple proposes a bird scenario within the allowed limits. The simulator rejects it if no reference route and controller can reach the goal in at least 2 of 4 seeds, and Ripple can try again up to 3 times. Ripple then plans the drone's flight using the simulator's evidence from earlier episodes, and the episode is flown on 4 seeds.
3. **Adapt strategy.** Runs training episodes up to 8, then asks Ripple for a general strategy of 120 words or fewer and freezes it.
4. **Run unseen evaluation.** Runs the 12 held-out scenarios in `scenarios/heldout.json` under three conditions: the shortest-path comparator, Ripple with the original instructions, and Ripple with the frozen strategy. The held-out scenarios use different start and goal pairs, bird starts, and seeds from training. A separate quiz of 12 constant-velocity collision-prediction questions, with answers computed analytically, is asked with and without the strategy.

During evaluation, a failed model call counts as an invalid action (reward −1). It never falls back to the heuristic, so the heuristic can't inflate Ripple's numbers.

**Fly live** runs a decision in real time with a new random seed rather than replaying it. **Save results** writes `runs/arena/<timestamp>/{session.json, episodes.jsonl, metrics.json}` and downloads the session file. **Load recording** loads a saved session and re-simulates every episode from its saved scenario, decision, and seed. It reports whether the recomputed outcomes match the saved ones and labels the view as recorded. Every model call is also appended to `runs/sim/<date>.jsonl`.

This is inference-time adaptation (feedback in context, then a frozen written strategy). It does not change model weights. Twelve scenarios × 4 seeds is enough for a demonstration but not for a statistically strong claim.

## Layout

```text
sim/
  server.py              static server + OpenRouter proxy + result saving (stdlib only)
  index.html, styles.css
  maps/building.json     collision boxes, waypoint graph, physics, splat transform
  scenarios/heldout.json 12 held-out scenarios (tools/legacy/make_heldout.mjs regenerates them)
  src/world.js           geometry, swept-sphere checks, A*, route menus
  src/engine.js          fixed-step simulation (60 Hz), outcomes, rewards
  src/policy.js          defender/attacker schemas and validation
  src/scenarios.js       solvability check, episode runner
  src/agents.js          prompts, model client, quiz, rule-based stand-ins
  src/arena.js           baseline / training / strategy / evaluation orchestration
  src/render.js          three.js + Spark view, trails, cameras
  src/app.js             UI
  tools/legacy/headless_demo.mjs  whole pipeline without a browser
  test/sim.test.mjs
```

```bash
node --test sim/test/sim.test.mjs
```

```bash
node sim/tools/legacy/headless_demo.mjs
```

With the server running and a key set, `SIM_URL=http://localhost:8765 node sim/tools/legacy/headless_demo.mjs` runs the same pipeline against Ripple.

## Simulator

- The drone follows its chosen waypoint route. It skips ahead to waypoints already in line of sight and brakes for corners according to `corner_slowdown`.
- Wind gusts are seeded, so each seed is reproducible.
- When the bird comes within `avoidance_distance`, the drone dodges, but only if the dodge itself is clear of walls. If `replan_when_bird_nearby` is on, it also re-routes with A*, with waypoints near the bird penalised.
- Touching any collision box is a crash.
- The bird pursues, intercepts (aiming `lead_time` ahead), or waits in ambush until it sees the drone within `trigger_distance`. It goes around walls using the waypoint graph and tires after 9 s of chasing.
- The bird catches the drone within 0.9 m.
- Reward is +1 for reaching the goal, −1 for being caught, crashing, or an invalid action, and 0 for a timeout.

The defender's route choice is made once per episode. The spec's optional single mid-episode replanning call to the model is not implemented; mid-flight replanning is algorithmic.

## Results (real Ripple-65B, recorded 2026-11-13)

Open the demo with the final recording: `http://localhost:8765/?recording=recordings/ripple-demo-36.json`, then **▶ Demo**. Every recording re-simulates exactly on load (329 episodes, 0 mismatches for this one).

**36 unseen scenarios × 4 seeds** (`findings-36.md`; 360 decisions, 1,440 flights; 95% cluster-bootstrap CIs; paired by scenario vs. harness A):

| Harness | Success | vs. A (paired) | Bird-behavior family | Bird position in 3 s, error | Median time |
|---|---|---|---|---|---|
| Shortest path (no model) | 5% | −51 pp * | — | — | — |
| A · Raw coordinates | 56% | — | 53% | 7.6 m | 3.0 s |
| B · Thinking (32k budget) | 65% | +9 pp | 31% | 5.3 m | 147 s |
| C · Geometry tools | 56% | 0 pp | 61% | 5.4 m | 4.5 s |
| D · Structured steps | 59% | +3 pp | 44% | 5.9 m | 3.4 s |
| E · A + learned strategy | 61% | +5 pp | 44% | 6.7 m | 2.8 s |
| F · Tools + structured | 58% | +2 pp | 33% | 5.5 m | 4.5 s |
| G · Tools + learned strategy | 56% | −1 pp | 47% | 4.9 m | 4.1 s |
| H · Structured + learned strategy | **69%** | **+13 pp [+1, +24] \*** | 33% | 6.3 m | 3.3 s |

\* 95% CI excludes zero. With eight harness comparisons, H's lower bound of +1 pp is borderline: treat it as the leading candidate, not a settled result.

What the data supports:
- Ripple plans far better than a shortest-path planner (56–69% vs. 5%) in every harness.
- Geometry tools make Ripple's spatial predictions more accurate: bird position 3 s ahead is off by 5.4 m (CI 4.5–6.4) vs. 7.6 m (6.3–8.9) without them. Better prediction did not translate into more successful flights.
- Thinking is not worth it here: +9 pp success (not significant), worse behavior identification, ~50× slower.
- Written strategies learned from verified feedback are unreliable: across four training runs on the 12-scenario set they changed success by −2, −23, +21 and −25 pp depending on the harness, and the strategy text tended to hurt behavior identification and a separate geometry quiz (12/12 → 6/12). The one gain that clears noise is when the strategy is combined with structured steps (H).
- Run-to-run noise is small: harness A scored 77%, 77% and 79% in three independent runs on the 12-scenario set (`findings-12.md`).

### In the real factory scan

`node sim/tools/maps/build_factory_map.mjs <Factory_collider.glb>` turns the scan's collision mesh into `maps/factory.json`: a 0.25 m voxel grid in factory.html's coordinates and a 54-waypoint flight graph through the hall's free space. The same simulator, prompts and scoring then run inside the scan.

- Replay in the scan: `http://localhost:8765/factory.html?recording=recordings/ripple-factory.json`
- Dashboard: `http://localhost:8765/?recording=recordings/ripple-factory.json`

First real-Ripple run (`ripple-factory.json`, structured harness, 4 training episodes, 12 unseen factory scenarios × 4 seeds; 42 episodes re-simulate with 0 mismatches):

| | Success | Scenarios solved | Behavior family | 3 s position error |
|---|---|---|---|---|
| Shortest path | 13% | 2/12 | — | — |
| Ripple, no strategy | 27% | 5/12 | 25% | 7.7 m |
| Ripple + learned strategy | 27% | 4/12 | 17% | 4.8 m |

The factory is much harder than the grey building (cluttered hall, ~15 s routes, bird mid-hall). Ripple doubles the shortest-path success rate, but the learned strategy made no measurable difference here (paired Δ 0 pp, CI −15 to +15 over 12 scenarios). The sample is small.
