// Pure policy selection for the coexistence probe (Unit 8): given measured
// LLM latency, image throughput, renderer frame time, and memory pressure
// for the baseline (renderer + LLM only) and every candidate heavy-work
// policy, picks one policy by measurement — never by default. The KTD is
// explicit that the global mutex is the hypothesis this probe tests, not
// the conclusion (docs/plans/2026-09-26-001-feat-m0-feasibility-probes-plan.md).
//
// Selection order, applied only after every candidate's evaluability and
// viability is measured (never assumed):
//   0. a baseline (or candidate) whose LLM data doesn't clear the
//      evaluability floor (>=20 successful requests, <=5% error rate), or
//      whose renderer frame p95 has no verified post-window sample, is
//      "not-evaluable" — its numbers are not trusted for a penalty
//      comparison, and if the baseline itself fails either floor, no
//      candidate can be judged at all: the decision is "inconclusive".
//   1. unconstrained, if its LLM p95 penalty over the baseline is <=25%,
//      it completes at least one image, and no tracked process died — the
//      simplest policy wins when the data says it's safe.
//   2. otherwise, the admission-controlled queue threshold with the best
//      (lowest) penalty among those that clear the same bar — a stricter
//      memory gate costs image throughput, not LLM latency, so a lower
//      viable threshold is preferred when more than one clears the bar.
//   3. otherwise, the global mutex — evaluated under the exact same
//      criteria as every other candidate (healthy, completes images,
//      <=25% penalty, frame evaluable), never given a free pass and never
//      excluded either. Mutex is a hypothesis this probe tests, not an
//      assumed fallback: it wins here only when it is measured to clear
//      the same bar everything else had to clear.
//   4. otherwise, "inconclusive" — never a silent default to any
//      candidate. If every candidate failed or was not-evaluable, the
//      honest answer is "measure more", not "pick the risky one anyway".

export type PolicyName = "unconstrained" | "mutex" | "admission-queue";
export type DecisionPolicy = PolicyName | "inconclusive";

/** A scenario needs at least this many successful LLM requests before its p50/p95 is trusted. */
const MIN_SUCCESSFUL_LLM_REQUESTS = 20;
/** A scenario whose LLM error rate (of all attempted requests) exceeds this is not evaluable. */
const MAX_LLM_ERROR_RATE = 0.05;
const MAX_LLM_P95_PENALTY = 0.25;

/** Measurements common to the baseline scenario and every candidate policy scenario. */
export interface ScenarioMetrics {
  /** `undefined` when there were zero successful requests to compute a percentile from — never `0` as a false "great latency" reading. */
  readonly llmP50Ms: number | undefined;
  readonly llmP95Ms: number | undefined;
  /** `undefined` when raw per-request records aren't available to recompute from (e.g. historical data carried over without its source records) — distinct from `0`, which means requests were attempted and none succeeded. */
  readonly llmSuccessCount: number | undefined;
  readonly llmErrorCount: number | undefined;
  /** Total LLM requests attempted (success + error), the denominator for error rate. `undefined` alongside the two counts above when unrecomputable. */
  readonly llmSampleCount: number | undefined;
  readonly imagesCompleted: number;
  /** Only ever set from a verified post-window measurement; a missing post-window dump must never fall back to a stale pre-window value. */
  readonly rendererFrameP95Ms?: number;
  /** `false` when the post-window frame dump could not be captured — the frame criterion is then not-evaluable, never silently treated as passing. */
  readonly frameEvaluable: boolean;
  readonly peakSwapUsedMiB: number;
  /** Minimum observed `free + inactive` memory (MiB) during the scenario. */
  readonly minFreeMiB: number;
  /** Any OOM/jetsam kill or unexpected process exit during the scenario. */
  readonly processDied: boolean;
}

export interface CandidateResult extends ScenarioMetrics {
  readonly policy: PolicyName;
  /** Admission-queue only: the free+inactive threshold (MiB) gating image start. */
  readonly thresholdMiB?: number;
}

export interface CoexistenceSummary {
  /** Scenario A: renderer + LLM loop only, no image generation. */
  readonly baseline: ScenarioMetrics;
  /** Scenarios B (unconstrained), C (mutex), D@3GiB, D@5GiB (admission-queue). */
  readonly candidates: readonly CandidateResult[];
}

export interface PolicyDecision {
  readonly policy: DecisionPolicy;
  readonly thresholdMiB?: number;
  readonly rationale: string;
}

/** Fractional LLM p95 penalty of `candidateP95Ms` over `baselineP95Ms`. `undefined` when either input is unavailable (not evaluable). `0`/`Infinity` edge case when the baseline itself measured `0`. */
export function computePenalty(
  candidateP95Ms: number | undefined,
  baselineP95Ms: number | undefined,
): number | undefined {
  if (candidateP95Ms === undefined || baselineP95Ms === undefined) {
    return undefined;
  }
  if (baselineP95Ms <= 0) {
    return candidateP95Ms > 0 ? Number.POSITIVE_INFINITY : 0;
  }
  return (candidateP95Ms - baselineP95Ms) / baselineP95Ms;
}

