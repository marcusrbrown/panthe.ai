// Pure policy selection for the coexistence probe (Unit 8): given measured
// LLM latency, image throughput, renderer frame time, and memory pressure
// for the baseline (renderer + LLM only) and every candidate heavy-work
// policy, picks one policy by measurement — never by default. The KTD is
// explicit that the global mutex is the hypothesis this probe tests, not
// the conclusion (docs/plans/2026-09-26-001-feat-m0-feasibility-probes-plan.md).
//
// Selection order, applied only after every candidate's viability is
// measured (never assumed):
//   1. unconstrained, if its LLM p95 penalty over the baseline is <=25%
//      and it completes at least one image with no process death — the
//      simplest policy wins when the data says it's safe.
//   2. otherwise, the admission-controlled queue threshold with the best
//      (lowest) penalty among those that clear the same bar — a stricter
//      memory gate costs image throughput, not LLM latency, so a lower
//      viable threshold is preferred when more than one clears the bar.
//   3. otherwise, the global mutex — the fallback of last resort: it can
//      never corrupt memory state (image generation and LLM generation
//      never run concurrently), even when its own penalty is large.

export type PolicyName = "unconstrained" | "mutex" | "admission-queue";

/** Measurements common to the baseline scenario and every candidate policy scenario. */
export interface ScenarioMetrics {
  readonly llmP50Ms: number;
  readonly llmP95Ms: number;
  readonly imagesCompleted: number;
  readonly rendererFrameP95Ms?: number;
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
  readonly policy: PolicyName;
  readonly thresholdMiB?: number;
  readonly rationale: string;
}

const MAX_LLM_P95_PENALTY = 0.25;

/** Fractional LLM p95 penalty of `candidateP95Ms` over `baselineP95Ms`. `0` when the baseline itself measured `0`. */
export function computePenalty(
  candidateP95Ms: number,
  baselineP95Ms: number,
): number {
  if (baselineP95Ms <= 0) {
    return candidateP95Ms > 0 ? Number.POSITIVE_INFINITY : 0;
  }
  return (candidateP95Ms - baselineP95Ms) / baselineP95Ms;
}

function isViable(
  candidate: CandidateResult,
  baseline: ScenarioMetrics,
): boolean {
  return (
    !candidate.processDied &&
    candidate.imagesCompleted > 0 &&
    computePenalty(candidate.llmP95Ms, baseline.llmP95Ms) <= MAX_LLM_P95_PENALTY
  );
}

function formatPct(fraction: number): string {
  if (!Number.isFinite(fraction)) {
    return "n/a (baseline p95 was 0ms)";
  }
  const pct = fraction * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function describeCandidate(
  candidate: CandidateResult,
  baseline: ScenarioMetrics,
): string {
  const penalty = computePenalty(candidate.llmP95Ms, baseline.llmP95Ms);
  const label =
    candidate.policy === "admission-queue"
      ? `admission-queue@${candidate.thresholdMiB}MiB`
      : candidate.policy;
  return `${label}: LLM p95 ${candidate.llmP95Ms.toFixed(0)}ms (${formatPct(penalty)} vs baseline ${baseline.llmP95Ms.toFixed(0)}ms), ${candidate.imagesCompleted} image(s) completed${candidate.processDied ? ", process died" : ""}`;
}

/**
 * Picks the heavy-work serialization policy from measured scenario data.
 * Pure function: no I/O, no defaults assumed ahead of measurement.
 */
export function choosePolicy(summary: CoexistenceSummary): PolicyDecision {
  const { baseline, candidates } = summary;
  const viable = candidates.filter((c) => isViable(c, baseline));

  const viableUnconstrained = viable.find((c) => c.policy === "unconstrained");
  if (viableUnconstrained) {
    return {
      policy: "unconstrained",
      rationale: `Unconstrained cleared the ${formatPct(MAX_LLM_P95_PENALTY)} LLM p95 penalty bar and completed images — ${describeCandidate(viableUnconstrained, baseline)}. No serialization overhead needed.`,
    };
  }

  const viableAdmission = viable
    .filter((c) => c.policy === "admission-queue")
    .sort((a, b) => {
      const penaltyA = computePenalty(a.llmP95Ms, baseline.llmP95Ms);
      const penaltyB = computePenalty(b.llmP95Ms, baseline.llmP95Ms);
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
      rationale: `admission-queue@${bestAdmission.thresholdMiB}MiB cleared the ${formatPct(MAX_LLM_P95_PENALTY)} bar without blocking the LLM — ${describeCandidate(bestAdmission, baseline)}. Every other candidate measured worse or failed: ${otherNotes}.`,
    };
  }

  const mutex = candidates.find((c) => c.policy === "mutex");
  const failureNotes = candidates
    .filter((c) => c.policy !== "mutex")
    .map((c) => describeCandidate(c, baseline))
    .join("; ");
  const mutexNote = mutex
    ? describeCandidate(mutex, baseline)
    : "mutex: not measured";
  return {
    policy: "mutex",
    rationale: `Neither unconstrained nor any admission-queue threshold cleared the ${formatPct(MAX_LLM_P95_PENALTY)} bar (${failureNotes}). Falling back to the global mutex hypothesis as the safe default: ${mutexNote}.`,
  };
}
