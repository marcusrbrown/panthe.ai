import { expect, test } from "bun:test";
import type { CandidateResult, ScenarioMetrics } from "./policies";
import {
  choosePolicy,
  computePenalty,
  describeCandidate,
  isLlmEvaluable,
  llmEvaluabilityReason,
  RENDERER_FRAME_P95_TARGET_MS,
} from "./policies";

const baseline: ScenarioMetrics = {
  llmP50Ms: 700,
  llmP95Ms: 1500,
  llmSuccessCount: 60,
  llmErrorCount: 0,
  llmSampleCount: 60,
  imagesCompleted: 0,
  rendererFrameP95Ms: 17,
  frameEvaluable: true,
  peakSwapUsedMiB: 7000,
  minFreeMiB: 900,
  processDied: false,
  historical: false,
};

function candidate(
  overrides: Partial<CandidateResult> & Pick<CandidateResult, "policy">,
): CandidateResult {
  return {
    llmP50Ms: 750,
    llmP95Ms: 1600,
    llmSuccessCount: 55,
    llmErrorCount: 1,
    llmSampleCount: 56,
    imagesCompleted: 4,
    rendererFrameP95Ms: 18,
    frameEvaluable: true,
    peakSwapUsedMiB: 7200,
    minFreeMiB: 850,
    processDied: false,
    historical: false,
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

test("computePenalty is undefined when either side is undefined (not evaluable)", () => {
  expect(computePenalty(undefined, 1000)).toBeUndefined();
  expect(computePenalty(1000, undefined)).toBeUndefined();
  expect(computePenalty(undefined, undefined)).toBeUndefined();
});

test("llmEvaluabilityReason never returns an empty string for genuinely missing counts (regression: historical data with the keys absent, not just zeroed)", () => {
  // Simulates a merged historical candidate loaded from an older
  // results/summary.json schema that never had these fields —
  // JSON.parse gives back an object where the keys are truly absent, not
  // present-and-zero, so `undefined` flows through despite the static
  // `ScenarioMetrics` type.
  const historical = {
    ...baseline,
    llmSuccessCount: undefined,
    llmErrorCount: undefined,
    llmSampleCount: undefined,
  } as ScenarioMetrics;
  expect(isLlmEvaluable(historical)).toBe(false);
  const reason = llmEvaluabilityReason(historical);
  expect(reason).not.toBe("");
  expect(reason).toContain("counts unavailable");
});

test("isLlmEvaluable requires >=20 successes and <=5% error rate", () => {
  expect(
    isLlmEvaluable({ ...baseline, llmSuccessCount: 60, llmSampleCount: 60 }),
  ).toBe(true);
  expect(
    isLlmEvaluable({ ...baseline, llmSuccessCount: 19, llmSampleCount: 19 }),
  ).toBe(false);
  expect(
    isLlmEvaluable({
      ...baseline,
      llmSuccessCount: 90,
      llmErrorCount: 10,
      llmSampleCount: 100,
    }),
  ).toBe(false); // 10% error rate
  expect(isLlmEvaluable({ ...baseline, llmSampleCount: 0 })).toBe(false);
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

test("no viable candidate yields inconclusive, never a silent mutex default", () => {
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
        llmP95Ms: 4500, // +200%, also fails
        imagesCompleted: 3,
      }),
    ],
  });
  expect(decision.policy).toBe("inconclusive");
  expect(decision.policy).not.toBe("mutex");
  expect(decision.rationale).toContain("Further measurement is needed");
  // Every candidate's own numbers are still stated, not silently dropped.
  expect(decision.rationale).toContain("mutex");
  expect(decision.rationale).toContain("admission-queue@3072MiB");
  expect(decision.rationale).toContain("admission-queue@5120MiB");
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
      candidate({
        policy: "mutex",
        llmP95Ms: 3000, // +100%, fails independently too
        imagesCompleted: 2,
      }),
    ],
  });
  expect(decision.policy).toBe("inconclusive");
});