/** `true` once a scenario's LLM data clears the successful-request floor and error-rate ceiling — a prerequisite for trusting its p50/p95 in a penalty comparison. */
export function isLlmEvaluable(metrics: ScenarioMetrics): boolean {
  if (
    metrics.llmSampleCount === undefined ||
    metrics.llmSuccessCount === undefined ||
    metrics.llmErrorCount === undefined
  ) {
    return false;
  }
  if (metrics.llmSampleCount === 0) {
    return false;
  }
  if (metrics.llmSuccessCount < MIN_SUCCESSFUL_LLM_REQUESTS) {
    return false;
  }
  return metrics.llmErrorCount / metrics.llmSampleCount <= MAX_LLM_ERROR_RATE;
}

/** Human-readable reason(s) a scenario's LLM data is not evaluable. Empty string if it is evaluable. */
export function llmEvaluabilityReason(metrics: ScenarioMetrics): string {
  if (
    metrics.llmSampleCount === undefined ||
    metrics.llmSuccessCount === undefined ||
    metrics.llmErrorCount === undefined
  ) {
    return "success/error counts unavailable (raw per-request records not recomputable)";
  }
  const reasons: string[] = [];
  if (metrics.llmSampleCount === 0) {
    reasons.push("no LLM requests recorded");
    return reasons.join(", ");
  }
  if (metrics.llmSuccessCount < MIN_SUCCESSFUL_LLM_REQUESTS) {
    reasons.push(
      `only ${metrics.llmSuccessCount} successful request(s) (need \u2265${MIN_SUCCESSFUL_LLM_REQUESTS})`,
    );
  }
  const errorRate = metrics.llmErrorCount / metrics.llmSampleCount;
  if (errorRate > MAX_LLM_ERROR_RATE) {
    reasons.push(
      `error rate ${(errorRate * 100).toFixed(1)}% (max ${(MAX_LLM_ERROR_RATE * 100).toFixed(0)}%)`,
    );
  }
  return reasons.join(", ");
}

