# Results

Runs that people have shared. Each folder is one model on one place.

## Add yours

1. Fly your model and build the report:

   ```bash
   node sim/tools/bench.mjs --models my-model --baselines --set dev --seeds 2 --samples 1 --levels C3 --out runs/bench/my-model
   node sim/tools/bench_report.mjs runs/bench/my-model
   ```

2. Copy these from `runs/bench/my-model/` into `results/<place>-<model>/`:
   - `LEADERBOARD.md` and `leaderboard.json`
   - each model folder's `config.json`, `ledger.jsonl` and `episodes.jsonl` (gzip it: `gzip episodes.jsonl`)
3. Run `node sim/tools/bench_report.mjs results/<place>-<model>` on the copied folder. The report reads compressed flights directly. Check the replay counts, add a line to the table below and open a pull request.

Do not include `calls.jsonl` if your prompts or replies contain anything private; it is not needed to check a result.

## How a result is checked

Every flight stores the commands the model gave. `bench_report.mjs` re-flies each one in the simulator and reports how many match exactly. A result is "self-reported" until someone other than the author has re-flown it, and "re-flown" after. Re-flying proves the flights happened as recorded under the stated harness version; it cannot prove which model produced the commands.

## Shared results

| Place | Model | Level | Reached | Harness | Status |
|---|---|---|---|---|---|
| Factory, 48 test routes | Ripple-65B, program after practice | C3 | 65% [53–78] | v0 | By the authors. [Reproduce the flights](../docs/USAGE.md#reproduce-the-published-results). |
| Factory, 48 test routes | Ripple-65B, steering live | C3 | 44% [34–55] | v0 | By the authors. [Reproduce the flights](../docs/USAGE.md#reproduce-the-published-results). |