test("a candidate whose process died is never selected, even if another candidate would otherwise lose on latency alone", () => {
  const decision = choosePolicy({
    baseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 1510, // best raw penalty of the two
        imagesCompleted: 5,
        processDied: true,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 3072,
        llmP95Ms: 1700, // clears the bar on its own
        imagesCompleted: 3,
      }),
    ],
  });
  expect(decision.policy).toBe("admission-queue");
  expect(decision.thresholdMiB).toBe(3072);
});

test("dead-process candidate alone (no viable alternative) yields inconclusive, not a fallback pick", () => {
  const decision = choosePolicy({
    baseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 1510,
        imagesCompleted: 5,
        processDied: true,
      }),
      candidate({
        policy: "mutex",
        llmP95Ms: 3200, // fails independently
        imagesCompleted: 2,
      }),
    ],
  });
  expect(decision.policy).toBe("inconclusive");
});

test("a candidate with too few successful requests is not-evaluable and never selected, even with a great-looking penalty", () => {
  const decision = choosePolicy({
    baseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 1000, // looks like a huge win over baseline...
        llmSuccessCount: 5, // ...but only 5 requests actually succeeded
        llmErrorCount: 0,
        llmSampleCount: 5,
        imagesCompleted: 5,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 3072,
        llmP95Ms: 1700,
        imagesCompleted: 3,
      }),
    ],
  });
  expect(decision.policy).toBe("admission-queue");
  expect(decision.rationale).toContain("not-evaluable");
});

test("a candidate with too high an error rate is not-evaluable and never selected", () => {
  const decision = choosePolicy({
    baseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 1000,
        llmSuccessCount: 40,
        llmErrorCount: 10, // 20% error rate
        llmSampleCount: 50,
        imagesCompleted: 5,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 3072,
        llmP95Ms: 1700,
        imagesCompleted: 3,
      }),
    ],
  });
  expect(decision.policy).toBe("admission-queue");
});

test("an empty (zero-sample) LLM result never yields a p95=0 false reading and is not-evaluable", () => {
  const emptyCandidate = candidate({
    policy: "unconstrained",
    llmP50Ms: undefined,
    llmP95Ms: undefined,
    llmSuccessCount: 0,
    llmErrorCount: 0,
    llmSampleCount: 0,
    imagesCompleted: 3,
  });
  expect(isLlmEvaluable(emptyCandidate)).toBe(false);
  const decision = choosePolicy({ baseline, candidates: [emptyCandidate] });
  expect(decision.policy).toBe("inconclusive");
  expect(decision.rationale).toContain("not-evaluable");
});

test("a baseline that isn't evaluable makes the whole decision inconclusive, regardless of candidate data", () => {
  const notEvaluableBaseline: ScenarioMetrics = {
    ...baseline,
    llmSuccessCount: 3,
    llmSampleCount: 3,
  };
  const decision = choosePolicy({
    baseline: notEvaluableBaseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 1000,
        imagesCompleted: 5,
      }),
    ],
  });
  expect(decision.policy).toBe("inconclusive");
  expect(decision.rationale).toContain("Baseline LLM data is not evaluable");
});

test("a missing post-window candidate frame dump is reported as not evaluable and never fabricated as a passing number, and blocks that candidate's selection", () => {
  const candidateNoFrame = candidate({
    policy: "unconstrained",
    llmP95Ms: 1550,
    imagesCompleted: 5,
    rendererFrameP95Ms: undefined,
    frameEvaluable: false,
  });
  const description = describeCandidate(candidateNoFrame, baseline);
  expect(description).toContain("frame p95 not evaluable");
  expect(description).not.toMatch(/frame p95 \d/);

  // Nothing without a verified post-window frame sample can be
  // recommended — this candidate is otherwise perfect (small penalty,
  // completes images, healthy process) but must still be excluded.
  const decision = choosePolicy({
    baseline,
    candidates: [candidateNoFrame],
  });
  expect(decision.policy).toBe("inconclusive");
  expect(decision.rationale).toContain("frame p95 not evaluable");
});

test("a candidate with a verified frame sample is still selected when it clears every other bar", () => {
  const decision = choosePolicy({
    baseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 1550,
        imagesCompleted: 5,
        rendererFrameP95Ms: 19,
        frameEvaluable: true,
      }),
    ],
  });
  expect(decision.policy).toBe("unconstrained");
});