export type CandidateStatus =
  | { readonly kind: "viable" }
  | { readonly kind: "not-evaluable"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

/** Evaluates one candidate against the baseline: not-evaluable (missing/insufficient data on either side) beats failed (measured and cleared for judgment, but did not clear the bar) beats viable. Never assumes a fallback. */
export function evaluateCandidate(
  candidate: CandidateResult,
  baseline: ScenarioMetrics,
): CandidateStatus {
  if (!isLlmEvaluable(baseline)) {
    return {
      kind: "not-evaluable",
      reason: `baseline LLM data not evaluable (${llmEvaluabilityReason(baseline)})`,
    };
  }
  if (!baseline.frameEvaluable) {
    return {
      kind: "not-evaluable",
      reason:
        "baseline frame p95 not evaluable (no post-window sample) — nothing can be recommended without a verified renderer reading for the baseline",
    };
  }
  if (!isLlmEvaluable(candidate)) {
    return {
      kind: "not-evaluable",
      reason: `LLM data not evaluable (${llmEvaluabilityReason(candidate)})`,
    };
  }
  if (!candidate.frameEvaluable) {
    return {
      kind: "not-evaluable",
      reason: "frame p95 not evaluable (no post-window sample)",
    };
  }
  if (candidate.processDied) {
    return {
      kind: "failed",
      reason: "a tracked process died during the scenario",
    };
  }
  const penalty = computePenalty(candidate.llmP95Ms, baseline.llmP95Ms);
  if (penalty === undefined) {
    // Should be unreachable once both sides are LLM-evaluable, but never trust a bare comparison.
    return { kind: "not-evaluable", reason: "LLM p95 unavailable" };
  }
  if (candidate.imagesCompleted === 0) {
    return { kind: "failed", reason: "completed zero images" };
  }
  if (penalty > MAX_LLM_P95_PENALTY) {
    return {
      kind: "failed",
      reason: `LLM p95 penalty ${formatPct(penalty)} exceeds the ${formatPct(MAX_LLM_P95_PENALTY)} bar`,
    };
  }
  return { kind: "viable" };
}

function formatPct(fraction: number): string {
  if (!Number.isFinite(fraction)) {
    return "n/a (baseline p95 was 0ms)";
  }
  const pct = fraction * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function formatMs(value: number | undefined): string {
  return value === undefined ? "n/a" : `${value.toFixed(0)}ms`;
}

/** One-line, fully self-contained description of a candidate: LLM p95 + penalty, success/error counts, images, frame evaluability, and its evaluation status — never silently omits why a candidate wasn't picked. */
export function describeCandidate(
  candidate: CandidateResult,
  baseline: ScenarioMetrics,
): string {
  const label =
    candidate.policy === "admission-queue"
      ? `admission-queue@${candidate.thresholdMiB}MiB`
      : candidate.policy;
  const penalty = computePenalty(candidate.llmP95Ms, baseline.llmP95Ms);
  const penaltyDesc =
    penalty !== undefined ? ` (${formatPct(penalty)} vs baseline)` : "";
  const frameDesc = candidate.frameEvaluable
    ? `frame p95 ${formatMs(candidate.rendererFrameP95Ms)}`
    : "frame p95 not evaluable (no post-window sample)";
  const status = evaluateCandidate(candidate, baseline);
  const statusDesc =
    status.kind === "viable" ? "viable" : `${status.kind}: ${status.reason}`;
  const countsDesc =
    candidate.llmSuccessCount !== undefined &&
    candidate.llmSampleCount !== undefined
      ? `${candidate.llmSuccessCount}/${candidate.llmSampleCount} successful LLM requests`
      : "LLM success/attempt counts unavailable";
  return (
    `${label}: LLM p95 ${formatMs(candidate.llmP95Ms)}${penaltyDesc}, ` +
    `${countsDesc}, ` +
    `${candidate.imagesCompleted} image(s) completed, ${frameDesc} \u2014 ${statusDesc}`
  );
}

/**
 * Picks the heavy-work serialization policy from measured scenario data.
 * Pure function: no I/O, no defaults assumed ahead of measurement. Mutex is
 * evaluated under the same viability criteria as every other candidate
 * (see {@link evaluateCandidate}) — it can win on its own measured merits,
 * but is never chosen as an unconditional fallback when nothing else
 * qualifies; an inconclusive result asks for more measurement instead.
 */
export function choosePolicy(summary: CoexistenceSummary): PolicyDecision {
  const { baseline, candidates } = summary;

  if (!isLlmEvaluable(baseline)) {
    return {
      policy: "inconclusive",
      rationale: `Baseline LLM data is not evaluable (${llmEvaluabilityReason(baseline)}) \u2014 no candidate's penalty can be judged against it. Further measurement needed.`,
    };
  }
  if (!baseline.frameEvaluable) {
    return {
      policy: "inconclusive",
      rationale:
        "Baseline frame p95 is not evaluable (no post-window sample) \u2014 no candidate can be recommended without a verified renderer frame reading for the baseline. Further measurement needed.",
    };
  }

  const statuses = candidates.map((candidate) => ({
    candidate,
    status: evaluateCandidate(candidate, baseline),
  }));
  const viable = statuses
    .filter((s) => s.status.kind === "viable")
    .map((s) => s.candidate);

  const viableUnconstrained = viable.find((c) => c.policy === "unconstrained");
  if (viableUnconstrained) {
    return {
      policy: "unconstrained",
      rationale: `Unconstrained cleared the ${formatPct(MAX_LLM_P95_PENALTY)} LLM p95 penalty bar and completed images \u2014 ${describeCandidate(viableUnconstrained, baseline)}. No serialization overhead needed.`,
    };
  }

  const viableAdmission = viable
    .filter((c) => c.policy === "admission-queue")
    .sort((a, b) => {
      const penaltyA = computePenalty(a.llmP95Ms, baseline.llmP95Ms) ?? 0;
      const penaltyB = computePenalty(b.llmP95Ms, baseline.llmP95Ms) ?? 0;
      if (penaltyA !== penaltyB) {
        return penaltyA - penaltyB;
      }
      return (a.thresholdMiB ?? 0) - (b.thresholdMiB ?? 0);
    });
  const bestAdmission = viableAdmission[0];
  if (bestAdmission) {
    const otherNotes = candidates
      .filter((c) => c !== bestAdmission)
      .map((c) => describeCandidate(c, baseline))
      .join("; ");
    return {
      policy: "admission-queue",
      thresholdMiB: bestAdmission.thresholdMiB,
      rationale: `admission-queue@${bestAdmission.thresholdMiB}MiB cleared the ${formatPct(MAX_LLM_P95_PENALTY)} bar without blocking the LLM \u2014 ${describeCandidate(bestAdmission, baseline)}. Every other candidate measured worse, failed, or was not evaluable: ${otherNotes}.`,
    };
  }

  const viableMutex = viable.find((c) => c.policy === "mutex");
  if (viableMutex) {
    const otherNotes = candidates
      .filter((c) => c !== viableMutex)
      .map((c) => describeCandidate(c, baseline))
      .join("; ");
    return {
      policy: "mutex",
      rationale: `Mutex cleared the ${formatPct(MAX_LLM_P95_PENALTY)} LLM p95 penalty bar and completed images \u2014 ${describeCandidate(viableMutex, baseline)}. Mutex is measured under the same criteria as every other candidate here, not assumed as a fallback; every other candidate measured worse, failed, or was not evaluable: ${otherNotes}.`,
    };
  }

  const notes = candidates
    .map((c) => describeCandidate(c, baseline))
    .join("; ");
  return {
    policy: "inconclusive",
    rationale: `No candidate cleared the ${formatPct(MAX_LLM_P95_PENALTY)} LLM p95 penalty bar while completing images, and none was silently defaulted to: ${notes || "no candidates measured"}. Further measurement is needed before recommending a heavy-work policy.`,
  };
}
