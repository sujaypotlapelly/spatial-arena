# Flight controls

The factory comparison uses C3. Every simulated second the pilot reads its position, goal direction and distances to nearby obstacles, then chooses a velocity. The same physics engine executes each pilot's commands.

| Level | What the pilot chooses |
| --- | --- |
| C1 | A waypoint on the supplied graph. The simulator plans the path to it. |
| C2 | A point to fly toward. |
| C3 | A velocity in world coordinates. |
| C4 | A turn, forward speed and climb in the drone's own frame. |

See the [benchmark rules](BENCHMARK.md) for the scoring procedure and [pilot details](DETAILS.md) for the observations, memory and map access used in each comparison.