test("RENDERER_FRAME_P95_TARGET_MS is the 30 FPS acceptance target (docs/product/acceptance.md)", () => {
  expect(RENDERER_FRAME_P95_TARGET_MS).toBeCloseTo(33.33, 1);
});

test("a candidate whose renderer frame p95 exceeds the 30 FPS target is not viable, even with a perfect LLM penalty and full image throughput", () => {
  const slowFrameCandidate = candidate({
    policy: "unconstrained",
    llmP95Ms: 1510, // +0.7%, would otherwise clearly win
    imagesCompleted: 5,
    rendererFrameP95Ms: 40, // well above the ~33.3ms target
    frameEvaluable: true,
  });
  const decision = choosePolicy({
    baseline,
    candidates: [slowFrameCandidate],
  });
  expect(decision.policy).toBe("inconclusive");
  expect(decision.rationale).toContain("exceeds the");
  expect(decision.rationale).toContain("30 FPS");
});

test("a candidate right at the frame target boundary is viable; just over it is not", () => {
  const atTarget = candidate({
    policy: "unconstrained",
    llmP95Ms: 1510,
    imagesCompleted: 5,
    rendererFrameP95Ms: RENDERER_FRAME_P95_TARGET_MS,
  });
  expect(choosePolicy({ baseline, candidates: [atTarget] }).policy).toBe(
    "unconstrained",
  );

  const justOver = candidate({
    policy: "unconstrained",
    llmP95Ms: 1510,
    imagesCompleted: 5,
    rendererFrameP95Ms: RENDERER_FRAME_P95_TARGET_MS + 0.1,
  });
  expect(choosePolicy({ baseline, candidates: [justOver] }).policy).toBe(
    "inconclusive",
  );
});

test("a baseline whose own renderer frame p95 exceeds the 30 FPS target makes the whole decision inconclusive — it isn't a healthy comparison basis", () => {
  const slowBaseline: ScenarioMetrics = {
    ...baseline,
    rendererFrameP95Ms: 45,
  };
  const decision = choosePolicy({
    baseline: slowBaseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 1510,
        imagesCompleted: 5,
      }),
    ],
  });
  expect(decision.policy).toBe("inconclusive");
  expect(decision.rationale).toContain("Baseline frame p95");
  expect(decision.rationale).toContain("exceeds the");
});

test("a missing baseline frame dump makes the whole decision inconclusive, regardless of how healthy every candidate looks", () => {
  const noFrameBaseline: ScenarioMetrics = {
    ...baseline,
    rendererFrameP95Ms: undefined,
    frameEvaluable: false,
  };
  const decision = choosePolicy({
    baseline: noFrameBaseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 1550,
        imagesCompleted: 5,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 3072,
        llmP95Ms: 1600,
        imagesCompleted: 4,
      }),
    ],
  });
  expect(decision.policy).toBe("inconclusive");
  expect(decision.rationale).toContain("Baseline frame p95 is not evaluable");
});

test("the mutex is evaluated under the same criteria as every other candidate and is selected when it is the only one that clears the bar", () => {
  const decision = choosePolicy({
    baseline,
    candidates: [
      candidate({
        policy: "unconstrained",
        llmP95Ms: 6000, // +300%, fails
        imagesCompleted: 6,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 3072,
        llmP95Ms: 2400, // +60%, fails
        imagesCompleted: 2,
      }),
      candidate({
        policy: "admission-queue",
        thresholdMiB: 5120,
        imagesCompleted: 0, // fails: zero images
      }),
      candidate({
        policy: "mutex",
        llmP95Ms: 1650, // +10%, clears the bar
        imagesCompleted: 3,
      }),
    ],
  });
  expect(decision.policy).toBe("mutex");
  expect(decision.rationale).toContain("Mutex cleared the");
  expect(decision.rationale).not.toContain("Falling back");
});

test("the mutex is never selected when it fails its own viability criteria, even as the last remaining candidate", () => {
  const decision = choosePolicy({
    baseline,
    candidates: [
      candidate({
        policy: "mutex",
        llmP95Ms: 23094, // +1439%, fails badly
        imagesCompleted: 8,
      }),
    ],
  });
  expect(decision.policy).toBe("inconclusive");
});
