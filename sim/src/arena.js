// Orchestration for the four demo controls:
//   runBaseline  - shortest-path comparator vs. the default bird
//   trainingEpisode - attacker proposes a solvable scenario, defender
//                     (with feedback from earlier episodes) responds
//   adapt        - training episodes up to the target, then freeze a
//                  written strategy
//   evaluate     - 12 held-out scenarios x 3 conditions, plus the
//                  spatial-prediction quiz
// The simulator decides every outcome. Model text is never trusted as a
// result.

import { routeMenu } from "./world.js";
import { shortestPathPolicy, validateDefender, validateAttack, defaultAttack, extractJson } from "./policy.js";
import { runEpisode, checkSolvable, referenceLength, TRAINING_TASK, TRAINING_SEEDS } from "./scenarios.js";
import {
  defenderMessages,
  attackerMessages,
  strategyMessages,
  quizMessages,
  makeQuiz,
  scoreQuiz,
  heuristicDefender,
  heuristicAttacker,
  heuristicStrategy,
  scoreBelief,
  HARNESSES,
  geometryTools,
} from "./agents.js";

export const TRAINING_EPISODES = 8;

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// System-identification scores over a set of episodes (null when the
// condition states no belief, e.g. the shortest-path comparator).
export function beliefStats(eps) {
  const b = eps.map((e) => e.belief).filter(Boolean);
  if (!b.length) return { behaviorAccuracy: null, familyAccuracy: null, meanDangerError: null, meanPredictionError: null };
  // Invalid decisions count as wrong: denominators are all episodes.
  const n = eps.length;
  const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, c) => a + c, 0) / xs.length) * 10) / 10 : null);
  const errs = b.map((x) => x.dangerError).filter((x) => x !== null);
  const pred = b.map((x) => x.predictionError).filter((x) => x !== null && x !== undefined);
  const lat = eps.map((e) => e.defender.latencyMs).filter(Number.isFinite).sort((x, y) => x - y);
  return {
    behaviorAccuracy: b.filter((x) => x.behaviorCorrect).length / n,
    familyAccuracy: b.filter((x) => x.familyCorrect).length / n,
    meanDangerError: mean(errs),
    dangerPointsGiven: errs.length,
    meanPredictionError: mean(pred),
    predictionsGiven: pred.length,
    medianLatencyS: lat.length ? Math.round(lat[Math.floor(lat.length / 2)] / 100) / 10 : null,
    toolCallsPerDecision: Math.round((eps.reduce((s, e) => s + (e.defender.toolCalls?.length || 0), 0) / n) * 10) / 10,
    hosts: [...new Set(eps.map((e) => e.defender.provider).filter(Boolean))],
  };
}

export class Arena {
  constructor(world, heldout, client, { defenderHarness = "raw" } = {}) {
    this.defenderHarness = defenderHarness;
    this.world = world;
    this.heldout = heldout;
    this.client = client; // ModelClient; client.enabled false => heuristic stand-ins
    this.reset();
  }

  reset() {
    this.baseline = null;
    this.training = [];
    this.strategy = null;
    this.evaluation = null;
    this.rematch = null;
    this.client.ledger = { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, ms: 0 };
    this.client.lastError = null;
  }

  get usingModel() {
    return this.client.enabled;
  }

  // ---- model wrappers ----

