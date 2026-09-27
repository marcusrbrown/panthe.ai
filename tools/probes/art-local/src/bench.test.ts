// Regression tests for the sd.cpp cancellation-outcome mapping (see
// runSdCppSignalCancel / mapIdleOutcomeToCancellationResult in bench.ts):
// only a confirmed process-gone reading counts as the process-kill proxy
// this probe uses when the sd-server build cannot cancel an in-flight job
// over HTTP. A momentary low-CPU reading or an outright timeout must never
// be reported as "supported" — that would misrepresent an unconfirmed
// measurement as a real cancellation.

import { describe, expect, it } from "bun:test";
import {
  mapIdleOutcomeToCancellationResult,
  runSdCppSignalCancel,
} from "./bench";

describe("mapIdleOutcomeToCancellationResult", () => {
  it("reports 'terminated' (supported) only when the process is confirmed gone", () => {
    const result = mapIdleOutcomeToCancellationResult(
      { idleAfterMs: 12, reason: "process-gone" },
      12,
      "base note",
    );
    expect(result.supported).toBe(true);
    expect(result.outcome).toBe("terminated");
    expect(result.cancelToIdleMs).toBe(12);
  });

  it("reports 'idle-cpu' (not supported) when the process is still alive with low CPU", () => {
    const result = mapIdleOutcomeToCancellationResult(
      { idleAfterMs: 250, reason: "cpu-below-threshold" },
      250,
      "base note",
    );
    expect(result.supported).toBe(false);
    expect(result.outcome).toBe("idle-cpu");
    expect(result.cancelToIdleMs).toBeUndefined();
  });

  it("reports 'timeout' (not supported) when neither termination nor idle CPU was observed", () => {
    const result = mapIdleOutcomeToCancellationResult(
      { idleAfterMs: 30_000, reason: "timeout" },
      30_000,
      "base note",
    );
    expect(result.supported).toBe(false);
    expect(result.outcome).toBe("timeout");
    expect(result.cancelToIdleMs).toBeUndefined();
  });
});

describe("runSdCppSignalCancel", () => {
  it("does not report support when a fake waitForIdle returns timeout", async () => {
    let killed: readonly [number, string] | undefined;
    const result = await runSdCppSignalCancel(
      12345,
      1_000,
      { cancelQueued: true, cancelGenerating: false },
      {
        killProcess: (pid, signal) => {
          killed = [pid, signal];
        },
        waitForIdleImpl: async () => ({
          idleAfterMs: 30_000,
          reason: "timeout",
        }),
      },
    );
    expect(killed).toEqual([12345, "SIGTERM"]);
    expect(result.supported).toBe(false);
    expect(result.outcome).toBe("timeout");
    expect(result.cancelToIdleMs).toBeUndefined();
  });

  it("reports 'terminated' support when a fake waitForIdle confirms the process is gone", async () => {
    const result = await runSdCppSignalCancel(
      12345,
      1_000,
      { cancelQueued: true, cancelGenerating: false },
      {
        killProcess: () => {},
        waitForIdleImpl: async () => ({
          idleAfterMs: 8,
          reason: "process-gone",
        }),
      },
    );
    expect(result.supported).toBe(true);
    expect(result.outcome).toBe("terminated");
    expect(result.cancelToIdleMs).toBeGreaterThanOrEqual(0);
  });

  it("is unsupported without a serverPid (no process to signal)", async () => {
    const result = await runSdCppSignalCancel(undefined, 1_000, {
      cancelQueued: true,
      cancelGenerating: false,
    });
    expect(result.supported).toBe(false);
    expect(result.outcome).toBe("unsupported");
  });

  it("is unsupported when sending the signal itself throws", async () => {
    const result = await runSdCppSignalCancel(
      12345,
      1_000,
      { cancelQueued: true, cancelGenerating: false },
      {
        killProcess: () => {
          throw new Error("ESRCH: no such process");
        },
      },
    );
    expect(result.supported).toBe(false);
    expect(result.outcome).toBe("unsupported");
    expect(result.note).toContain("ESRCH");
  });
});
