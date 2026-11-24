# Add your model

This is what you do to fly your own model through Spatial Arena and get a scorecard. You need Node 22 or later. Nothing else is installed.

## 1. Try it with no key

Run the stand-in endpoint in one terminal:

```bash
node sim/tools/arena/mock_openai.mjs --mode steady
```

Then, in another terminal, score it:

```bash
node sim/tools/bench.mjs --model local-mock --map factory
```

`local-mock` is an entry in `sim/bench/models.json` that points at `http://127.0.0.1:8789/v1`. The stand-in reads the drone's sensors from the prompt and flies straight at the goal. You should see a scorecard table, and two files in `runs/bench/`: `scorecard.json` and `SCORECARD.md`.

The other stand-in modes show what goes wrong with real models: `--mode truncate` (every reply cut off), `--mode malformed` (prose instead of JSON), `--mode thinker` (thinks for about 600 tokens before it answers).

## 2. Add an entry for your model

Any endpoint that speaks the OpenAI chat completions API works: a hosted provider, vLLM, SGLang, Ollama, LM Studio, llama.cpp server. Add an entry to `sim/bench/models.json`:

```json
{
 "id": "my-model",
 "model": "the-model-name-your-server-expects",
 "baseUrl": "https://api.example.com/v1",
 "apiKeyEnv": "EXAMPLE_API_KEY",
 "thinking": false,
 "extraBody": { "chat_template_kwargs": { "enable_thinking": false } },
 "price": { "in": 0.2, "out": 0.6 }
}
```

- `baseUrl` ends where `/chat/completions` would be appended.
- `apiKeyEnv` names the environment variable that holds the key. Put the key in `.env` at the repository root (`EXAMPLE_API_KEY=...`) or export it. The key is never written to any output. Leave `apiKeyEnv` out for a local server with no key. If your `.env` is elsewhere (for example you work in a git worktree), set `ARENA_ENV_FILE=/path/to/.env`.
- Models on OpenRouter need no `baseUrl`: give the OpenRouter model id, put `OPENROUTER_API_KEY` in `.env`, and pin one host with `provider` and `quantizations`. List the hosts with `node sim/tools/bench.mjs --endpoints <model id>`.

### Settings that change scores

Leave these at their defaults unless you have a reason. The defaults are the same for every model, and a scorecard flags any run that changes the temperature or the retry policy as not comparable.

| Setting | Default | What it does |
|---|---|---|
| `maxTokens` | 400 | Reply budget for each one-second decision. A direct answer needs about 60 to 120 tokens. |
| `thinking` | not sent | `false` asks the host to skip reasoning. OpenRouter gets `reasoning.enabled`. Any other server needs its own switch in `extraBody` too: vLLM and SGLang take `chat_template_kwargs.enable_thinking`, Ollama takes `think`. |
| `reasoningMaxTokens` | not sent | With `"thinking": true` on OpenRouter, caps the reasoning. |
| `temperature` | 0.7 | The same for every model. |
| `retry.truncated` | 0 | Extra attempts when a reply is cut off by `maxTokens`. Every model also gets one retry for any unusable reply; that rule is fixed. |
| `programMaxTokens` | 8000 | Reply budget for a whole program in program mode. |

Reasoning models are the usual trap. If your model thinks before it answers, a 400-token budget cuts it off mid-thought. Either turn thinking off or raise `maxTokens` (and pay for the extra tokens). The arena never scores a cut-off reply as a wrong answer: it is counted separately, and a run where more than 2% of decisions were cut off is marked as measuring the token budget, not spatial skill.

## 3. Run the scorecard

```bash
node sim/tools/bench.mjs --model my-model --map factory
```

This one command:

1. Preflights the endpoint: one short request with your settings. If the reply is cut off or is not JSON, it stops before flying anything and says what to change. Pass `--ignore-preflight` to fly anyway.
2. Flies a small dev sample: 4 development routes, one wind seed, one sample each, live steering at control level C3 (the model sets a velocity every second, with no map).
3. Writes `runs/bench/<date>/my-model/scorecard.json` and `SCORECARD.md`, and prints the table.

Use `--out <folder>` to choose the folder. Re-running the same live-steering command resumes where it stopped; a program-mode run can't be resumed (use a new `--out`).

