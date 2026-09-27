// The configured fallback sequence for ADR-0005's OpenCode arm: Go free
// models first, then Go's paid model, then local Ollama, then routine-only.
// OpenCode Zen's `zen/v1` base is intentionally NOT part of this chain: its
// free models return an unconditional 403 `FreeTierError` from a non-public
// inference service regardless of headers, endpoint, or which auth.json
// entry sources the (shared) credential — a scope note for ADR-0005, not a
// step worth spending a retry budget on (see provider-matrix/README.md for
// the investigation). Each step gets at most `maxAttemptsPerStep` attempts
// with a flat, bounded backoff between them — a 429 counts as an ordinary
// failure and never grows the backoff (Unit 6 approach: "429 = failure
// without exponential inflation"). When every step fails, exactly one
// `degraded` event fires and the routine-only action is returned.

import type { Action } from "@panthea/tools-probes-shared";
import { classifyError, type ErrorClass } from "./providers";

/**
 * The default OpenCode-arm fallback order (ADR-0005): Go's free models
 * first (verified reachable with the shared credential), then Go's paid
 * model, then local Ollama, then routine-only. Callers building the actual
 * {@link FallbackStep} closures (which need live model handles) should name
 * their steps to match this order so the trace in a README/log lines up
 * with the documented sequence.
 */
export const DEFAULT_STEP_ORDER = [
  "go-free:space-bunny-free",
  "go-free:longcat-2.5-preview-free",
  "go-paid:mimo-v2.5",
  "ollama",
] as const;

/** Production default: at most one retry (two attempts total) per step. */
export const MAX_ATTEMPTS_PER_STEP = 2;
/** Production default backoff between attempts of the same step. Flat — never doubled. */
export const RETRY_BACKOFF_MS = 25;

export interface FallbackStep {
  readonly name: string;
  readonly attempt: () => Promise<Action>;
}

export interface FallbackConfig {
  /** Overrides {@link MAX_ATTEMPTS_PER_STEP} (tests only — production uses the default). */
  readonly maxAttemptsPerStep?: number;
  /** Overrides {@link RETRY_BACKOFF_MS} (tests only — production uses the default). */
  readonly retryBackoffMs?: number;
}

export interface FallbackTraceEntry {
  readonly step: string;
  readonly attempts: number;
  readonly outcome: "success" | "failed";
  readonly errorClass?: ErrorClass;
}

export interface DegradedEvent {
  readonly type: "degraded";
  readonly action: Action;
  readonly trace: readonly FallbackTraceEntry[];
}

export interface FallbackResult {
  readonly action: Action;
  readonly trace: readonly FallbackTraceEntry[];
  readonly degraded: boolean;
}

export const ROUTINE_ONLY_ACTION: Action = {
  kind: "idle",
  reason: "providers-unavailable",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type StepOutcome =
  | {
      readonly outcome: "success";
      readonly action: Action;
      readonly attempts: number;
    }
  | {
      readonly outcome: "failed";
      readonly attempts: number;
      readonly errorClass: ErrorClass;
    };

async function runStepWithRetries(
  step: FallbackStep,
  maxAttempts: number,
  backoffMs: number,
): Promise<StepOutcome> {
  let lastErrorClass: ErrorClass = "unknown";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const action = await step.attempt();
      return { outcome: "success", action, attempts: attempt };
    } catch (error) {
      lastErrorClass = classifyError(error);
      if (attempt < maxAttempts) {
        // Flat backoff regardless of error class (including 429) — no
        // exponential growth, so a rate-limited step doesn't inflate the
        // chain's total latency.
        await sleep(backoffMs);
      }
    }
  }
  return {
    outcome: "failed",
    attempts: maxAttempts,
    errorClass: lastErrorClass,
  };
}

/**
 * Runs `steps` in order, applying bounded flat-backoff retries to each.
 * Returns the first successful action; if every step fails, calls
 * `onDegraded` exactly once and returns the routine-only action.
 */
export async function runFallback(
  steps: readonly FallbackStep[],
  onDegraded?: (event: DegradedEvent) => void,
  config: FallbackConfig = {},
): Promise<FallbackResult> {
  const maxAttempts = config.maxAttemptsPerStep ?? MAX_ATTEMPTS_PER_STEP;
  const backoffMs = config.retryBackoffMs ?? RETRY_BACKOFF_MS;
  const trace: FallbackTraceEntry[] = [];

  for (const step of steps) {
    const result = await runStepWithRetries(step, maxAttempts, backoffMs);
    if (result.outcome === "success") {
      trace.push({
        step: step.name,
        attempts: result.attempts,
        outcome: "success",
      });
      return { action: result.action, trace, degraded: false };
    }
    trace.push({
      step: step.name,
      attempts: result.attempts,
      outcome: "failed",
      errorClass: result.errorClass,
    });
  }

  const event: DegradedEvent = {
    type: "degraded",
    action: ROUTINE_ONLY_ACTION,
    trace,
  };
  onDegraded?.(event);
  return { action: ROUTINE_ONLY_ACTION, trace, degraded: true };
}