  async ask(messages, { tag, temperature, retries = 1, harness = HARNESSES.raw } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await this.client.chat(messages, { tag, temperature, harness });
        const parsed = extractJson(r.content);
        if (parsed === null) throw new Error("reply contained no JSON");
        return { ...r, parsed };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  // Harness C: Ripple calls geometry tools until it returns its decision.
  async askWithTools(messages, scenario, { tag, temperature, harness, retries = 1, maxRounds = 8 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const { tools, run } = geometryTools(this.world, scenario);
      const msgs = [...messages];
      const toolLog = [];
      let ms = 0;
      try {
        for (let round = 0; round < maxRounds; round++) {
          const last = round === maxRounds - 1;
          // Round 0 must measure something; the last round must answer.
          const r = await this.client.chat(msgs, { tag, temperature, harness, tools, tool_choice: last ? "none" : round === 0 ? "required" : null });
          ms += r.latencyMs;
          if (r.toolCalls && !last) {
            msgs.push({ role: "assistant", content: r.content || "", tool_calls: r.toolCalls });
            for (const call of r.toolCalls) {
              let args = {};
              let result;
              try {
                args = JSON.parse(call.function?.arguments || "{}");
                result = run(call.function?.name, args);
              } catch (e) {
                result = { error: String(e.message) };
              }
              toolLog.push({ name: call.function?.name, args, result });
              msgs.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
            }
            continue;
          }
          const parsed = extractJson(r.content);
          if (parsed === null) throw new Error("final reply contained no JSON");
          return { ...r, parsed, toolLog, latencyMs: ms };
        }
        throw new Error("no decision after tool rounds");
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  // mode: "original" | "training" | "strategy"; harness: a key of HARNESSES.
  // In evaluation a failed model call is an invalid action, not a silent
  // fallback, so Ripple's numbers are never padded by the heuristic.
  async decide(scenario, { mode, history = [], strategy = null, fallbackOnError = true, harness = "raw" }) {
    const h = HARNESSES[harness] || HARNESSES.raw;
    const ctx = { history: mode === "training" ? history : [], strategy: mode === "strategy" ? strategy : null };
    const prompt = defenderMessages(this.world, scenario, { ...ctx, style: h.style, brief: !h.reasoning });
    let raw;
    let meta = { harness: h.key };
    if (!this.usingModel) {
      raw = heuristicDefender(this.world, scenario, ctx);
      meta.source = "heuristic";
    } else {
      try {
        const opts = { tag: `defender:${mode}:${h.key}`, temperature: 0.3, harness: h };
        const r = h.style.includes("tools") ? await this.askWithTools(prompt, scenario, opts) : await this.ask(prompt, opts);
        raw = r.parsed;
        Object.assign(meta, { source: "ripple", model: r.model, provider: r.provider, latencyMs: r.latencyMs, reply: r.content, reasoning: r.reasoning, usage: r.usage, toolCalls: r.toolLog || null });
      } catch (e) {
        if (!fallbackOnError) {
          return { policy: { route: null }, warnings: [], invalid: `model call failed: ${e.message}`, source: "ripple", harness: h.key, error: String(e.message), prompt };
        }
        raw = heuristicDefender(this.world, scenario, ctx);
        Object.assign(meta, { source: "heuristic", error: String(e.message) });
      }
    }
    const val = validateDefender(raw, this.world, scenario);
    return { ...val, ...meta, raw, prompt };
  }

  async proposeAttack(task, history) {
    const rejected = [];
    const attempts = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const useModel = this.usingModel && attempt < 3;
      let raw;
      let meta;
      const prompt = attackerMessages(this.world, task, history, rejected);
      if (useModel) {
        try {
          const r = await this.ask(prompt, { tag: "attacker", temperature: 0.6, harness: HARNESSES.raw });
          raw = r.parsed;
          meta = { source: "ripple", model: r.model, latencyMs: r.latencyMs, reply: r.content, reasoning: r.reasoning, usage: r.usage };
        } catch (e) {
          raw = heuristicAttacker(this.world, task, history, rejected);
          meta = { source: "heuristic", error: String(e.message) };
        }
      } else {
        raw = heuristicAttacker(this.world, task, history, rejected);
        meta = { source: "heuristic" };
      }
      const { bird, warnings } = validateAttack(raw, this.world, task);
      const scenario = { ...task, bird, seeds: TRAINING_SEEDS };
      const solv = checkSolvable(this.world, scenario);
      attempts.push({ bird, solvable: solv.solvable });
      if (solv.solvable) return { bird, warnings, ...meta, raw, prompt, solvability: solv, rejected };
      rejected.push(`${bird.ambush_node} ${bird.strategy} from ${bird.start} at ${bird.speed} m/s: no reference route succeeds`);
    }
    // Last resort: the default chase, which is solvable on this map.
    const bird = validateAttack(defaultAttack(this.world, task), this.world, task).bird;
    return { bird, warnings: ["all proposals unsolvable; using default chase"], source: "fallback", rejected, solvability: checkSolvable(this.world, { ...task, bird, seeds: TRAINING_SEEDS }) };
  }

  // ---- controls ----

  runBaseline() {
    const bird = validateAttack(defaultAttack(this.world, TRAINING_TASK), this.world, TRAINING_TASK).bird;
    const scenario = { id: "baseline", ...TRAINING_TASK, bird, seeds: TRAINING_SEEDS };
    const policy = shortestPathPolicy(this.world, scenario);
    const ep = runEpisode(this.world, scenario, policy);
    this.baseline = { kind: "baseline", index: 0, scenario, defender: { policy, warnings: [], invalid: null, source: "comparator" }, attack: { bird, source: "default" }, ...ep };
    return this.baseline;
  }

  async trainingEpisode() {
    const index = this.training.length + 1;
    const attack = await this.proposeAttack(TRAINING_TASK, this.training);
    const scenario = { id: `T${index}`, ...TRAINING_TASK, bird: attack.bird, seeds: TRAINING_SEEDS };
    const defender = await this.decide(scenario, { mode: "training", history: this.training, harness: this.defenderHarness });
    const ep = this.execute(scenario, defender);
    const belief = defender.invalid ? null : scoreBelief(defender.policy, scenario, ep.results, ep.frames?.[0], this.world.physics.observeSeconds);
    const record = { kind: "training", index, scenario, attack, defender, belief, ...ep };
    this.training.push(record);
    return record;
  }

  execute(scenario, defender) {
    if (defender.invalid) {
      const n = scenario.seeds.length;
      const results = scenario.seeds.map((seed) => ({ seed, outcome: "invalid", detail: defender.invalid, reward: -1, time: 0, pathLength: 0, minSeparation: Infinity, events: [], endPos: this.world.nodes[scenario.start], routeFinal: [] }));
      return { results, frames: null, summary: { trials: n, reached: 0, intercepted: 0, crashed: 0, timeout: 0, invalid: n, successRate: 0, collisionRate: 0, meanReward: -1, meanTimeReached: null, meanPathLength: null } };
    }
    return runEpisode(this.world, scenario, defender.policy);
  }

  // Same scenario and seeds as the first failed training episode, decided
  // again by the defender with the frozen strategy (no episode history).
  async runRematch() {
    if (!this.strategy || !this.training.length) throw new Error("train and freeze a strategy first");
    const before = this.training.find((ep) => ep.summary.successRate < 0.5) || this.training[0];
    const scenario = before.scenario;
    const defender = await this.decide(scenario, { mode: "strategy", strategy: this.strategy.text, fallbackOnError: false, harness: this.defenderHarness });
    const ep = this.execute(scenario, defender);
    const belief = defender.invalid ? null : scoreBelief(defender.policy, scenario, ep.results, ep.frames?.[0], this.world.physics.observeSeconds);
    this.rematch = { beforeIndex: before.index, after: { kind: "rematch", index: before.index, scenario, defender, belief, ...ep } };
    return { before, after: this.rematch.after };
  }

  // Load a saved session. Trajectories are re-simulated from each saved
  // scenario + decision + seed; the engine is deterministic, so outcomes must
  // match the recording. Returns how many were checked and how many differed.
  importSession(data) {
    this.reset();
    let checked = 0;
    let mismatched = 0;
    const rehydrate = (ep) => {
      if (!ep) return ep;
      if (ep.defender.invalid) return { ...ep, frames: null };
      const sim = runEpisode(this.world, ep.scenario, ep.defender.policy);
      checked++;
      if (sim.results.map((r) => r.outcome + r.time).join() !== ep.results.map((r) => r.outcome + r.time).join()) mismatched++;
      return { ...ep, frames: sim.frames };
    };
    this.baseline = rehydrate(data.baseline);
    this.training = (data.training || []).map(rehydrate);
    this.strategy = data.strategy || null;
    this.evaluation = data.evaluation ? { ...data.evaluation, episodes: data.evaluation.episodes.map(rehydrate) } : null;
    this.rematch = data.rematch ? { ...data.rematch, after: rehydrate(data.rematch.after) } : null;
    this.recordedLedger = data.ledger || null;
    this.recordedUsingModel = !!data.usingModel;
    this.mapFile = data.mapFile || "maps/building.json";
    if (data.defenderHarness) this.defenderHarness = data.defenderHarness;
    // Optional [beforeKey, afterKey] the demo should compare.
    this.demoPairKeys = Array.isArray(data.demoPairKeys) ? data.demoPairKeys : null;
    this.recordedAt = data.exportedAt;
    return { checked, mismatched };
  }

  async freezeStrategy() {
    if (!this.training.length) throw new Error("run training episodes first");
    if (this.usingModel) {
      try {
        const r = await this.ask(strategyMessages(this.world, this.training), { tag: "strategy", temperature: 0.3, harness: HARNESSES.raw });
        const text = typeof r.parsed.strategy === "string" ? r.parsed.strategy.trim() : "";
        if (!text) throw new Error("no strategy text in reply");
        this.strategy = { text, source: "ripple", model: r.model, reply: r.content, reasoning: r.reasoning, frozenAt: new Date().toISOString(), fromEpisodes: this.training.length };
        return this.strategy;
      } catch (e) {
        this.strategy = { text: heuristicStrategy(this.training), source: "heuristic", error: String(e.message), frozenAt: new Date().toISOString(), fromEpisodes: this.training.length };
        return this.strategy;
      }
    }
    this.strategy = { text: heuristicStrategy(this.training), source: "heuristic", frozenAt: new Date().toISOString(), fromEpisodes: this.training.length };
    return this.strategy;
  }

  // conditions: [{ key, label, harness, mode }]; key "shortest" is the
  // comparator. Default: comparator vs. Ripple before and after feedback.
  async evaluate(onProgress = () => {}, { conditions = null, quiz: runQuiz = true, concurrency = 8 } = {}) {
    conditions = conditions || [
      { key: "shortest", label: "Shortest-path comparator" },
      { key: "original", label: this.usingModel ? "Ripple, original instructions" : "Heuristic stand-in, no strategy", harness: this.defenderHarness, mode: "original" },
      { key: "strategy", label: this.usingModel ? "Ripple + frozen strategy" : "Heuristic stand-in + strategy", harness: this.defenderHarness, mode: "strategy" },
    ];
    if (conditions.some((c) => c.mode === "strategy") && !this.strategy) throw new Error("freeze a strategy first");
    const jobs = [];
    for (const sc of this.heldout) for (const c of conditions) jobs.push({ sc, c });
    let done = 0;
    const episodes = await pool(jobs, concurrency, async ({ sc, c }) => {
      let defender;
      if (c.key === "shortest") defender = { policy: shortestPathPolicy(this.world, sc), warnings: [], invalid: null, source: "comparator" };
      else defender = await this.decide(sc, { mode: c.mode || "original", strategy: this.strategy?.text, fallbackOnError: false, harness: c.harness || "raw" });
      const ep = this.execute(sc, defender);
      done++;
      onProgress(done, jobs.length);
      const belief = c.key === "shortest" || defender.invalid ? null : scoreBelief(defender.policy, sc, ep.results, ep.frames?.[0], this.world.physics.observeSeconds);
      return { kind: "eval", condition: c.key, scenario: sc, defender, belief, ...ep };
    });

    const metrics = {};
    for (const c of conditions) {
      const eps = episodes.filter((e) => e.condition === c.key);
      const trials = eps.flatMap((e) => e.results.map((r) => ({ r, e })));
      const n = trials.length;
      const reached = trials.filter(({ r }) => r.outcome === "reached");
      const eff = reached.map(({ r, e }) => r.pathLength / referenceLength(this.world, e.scenario));
      metrics[c.key] = {
        label: c.label,
        scenarios: eps.length,
        trials: n,
        successRate: n ? reached.length / n : 0,
        collisionRate: n ? trials.filter(({ r }) => r.outcome === "intercepted" || r.outcome === "crashed").length / n : 0,
        interceptRate: n ? trials.filter(({ r }) => r.outcome === "intercepted").length / n : 0,
        crashRate: n ? trials.filter(({ r }) => r.outcome === "crashed").length / n : 0,
        meanReward: n ? trials.reduce((s, { r }) => s + r.reward, 0) / n : 0,
        pathEfficiency: eff.length ? eff.reduce((a, b) => a + b, 0) / eff.length : null,
        invalidActions: eps.filter((e) => e.defender.invalid).length,
        constraintViolations: eps.reduce((s, e) => s + (e.defender.warnings?.length || 0), 0),
        scenariosSolved: eps.filter((e) => e.summary.successRate >= 0.5).length,
        ...beliefStats(eps),
      };
    }

    // Spatial-prediction quiz: separate questions with analytic answers.
    const quiz = makeQuiz();
    const quizResults = {};
    for (const key of runQuiz ? ["original", "strategy"].filter((k) => k === "original" || this.strategy) : []) {
      if (!this.usingModel) {
        quizResults[key] = { skipped: "no model configured" };
        continue;
      }
      try {
        const r = await this.ask(quizMessages(quiz, key === "strategy" ? this.strategy.text : null), { tag: `quiz:${key}`, temperature: 0, harness: HARNESSES.raw });
        quizResults[key] = { ...scoreQuiz(quiz, r.parsed), reply: r.content };
      } catch (e) {
        quizResults[key] = { error: String(e.message), accuracy: 0, correct: 0, total: quiz.length };
      }
    }
    const collideShare = quiz.filter((q) => q.truth.collide).length / quiz.length;

    this.evaluation = { conditions, episodes, metrics, quiz: { questions: quiz, results: quizResults, collideShare }, ledger: { ...this.client.ledger }, at: new Date().toISOString() };
    return this.evaluation;
  }

  // Everything needed to reproduce or replay the session.
  exportSession({ includeFrames = true } = {}) {
    // Without full frames, keep a 4 Hz trajectory per seed for the dataset;
    // full motion can be re-simulated deterministically from the decision.
    const traj = (frames) =>
      frames?.map((fr) => fr.filter((_, i) => i % 8 === 0 || i === fr.length - 1).map((f) => ({ t: Math.round(f.t * 100) / 100, drone: f.d.map((x) => Math.round(x * 100) / 100), bird: f.b.map((x) => Math.round(x * 100) / 100) })));
    const strip = (ep) =>
      ep
        ? {
            ...ep,
            frames: includeFrames ? ep.frames : undefined,
            trajectories: includeFrames ? undefined : traj(ep.frames),
            defender: ep.defender && { ...ep.defender, prompt: undefined },
            attack: ep.attack && { ...ep.attack, prompt: undefined },
          }
        : ep;
    return {
      format: "ripple-arena/1",
      exportedAt: new Date().toISOString(),
      map: this.world.map.name,
      usingModel: this.usingModel,
      defenderHarness: this.defenderHarness,
      mapFile: this.mapFile || "maps/building.json",
      baseline: strip(this.baseline),
      training: this.training.map(strip),
      strategy: this.strategy,
      evaluation: this.evaluation && { ...this.evaluation, episodes: this.evaluation.episodes.map(strip) },
      rematch: this.rematch && { ...this.rematch, after: strip(this.rematch.after) },
      ledger: { ...this.client.ledger },
    };
  }
}

export { routeMenu };