### The scorecard

| Line | Meaning |
|---|---|
| Reached | Flights that got within 1 m of the goal in 90 s |
| Progress | How much of the start-to-goal distance the drone closed, at best, averaged |
| Wall contacts | Times the drone touched geometry, per flight |
| Unusable replies: wrong format or content | The model answered, but not with a usable command |
| Unusable replies: cut off by token limit | The reply hit `maxTokens` (finish reason `length`) |
| Cut off but still usable | Hit the limit, but the command was already complete |
| Reached, flights with no cut-off | The reached count over flights where nothing was cut off |
| Cost | Reported by the host when it gives one, else estimated from `price` |
| Latency | Median and 90th percentile per call |

Below the table, "Read with care" lists anything that makes the numbers weaker: cut-off replies, non-default settings, machine-dependent program timing, or an environment that has not passed admission stage 2.

## 4. Choose a place

`--map` takes any admitted environment in `sim/environments/` (one with a recorded admission stage that is not film only). The scorecard shows the stage; only stage 2 and above are validated (see the [environment guide](CONTRIBUTING_ENVIRONMENTS.md)). For example:

```bash
node sim/tools/bench.mjs --model my-model --map canyon5b
```

The prompt describes the place from the environment's own scene sentence. For the factory it is byte for byte the prompt the published results used (`sim/test/arena_prompt.test.mjs` checks this).

## 5. Program mode

In program mode the model writes a JavaScript navigation program instead of steering live. The simulator flies it on the training routes, the model reads the results and revises, and the best version on training is frozen and flown on the dev sample.

```bash
node sim/tools/bench.mjs --model my-model --map factory --mode program --iters 3
```

Each policy call gets up to 1000 ms. Every call is timed. The scorecard calls the timing machine-independent only when no call timed out and the slowest took under a tenth of the limit, so a machine ten times slower would have flown the same flights. (The published runs used a 50 ms limit; reproducing them keeps that.)

## 6. Bigger runs

The scorecard is a quick look. For a comparison with confidence intervals, fly more routes, wind seeds and samples, and use the report:

```bash
node sim/tools/bench.mjs --models my-model --set dev --seeds 2 --samples 5 --levels C3 --out runs/bench/my-run
```

```bash
node sim/tools/bench_report.mjs runs/bench/my-run
```

Add `--scorecard` to also write a scorecard for each model.

## 7. Clean routes for a final score

The development routes are public, and the published harness was tuned on them. The public test routes have been flown twice. For a score on routes nobody has tuned on, the arena keeps a held-back split:

- The routes are fixed by a secret seed. Only its hash is published, in `sim/bench/hidden-splits.json`. The hash also covers the generator code, the map and the public route sets, so nobody can change the routes after seeing results.
- Hidden routes share no pair with any public set and no endpoint with the training or development routes. Their wind seeds come from the secret too.
- The seed holder scores a model with `--set hidden --hidden-seed-file <file> --confirm-hidden`. bench.mjs checks the seed against the published hash before it flies.
- At the reveal the seed is published, and anyone can check it and re-fly every recorded flight: `node sim/tools/arena/hidden_split.mjs verify --map factory --seed-file <file>`.

The map itself is public, so a method tuned on every possible route of a map is also tuned on its hidden routes. The split guards against tuning on specific routes and winds and against choosing routes after the fact.

If you want your model scored on the hidden split, open an issue with your `models.json` entry.

## What is recorded

Every run folder holds `config.json` (model, settings, harness and arena hashes, prompt profile), `episodes.jsonl` (every decision and command, enough to re-fly each flight exactly), `calls.jsonl` (every reply with its finish reason, tokens and latency), `retries.jsonl` (transport failures; these are never scored), `ledger.jsonl`, and the scorecard. A flight lost to a network or host failure is dropped, not scored; run the command again to fly it.

## Limits today

- Live steering and the scorecard work for any OpenAI-compatible model. Program mode is a single practice run; the published studies used several parallel runs (`sim/tools/reach_cap.mjs`).
- Missions (search and delivery) still run through their own tools, not through this scorecard.
- The local Claude Code and Codex CLI entries in `models.json` work with `--models` but may not report cost or token counts.
