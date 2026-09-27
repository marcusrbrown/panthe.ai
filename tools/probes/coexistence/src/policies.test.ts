import { expect, test } from "bun:test";
import type { CandidateResult, ScenarioMetrics } from "./policies";
import { choosePolicy, computePenalty } from "./policies";

const baseline: ScenarioMetrics = {
  llmP50Ms: 700,
  llmP95Ms: 1500,
  imagesCompleted: 0,
  rendererFrameP95Ms: 17,
  peakSwapUsedMiB: 7000,
  minFreeMiB: 900,
  processDied: false,
};

function candidate(
  overrides: Partial<CandidateResult> & Pick<CandidateResult, "policy">,
): CandidateResult {
  return {
    llmP50Ms: 750,
    llmP95Ms: 1600,
    imagesCompleted: 4,
    rendererFrameP95Ms: 18,
    peakSwapUsedMiB: 7200,
    minFreeMiB: 850,
    processDied: false,
    ...overrides,
  };
}

test("computePenalty is the fractional latency delta over baseline", () => {
  expect(computePenalty(1500, 1000)).toBeCloseTo(0.5);
  expect(computePenalty(1000, 1000)).toBe(0);
  expect(computePenalty(900, 1000)).toBeCloseTo(-0.1);
});

test("computePenalty never divides by zero when baseline p95 was 0ms", () => {
  expect(computePenalty(0, 0)).toBe(0);
  expect(computePenalty(500, 0)).toBe(Number.POSITIVE_INFINITY);
});

test("unconstrained wins when its penalty is small and it completes images", () => {
  const decision = choosePolicy({
    baseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 1650,
        imagesCompleted: 5,
      }), // +10%
      candidate({
        policy: "mutex",
        llmP95Ms: 4200,
        imagesCompleted: 3,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 3072,
        llmP95Ms: 1700,
        imagesCompleted: 4,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 5120,
        llmP95Ms: 1650,
        imagesCompleted: 3,
      }),
    ],
  });
  expect(decision.policy).toBe("unconstrained");
  expect(decision.thresholdMiB).toBeUndefined();
  expect(decision.rationale).toContain("unconstrained");
});

test("admission-queue wins when unconstrained blows p95 but a threshold doesn't", () => {
  const decision = choosePolicy({
    baseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 6000, // +300%, way over 25%
        imagesCompleted: 6,
      }),
      candidate({
        policy: "mutex",
        llmP95Ms: 5000,
        imagesCompleted: 3,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 3072,
        llmP95Ms: 1620, // +8%
        imagesCompleted: 2,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 5120,
        llmP95Ms: 1590, // +6%, slightly better penalty but fewer images
        imagesCompleted: 1,
      }),
    ],
  });
  expect(decision.policy).toBe("admission-queue");
  // Lower penalty wins the tie-break, not the lower threshold, when penalties differ.
  expect(decision.thresholdMiB).toBe(5120);
  expect(decision.rationale).toContain("admission-queue@5120MiB");
});

test("admission-queue tie-break prefers the lower (more permissive) threshold when penalties are equal", () => {
  const decision = choosePolicy({
    baseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 6000,
        imagesCompleted: 6,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 3072,
        llmP95Ms: 1650,
        imagesCompleted: 3,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 5120,
        llmP95Ms: 1650,
        imagesCompleted: 2,
      }),
    ],
  });
  expect(decision.policy).toBe("admission-queue");
  expect(decision.thresholdMiB).toBe(3072);
});

test("mutex is the fallback when unconstrained and every admission threshold fail", () => {
  const decision = choosePolicy({
    baseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 8000,
        imagesCompleted: 6,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 3072,
        llmP95Ms: 2400, // +60%
        imagesCompleted: 2,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 5120,
        llmP95Ms: 2100, // +40%
        imagesCompleted: 1,
      }),
      candidate({
        policy: "mutex",
        llmP95Ms: 4500,
        imagesCompleted: 3,
      }),
    ],
  });
  expect(decision.policy).toBe("mutex");
  expect(decision.rationale).toContain("Falling back to the global mutex");
});

test("a candidate that completes zero images is never viable, even with a tiny penalty", () => {
  const decision = choosePolicy({
    baseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 1510,
        imagesCompleted: 0,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 3072,
        llmP95Ms: 1520,
        imagesCompleted: 0,
      }),
      candidate({ policy: "mutex", llmP95Ms: 3000, imagesCompleted: 2 }),
    ],
  });
  expect(decision.policy).toBe("mutex");
});

test("a candidate whose process died is never viable regardless of latency", () => {
  const decision = choosePolicy({
    baseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 1510,
        imagesCompleted: 5,
        processDied: true,
      }),
      candidate({ policy: "mutex", llmP95Ms: 3200, imagesCompleted: 2 }),
    ],
  });
  expect(decision.policy).toBe("mutex");
});
