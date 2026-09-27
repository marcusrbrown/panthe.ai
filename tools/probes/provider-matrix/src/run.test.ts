import { describe, expect, test } from "bun:test";
import { selectLiveRunPlan } from "./run";

describe("selectLiveRunPlan (live-run arm selection, no network)", () => {
  test("Go-only auth fixture selects the Go matrix and skips Zen with a clear message", () => {
    const plan = selectLiveRunPlan({
      zen: { configured: false },
      go: { configured: true },
    });

    expect(plan.runGo).toBe(true);
    expect(plan.goSkippedReason).toBeUndefined();
    expect(plan.runZen).toBe(false);
    expect(plan.zenSkippedReason).toBeDefined();
    expect(plan.zenSkippedReason).toContain("Zen");
    expect(plan.zenSkippedReason).toContain("not configured");
  });

  test("Zen-only auth fixture skips the Go matrix with a clear message", () => {
    const plan = selectLiveRunPlan({
      zen: { configured: true },
      go: { configured: false },
    });

    expect(plan.runZen).toBe(true);
    expect(plan.zenSkippedReason).toBeUndefined();
    expect(plan.runGo).toBe(false);
    expect(plan.goSkippedReason).toBeDefined();
    expect(plan.goSkippedReason).toContain("Go");
    expect(plan.goSkippedReason).toContain("not configured");
  });

  test("both configured selects both arms with no skip reasons", () => {
    const plan = selectLiveRunPlan({
      zen: { configured: true },
      go: { configured: true },
    });

    expect(plan.runZen).toBe(true);
    expect(plan.runGo).toBe(true);
    expect(plan.zenSkippedReason).toBeUndefined();
    expect(plan.goSkippedReason).toBeUndefined();
  });

  test("neither configured skips both arms with clear messages", () => {
    const plan = selectLiveRunPlan({
      zen: { configured: false },
      go: { configured: false },
    });

    expect(plan.runZen).toBe(false);
    expect(plan.runGo).toBe(false);
    expect(plan.zenSkippedReason).toBeDefined();
    expect(plan.goSkippedReason).toBeDefined();
  });
});
