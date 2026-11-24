<h1 align="center">Spatial Arena</h1>
<p align="center">Can a language model fly a drone using only text?</p>
<p align="center">Sujay Potlapelly · Aadi Khanna · Simon Wilton</p>
<p align="center">
  <a href="https://spatialarena.dev/">Write-up</a> ·
  <a href="#video">Video</a> ·
  <a href="docs/README.md">Documentation</a>
</p>

<a name="video"></a>

https://github.com/user-attachments/assets/860b39a8-7497-42ad-b739-49de536575f6

<p align="center"><a href="docs/media/flight-preview.mp4">8-second clip</a> · <a href="https://spatialarena.dev/">Watch the full film</a></p>

Spatial Arena is a simulator for testing how models navigate 3D worlds. You can bring your own model, write a pilot, build a place or design a mission.

Our first task is flying a drone using text. The model reads its position and distances to obstacles, then sends one flight command per second. It flies without a camera or map.

The model improves by reviewing its flights and rewriting its flight code. Its weights stay fixed.

## Setup

Requires **Node 22+**. The demo needs no packages or API key.

```bash
git clone https://github.com/sujaypotlapelly/spatial-arena.git
cd spatial-arena
```

## Quick start

```bash
node sim/tools/bench.mjs --demo
```

Runs a stand-in model and three scripted pilots on four factory routes. Flights are saved to `runs/bench/demo/`. View the full report with:

```bash
node sim/tools/bench_report.mjs runs/bench/demo
```

## Add your model

Any model behind an OpenAI-compatible endpoint can fly the same routes. Add an entry to [sim/bench/models.json](sim/bench/models.json):

```json
{ "id": "my-model", "model": "llama3.3", "baseUrl": "http://localhost:11434/v1" }
```

```bash
node sim/tools/bench.mjs --model my-model --map factory
```

This command checks the endpoint, flies four development routes with the model steering live, and prints a scorecard: flights that reached the goal, wall contacts, replies the model got wrong, replies cut off by its token limit, cost and latency.

To have the model write a flight program and improve it through practice, add `--mode program`.

The [add-your-model guide](docs/ADD_YOUR_MODEL.md) covers API keys, reasoning models, other environments and larger runs. The [running guide](docs/USAGE.md) has scoring and reproduction commands.

## Build on the arena

| What you want to do | Where to start |
| --- | --- |
| Try a flight in your browser | Open the [local playground](arena/README.md), edit a pilot and compare its flight with Ripple’s. |
| Write a pilot | Change the [example controller](examples/goal-seeking.js) and [fly it on two routes](docs/USAGE.md#write-a-pilot). |
| Build a place | Copy the [warehouse layout](sim/scenes/places/warehouse.json), change the walls, then [generate and check the routes](docs/CONTRIBUTING_ENVIRONMENTS.md). |
| Design a mission | Run a [search or delivery mission](docs/ENVIRONMENTS.md#missions), then change the mission settings in a copy of the environment. |
| Watch a recorded flight | Start the [local replay viewer](sim/README.md#watch-a-recorded-flight). It includes the observations, commands and outcomes of recorded flights. |
| Share what you built | Submit the map and its report, or [share a run](results/README.md) so someone else can replay it. |

## Results

Our first tests use [Ripple-65B](https://www.ricursive.com/ripple), a model trained only on text. Each pilot flew 48 new factory routes in two wind conditions: 96 flights per pilot.

| Pilot | Reached the goal |
| :--- | ---: |
| Planner with the full map | 100% |
| Ripple's flight code after practice | **65%** |
| Tuned hand-written pilot | 55% |
| Ripple steering live, best of 13 prompts | 44% |
| Ripple steering live, plain prompt | 33% |
| Straight toward the goal | 11% |

Practice improves on live steering by 21 percentage points [95% CI: +6, +35]. The comparison with the tuned hand-written pilot is inconclusive [+9 points; −4, +22]. These results use harness v0; current evaluations use v1.

We've tested one model so far. New environments need more practice: the factory code reaches 0% in the canyon and cottages; after practice in each place, Ripple's code reaches 69% and 76%.

[Factory results and confidence intervals](docs/RESULTS_V3.md) · [Outdoor results](docs/RESULTS_V4.md) · [Evaluation rules](docs/BENCHMARK.md)

## Repository

| Path | Contents |
| :--- | :--- |
| [arena/](arena/README.md) | Browser playground for flying, editing and comparing controllers |
| [sim/](sim/README.md) | Simulator, models, environments and evaluation tools |
| [examples/](examples/) | A flight controller you can edit and run without an API key |
| [results/](results/README.md) | Shared results and instructions for submitting a run |
| [docs/](docs/README.md) | Results, pre-registrations, benchmark rules and the running guide |
| [scripts/](scripts/) · [tests/](tests/) | Setup, downloads and server checks |

## Checks

```bash
node --test 'sim/test/*.test.mjs' arena/test/determinism.test.mjs
python3 -m unittest discover -s tests
```

To share a run, follow the [result submission guide](results/README.md).

## Citation

```bibtex
@software{spatialarena2026,
  title = {Spatial Arena: can a language model fly a drone?},
  author = {Potlapelly, Sujay and Khanna, Aadi and Wilton, Simon},
  year = {2026},
  url = {https://spatialarena.dev/}
}
```

Also available in [CITATION.cff](CITATION.cff).

## Acknowledgments

Thanks to [Ricursive Intelligence](https://www.ricursive.com/) for organizing and hosting the hackathon where this project began, and to [Shayan Talaei](https://shayantalaei.com/) for feedback throughout the iterations.

## Credits and license

Factory scan by Christoph Schindelar; collision mesh from [Iakov Sumygin's PlayCanvas project](https://playcanvas.com/project/1480299). DJI FPV model by Vitalii Sushko and White Eagle model by GremorySaiyan, both [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Code: [MIT](LICENSE). Asset licenses: [NOTICE.md](NOTICE.md).
