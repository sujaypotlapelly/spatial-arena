// Scorecard for one model on one environment (bench.mjs --model). Separates
// replies that were cut off by the token limit from replies that were wrong,
// so a cut-off is never read as a spatial failure.
import { timingVerdict } from "../../src/gym/policy_sandbox.js";

// A run whose decisions were cut off more often than this measures the token
// budget, not spatial skill.
export const TRUNCATION_LIMIT = 0.02;

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// Classify one episode's decisions.
export function decisionCounts(decisionLog) {
  let truncatedInvalid = 0, otherInvalid = 0, truncatedUsable = 0, timeouts = 0;
  for (const d of decisionLog) {
    const cut = d.meta?.finish === "length";
    const bad = Boolean(d.invalid || d.error);
    if (bad && cut) truncatedInvalid++;
    else if (bad) otherInvalid++;
    else if (cut) truncatedUsable++;
    if (d.timeout) timeouts++;
  }
  return { decisions: decisionLog.length, truncatedInvalid, otherInvalid, truncatedUsable, timeouts };
}

export function buildScorecard({ config, rows, stats = null, program = null }) {
  const per = rows.map((r) => ({ ...r, ...decisionCounts(r.decisionLog ?? []) }));
  const dec = per.reduce((s, r) => s + r.decisions, 0);
  const sum = (k) => per.reduce((s, r) => s + r[k], 0);
  const cutEpisodes = per.filter((r) => r.truncatedInvalid + r.truncatedUsable > 0);
  const clean = per.filter((r) => r.truncatedInvalid + r.truncatedUsable === 0);
  const reached = (rs) => rs.filter((r) => r.result.outcome === "reached").length;
  const truncShare = dec ? (sum("truncatedInvalid") + sum("truncatedUsable")) / dec : 0;
  const timing = config.mode === "program" ? timingVerdict(rows.flatMap((r) => r.decisionLog ?? []), config.policyBudget?.callTimeoutMs) : null;
  const progTrunc = program ? program.versions.filter((v) => v.truncated).length : 0;
  const problems = [];
  if (truncShare > TRUNCATION_LIMIT) problems.push(`${Math.round(truncShare * 100)}% of decisions were cut off by the ${config.settings.maxTokens}-token limit. This run measures the token budget, not spatial skill: raise maxTokens or set "thinking": false in models.json.`);
  if (program && progTrunc === program.versions.length) problems.push(`every program reply was cut off at ${config.settings.programMaxTokens} tokens; raise programMaxTokens.`);
  if (timing && !timing.machineIndependent && timing.calls) problems.push(`policy timing is machine-dependent: ${timing.timeouts} timeouts, slowest call ${timing.slowestMs} ms against a ${timing.callTimeoutMs} ms limit.`);
  if (config.settings.nonStandard?.length) problems.push(`non-standard settings (not comparable with the default runs): ${config.settings.nonStandard.join(", ")}.`);
  if (config.environment.stage == null || config.environment.stage < 2) problems.push(`${config.environment.name} is at admission stage ${config.environment.stage ?? "none"}; scores here are not validated (docs/CONTRIBUTING_ENVIRONMENTS.md).`);
  return {
    schema: "spatial-arena-scorecard/1",
    model: config.model,
    environment: config.environment,
    mode: config.mode,
    level: config.level,
    set: config.set,
    routes: new Set(rows.map((r) => r.scenario)).size,
    episodes: rows.length,
    reached: reached(rows),
    reachedShare: rows.length ? reached(rows) / rows.length : null,
    progress: mean(rows.map((r) => r.progress)),
    contactsPerEpisode: mean(rows.map((r) => r.result.contacts)),
    replies: {
      decisions: dec,
      invalidWrong: sum("otherInvalid"),
      invalidTruncated: sum("truncatedInvalid"),
      truncatedButUsable: sum("truncatedUsable"),
      truncatedShare: truncShare,
      episodesWithTruncation: cutEpisodes.length,
      reachedWithoutTruncation: { reached: reached(clean), of: clean.length },
    },
    program: program ? { versions: program.versions.map(({ code, ...v }) => v), best: program.best?.version ?? null, truncatedReplies: progTrunc } : null,
    timing,
    calls: stats,
    settings: config.settings,
    harness: config.harness,
    valid: problems.length === 0,
    problems,
    createdAt: new Date().toISOString(),
  };
}

const pct = (x) => (x == null ? "n/a" : `${Math.round(100 * x)}%`);
const num = (x, d = 1) => (x == null ? "n/a" : (Math.round(x * 10 ** d) / 10 ** d).toString());

export function scorecardMarkdown(S) {
  const R = S.replies;
  const rows = [
    ["Reached", `${S.reached}/${S.episodes} (${pct(S.reachedShare)})`],
    ["Progress toward goal (mean)", pct(S.progress)],
    ["Wall contacts per flight (mean)", num(S.contactsPerEpisode)],
    ["Decisions", String(R.decisions)],
    ["Unusable replies: wrong format or content", String(R.invalidWrong)],
    ["Unusable replies: cut off by token limit", String(R.invalidTruncated)],
    ["Cut off but still usable", String(R.truncatedButUsable)],
    ["Flights with any cut-off reply", String(R.episodesWithTruncation)],
    ["Reached, flights with no cut-off", `${R.reachedWithoutTruncation.reached}/${R.reachedWithoutTruncation.of}`],
  ];
  if (S.program) {
    rows.push(["Program versions (best)", `${S.program.versions.length} (v${S.program.best ?? "none"})`]);
    rows.push(["Program replies cut off", String(S.program.truncatedReplies)]);
  }
  if (S.timing) rows.push(["Policy timing", `${S.timing.timeouts} timeouts, slowest ${num(S.timing.slowestMs, 2)} ms of ${S.timing.callTimeoutMs} ms (${S.timing.machineIndependent ? "machine-independent" : "machine-dependent"})`]);
  if (S.calls) {
    rows.push(["Model calls", `${S.calls.calls} (finish: ${Object.entries(S.calls.finishes).map(([k, n]) => `${k} ${n}`).join(", ")})`]);
    rows.push(["Tokens in / out (reasoning)", `${S.calls.promptTokens} / ${S.calls.completionTokens} (${S.calls.reasoningTokens})`]);
    rows.push(["Cost", S.calls.costUsd == null ? "n/a" : `$${S.calls.costUsd.toFixed(4)} (${S.calls.costSource})`]);
    rows.push(["Latency median / p90", `${S.calls.latencyMs.median ?? "n/a"} / ${S.calls.latencyMs.p90 ?? "n/a"} ms`]);
  }
  return `# Scorecard: ${S.model.id} on ${S.environment.name}

${S.mode === "program" ? "Program mode (the model writes a policy on train routes; the best version flies the evaluation routes)" : `Live steering at ${S.level}`}, ${S.set} set, ${S.routes} routes, ${S.episodes} flights. Settings: max ${S.settings.maxTokens} tokens, temperature ${S.settings.temperature}, thinking ${S.settings.thinking ?? "host default"}.

| Measure | Value |
|---|---|
${rows.map(([a, b]) => `| ${a} | ${b} |`).join("\n")}

${S.valid ? "No problems found." : `**Read with care:**\n\n${S.problems.map((p) => `- ${p}`).join("\n")}`}

Harness ${S.harness.version} (${S.harness.hash}), arena ${S.harness.arenaHash}. Created ${S.createdAt}.
`;
}
