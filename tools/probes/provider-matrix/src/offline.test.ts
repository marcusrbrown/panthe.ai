import { describe, expect, test } from "bun:test";
import {
  type CaptureHandle,
  type CaptureSummary,
  type OfflineRunSummary,
  routeAction,
  runOfflineWithCapture,
} from "./offline";

const OK_RUN_SUMMARY: OfflineRunSummary = {
  requestCount: 3,
  hostedClientConstructions: 0,
  allRoutineOnly: true,
};

const SILENT_SUMMARY: CaptureSummary = { status: "silent", totalPackets: 4 };

function fakeHandle(
  order: string[],
  options: {
    readonly exitCode?: number | null;
    readonly ready?: Promise<void>;
  } = {},
): CaptureHandle {
  return {
    ready: options.ready ?? Promise.resolve(),
    async stop() {
      order.push("stop");
      return { exitCode: options.exitCode ?? 0, stderr: "" };
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runOfflineWithCapture (CLI-level, injectable fake capture — no sudo)", () => {
  test("starts the capture before the first request and stops it after the last", async () => {
    const order: string[] = [];
    let summarizeCalledAt = -1;

    const result = await runOfflineWithCapture({
      pcapPath: "/tmp/fake.pcap",
      startCapture: (pcapPath) => {
        order.push(`start:${pcapPath}`);
        return fakeHandle(order);
      },
      runRequests: async () => {
        for (let i = 0; i < OK_RUN_SUMMARY.requestCount; i += 1) {
          order.push(`request:${i}`);
        }
        return OK_RUN_SUMMARY;
      },
      summarizeCapture: async () => {
        summarizeCalledAt = order.length;
        order.push("summarize");
        return SILENT_SUMMARY;
      },
    });

    expect(order[0]).toBe("start:/tmp/fake.pcap");
    const stopIndex = order.indexOf("stop");
    const lastRequestIndex = order.lastIndexOf("request:2");
    expect(stopIndex).toBeGreaterThan(lastRequestIndex);
    // Every request happened strictly between start and stop.
    for (let i = 0; i < OK_RUN_SUMMARY.requestCount; i += 1) {
      const requestIndex = order.indexOf(`request:${i}`);
      expect(requestIndex).toBeGreaterThan(0);
      expect(requestIndex).toBeLessThan(stopIndex);
    }
    // Summarize only runs after the capture has stopped.
    expect(summarizeCalledAt).toBeGreaterThan(stopIndex);
    expect(result.capture).toEqual(SILENT_SUMMARY);
    expect(result.routerGuarantee).toEqual(OK_RUN_SUMMARY);
  });

  test("waits for readiness before running the first request, even when readiness resolves after a delay", async () => {
    let readyResolvedAt = -1;
    let firstRequestAt = -1;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const readyDelayPromise = delay(20).then(() => {
      readyResolvedAt = performance.now();
      resolveReady();
    });

    const result = await runOfflineWithCapture({
      pcapPath: "/tmp/fake.pcap",
      startCapture: () => fakeHandle([], { ready }),
      runRequests: async () => {
        firstRequestAt = performance.now();
        return OK_RUN_SUMMARY;
      },
      summarizeCapture: async () => SILENT_SUMMARY,
    });

    await readyDelayPromise;
    expect(readyResolvedAt).toBeGreaterThan(0);
    expect(firstRequestAt).toBeGreaterThan(readyResolvedAt);
    expect(result.routerGuarantee).toEqual(OK_RUN_SUMMARY);
  });

  test("a rejecting readiness yields capture-failed and runs zero requests", async () => {
    const order: string[] = [];
    let runRequestsCalled = false;

    const result = await runOfflineWithCapture({
      pcapPath: "/tmp/fake.pcap",
      startCapture: () =>
        fakeHandle(order, {
          ready: Promise.reject(new Error("capture did not become ready")),
        }),
      runRequests: async () => {
        runRequestsCalled = true;
        return OK_RUN_SUMMARY;
      },
      summarizeCapture: async () => SILENT_SUMMARY,
    });

    expect(runRequestsCalled).toBe(false);
    expect(result.routerGuarantee.requestCount).toBe(0);
    expect(result.capture).toEqual({
      status: "capture-failed",
      reason: "capture did not become ready",
    });
    // Cleanup (stop) still runs even though readiness never arrived.
    expect(order).toContain("stop");
  });

  test("still stops the capture when the request run throws (finally guarantee)", async () => {
    const order: string[] = [];
    const failure = new Error("simulated request-run failure");

    await expect(
      runOfflineWithCapture({
        pcapPath: "/tmp/fake.pcap",
        startCapture: () => fakeHandle(order),
        runRequests: async () => {
          order.push("request");
          throw failure;
        },
        summarizeCapture: async () => {
          order.push("summarize");
          return SILENT_SUMMARY;
        },
      }),
    ).rejects.toThrow(failure);

    expect(order).toEqual(["request", "stop"]);
    // A run that never got to stop cleanly must never reach summarize.
    expect(order).not.toContain("summarize");
  });

  test("a failing capture read is never reported as silent", async () => {
    const order: string[] = [];

    const result = await runOfflineWithCapture({
      pcapPath: "/tmp/fake.pcap",
      startCapture: () => fakeHandle(order),
      runRequests: async () => OK_RUN_SUMMARY,
      summarizeCapture: async () => {
        order.push("summarize");
        return { status: "capture-failed", reason: "pcap file not found" };
      },
    });

    expect(result.capture.status).not.toBe("silent");
    expect(result.capture).toEqual({
      status: "capture-failed",
      reason: "pcap file not found",
    });
  });

  test("a non-zero tcpdump exit code is reported as capture-failed without ever reading the pcap", async () => {
    const order: string[] = [];
    let summarizeCalled = false;

    const result = await runOfflineWithCapture({
      pcapPath: "/tmp/fake.pcap",
      startCapture: () => fakeHandle(order, { exitCode: 1 }),
      runRequests: async () => OK_RUN_SUMMARY,
      summarizeCapture: async () => {
        summarizeCalled = true;
        return SILENT_SUMMARY;
      },
    });

    expect(summarizeCalled).toBe(false);
    expect(result.capture.status).toBe("capture-failed");
    if (result.capture.status === "capture-failed") {
      expect(result.capture.reason).toContain("1");
    }
  });
});

describe("routeAction (offline router guarantee)", () => {
  test("never constructs the hosted client when offlineMode is true", async () => {
    let constructions = 0;
    const action = await routeAction({
      offlineMode: true,
      createHostedClient: () => {
        constructions += 1;
        return { client: true };
      },
      localAction: async () => ({ kind: "idle", reason: "offline" }),
    });
    expect(constructions).toBe(0);
    expect(action).toEqual({ kind: "idle", reason: "offline" });
  });

  test("constructs the hosted client when offlineMode is false", async () => {
    let constructions = 0;
    await routeAction({
      offlineMode: false,
      createHostedClient: () => {
        constructions += 1;
        return { client: true };
      },
      localAction: async () => ({ kind: "idle", reason: "online" }),
    });
    expect(constructions).toBe(1);
  });
});
