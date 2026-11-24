# Fly a controller in the browser

Pick a factory route, write a flight program and watch the drone fly. Drag the timeline to see what the pilot knew and which command it sent each second. You can replay two pilots on the same route and wind to see where their decisions differ.

From the repository root, build the playground, start a local server and open [the playground](http://127.0.0.1:8852/arena/).

```sh
node arena/tools/build_static.mjs
python3 -m http.server 8852 --bind 127.0.0.1 --directory arena/dist
```

The first flight uses Ripple’s saved program. Under **Fly it yourself**, select your own program, edit `policy(obs, memory)` and press **Fly**. Flights and scores are saved in this browser. Export a flight to share its commands with someone else. Importing it runs those commands again and computes the score. To connect a model that makes live decisions, see [Add your model](../docs/ADD_YOUR_MODEL.md).

## Build on it

- [runner.js](runner.js) runs and replays flights using the same [episode loop](../sim/src/gym/core.js) as the command-line simulator. The playground includes 12 practice routes and 24 development routes, each with two wind seeds.
- [controllers.js](controllers.js) connects the built-in pilots and the editor to the simulator. [policy_worker.js](policy_worker.js) runs visitor-written programs in a dedicated worker. Each call has 200 ms. After a timeout the worker restarts and its memory resets. The Node runner allows 50 ms per call.
- [view.js](view.js) draws the map, the flight path and the ghost of a second flight.
- [programs/manifest.json](programs/manifest.json) records where Ripple’s saved program came from and its checksum.

## Check a change

```sh
node --test arena/test/determinism.test.mjs
node arena/tools/build_static.mjs
```

The tests compare the browser runner with the simulator on 22 recorded flights, including observations, commands or trajectories as appropriate for each fixture. The page also runs the reference flights through its worker and shows whether this browser reproduces them. The static build writes a self-contained copy to `arena/dist/`. Serve that folder to try the build.
