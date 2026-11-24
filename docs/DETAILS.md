# Details behind the results

Read the [main README](../README.md) first.

## What each pilot is given

The two Ripple modes see the same observation, but they don't get the same help. To compare them fairly, keep these differences in mind:

| | Ripple steering live | Ripple's program | Hand-written pilot |
|---|---|---|---|
| Observation each second | same JSON | same JSON | same JSON |
| Memory | its last 3 commands; the tuned prompt adds a 10 s position trail | any state it keeps in `memory` | the direction it chose last second |
| Extra senses in the tuned prompt | goal as a relative vector, and a 15 × 15 m top-down map of walls at its height (`ascii`) | none | none |
| Physics facts in the prompt | speed limit | speed limit, 7 m/s² acceleration, "a straight line to the goal is always blocked" | n/a |
| Practice | best of 13 prompt variants on practice routes | 8 rounds of simulator feedback on practice routes, best of 24 runs | best of 193 parameter sets on practice routes |

The `ascii` map is drawn from the collision grid within 7 m and is not limited to line of sight, so it can show walls behind walls. The plain prompt (33%) does not include it.

These results were flown under harness v0. New runs use v1, which scores malformed replies and network failures more strictly ([what changed](HARNESS_CHANGELOG.md)); the two are not mixed in one table.

## Earlier versions

- **v1:** Ripple picked one route from a menu per flight, and our controller flew it. It looked strong (56–69% vs. 5% for shortest path), but the spatial work was ours.
- **v2 duel:** Ripple drone vs. Ripple bird, deciding every second, with A* flying to the waypoint it picked. Zero-shot, it flies like shortest path.
- **First Reach pass:** on an earlier 24-route held-out set, the program reached 44% and live steering 17%. That set shares an endpoint with a practice route on 7 of 24 routes, the program had more practice than the other controllers, and runs were added after the first look. The v3 evaluation fixes the second and third: every controller gets a practice budget, and the test set was flown once under a pre-registration. It does not fix the first: 18 of the 48 v3 test routes share a start or goal waypoint with a practice route. On those routes the program reached 67% of flights, and 63% on the other 30, so the overlap does not explain the 65% ([integrity checks](RESULTS_INTEGRITY.md)).
