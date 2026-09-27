import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCaptureFilterPlan,
  type CaptureDiagnostics,
  type CaptureHandle,
  type CaptureStopDiagnostics,
  type CaptureSummary,
  classifyCaptureLines,
  type DnsResolver,
  type OfflineRunSummary,
  type ProcessProbe,
  resolveTcpdumpPid,
  routeAction,
  runControlCapture,
  runOfflineWithCapture,
  summarizeCapture,
} from "./offline";

const NOT_SILENT_SUMMARY: CaptureSummary = {
  status: "not-silent",
  totalPackets: 2,
  providerPackets: 1,
  providerDnsLookups: 0,
  sampleLines: ["1758901234.000000 IP 10.0.0.5.51234 > 2.2.2.2.443: Flags [S]"],
};

const OK_RUN_SUMMARY: OfflineRunSummary = {
  requestCount: 3,
  hostedClientConstructions: 0,
  allRoutineOnly: true,
};

const SILENT_SUMMARY: CaptureSummary = { status: "silent", totalPackets: 4 };

/** Deterministic stand-in for the diagnostics a real `stop()` would attach — tests below assert against this fixed shape rather than the real `pgrep`/`ps` calls. */
function fakeDiagnostics(exitCode: number | null): CaptureStopDiagnostics {
  return {
    resolvedPids: [4242],
    stopPath: "sigint-child",
    tcpdumpExitCode: exitCode,
    stderrTail: "",
  };
}

/** What `runOfflineWithCapture` actually attaches to a result's `diagnostics` — the stop diagnostics plus the orchestration-level fields it always merges in (grace period, filter plan — undefined here since these tests never pass one). */
function expectedCaptureDiagnostics(
  exitCode: number | null,
  graceMs: number,
): CaptureDiagnostics {
  return {
    ...fakeDiagnostics(exitCode),
    graceMs,
    filter: undefined,
    resolvedProviderIps: undefined,
    filterResolutionFailed: undefined,
  };
}

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
      const exitCode = options.exitCode ?? 0;
      return { exitCode, stderr: "", diagnostics: fakeDiagnostics(exitCode) };
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
      graceMs: 0,
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
    // The real stop diagnostics (pid/path/exit-code) are always merged in,
    // even when summarizeCapture's own return value doesn't know about them.
    expect(result.capture).toEqual({
      ...SILENT_SUMMARY,
      diagnostics: expectedCaptureDiagnostics(0, 0),
    });
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
      graceMs: 0,
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
      graceMs: 0,
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
      diagnostics: expectedCaptureDiagnostics(0, 0),
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
        graceMs: 0,
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
      graceMs: 0,
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
      diagnostics: expectedCaptureDiagnostics(0, 0),
    });
  });

  test("a non-zero tcpdump exit code is reported as capture-failed without ever reading the pcap", async () => {
    const order: string[] = [];
    let summarizeCalled = false;

    const result = await runOfflineWithCapture({
      pcapPath: "/tmp/fake.pcap",
      graceMs: 0,
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

  test("tcpdump reporting '0 packets captured' on a clean exit is reported as silent without ever reading the pcap back", async () => {
    // Reproduces the owner's Run 4 result: stopPath sigint-child (the pid
    // fix worked), tcpdump exit 0, but "0 packets captured / 96 packets
    // received by filter" — BPF received traffic but tcpdump's userspace
    // loop never processed any of it before SIGINT. A 0-byte pcap in this
    // exact shape is expected, not suspicious.
    let summarizeCalled = false;

    const result = await runOfflineWithCapture({
      pcapPath: "/tmp/fake.pcap",
      graceMs: 0,
      startCapture: () => ({
        ready: Promise.resolve(),
        async stop() {
          return {
            exitCode: 0,
            stderr:
              "0 packets captured\n96 packets received by filter\n0 packets dropped by kernel",
            diagnostics: fakeDiagnostics(0),
          };
        },
      }),
      runRequests: async () => OK_RUN_SUMMARY,
      summarizeCapture: async () => {
        summarizeCalled = true;
        return SILENT_SUMMARY;
      },
    });

    expect(summarizeCalled).toBe(false);
    expect(result.capture.status).toBe("silent");
    if (result.capture.status === "silent") {
      expect(result.capture.totalPackets).toBe(0);
    }
  });

  test("waits out the full grace period after requests finish before stopping the capture", async () => {
    const graceMs = 30;
    let requestsDoneAt = -1;
    let stopCalledAt = -1;

    await runOfflineWithCapture({
      pcapPath: "/tmp/fake.pcap",
      graceMs,
      startCapture: () => ({
        ready: Promise.resolve(),
        async stop() {
          stopCalledAt = performance.now();
          return { exitCode: 0, stderr: "", diagnostics: fakeDiagnostics(0) };
        },
      }),
      runRequests: async () => {
        requestsDoneAt = performance.now();
        return OK_RUN_SUMMARY;
      },
      summarizeCapture: async () => SILENT_SUMMARY,
    });

    expect(requestsDoneAt).toBeGreaterThan(0);
    expect(stopCalledAt).toBeGreaterThanOrEqual(requestsDoneAt + graceMs - 5);
  });
});

describe("runControlCapture (positive control — fake capture/request deps, no sudo)", () => {
  test("a not-silent control capture is returned as-is — proof stands", async () => {
    const order: string[] = [];
    let requestSent = false;

    const result = await runControlCapture({
      pcapPath: "/tmp/control.pcap",
      graceMs: 0,
      startCapture: () => fakeHandle(order),
      sendControlRequest: async () => {
        requestSent = true;
        order.push("request");
      },
      summarizeCapture: async () => NOT_SILENT_SUMMARY,
    });

    expect(requestSent).toBe(true);
    expect(order).toEqual(["request", "stop"]);
    expect(result.capture).toEqual({
      ...NOT_SILENT_SUMMARY,
      diagnostics: expectedCaptureDiagnostics(0, 0),
    });
  });

  test("a silent control capture is returned as-is — caller is responsible for treating this as control-failed", async () => {
    const result = await runControlCapture({
      pcapPath: "/tmp/control.pcap",
      graceMs: 0,
      startCapture: () => fakeHandle([]),
      sendControlRequest: async () => undefined,
      summarizeCapture: async () => SILENT_SUMMARY,
    });

    expect(result.capture.status).toBe("silent");
  });

  test("the control request runs strictly between start and stop, same as the offline request window", async () => {
    const order: string[] = [];

    await runControlCapture({
      pcapPath: "/tmp/control.pcap",
      graceMs: 0,
      startCapture: (pcapPath) => {
        order.push(`start:${pcapPath}`);
        return fakeHandle(order);
      },
      sendControlRequest: async () => {
        order.push("request");
      },
      summarizeCapture: async () => {
        order.push("summarize");
        return NOT_SILENT_SUMMARY;
      },
    });

    expect(order).toEqual([
      "start:/tmp/control.pcap",
      "request",
      "stop",
      "summarize",
    ]);
  });

  test("a request that internally catches its own error still completes the capture window (no throw escapes)", async () => {
    const order: string[] = [];

    const result = await runControlCapture({
      pcapPath: "/tmp/control.pcap",
      graceMs: 0,
      startCapture: () => fakeHandle(order),
      sendControlRequest: async () => {
        // Mirrors run.ts's real sendControlRequest: it catches its own
        // errors and records them elsewhere rather than throwing, so a
        // request-level failure (e.g. Go not configured) never skips
        // stop()/summarize().
        order.push("request-failed-internally");
      },
      summarizeCapture: async () => SILENT_SUMMARY,
    });

    expect(order).toEqual(["request-failed-internally", "stop"]);
    expect(result.capture.status).toBe("silent");
  });
});

describe("summarizeCapture (real pcap read-back — no fakes, no sudo)", () => {
  test("a 0-byte pcap file left behind after a clean tcpdump exit is still reported as capture-failed, never silent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-matrix-offline-"));
    const pcapPath = join(dir, "empty.pcap");
    writeFileSync(pcapPath, "");
    try {
      const result = await summarizeCapture(pcapPath, {
        // Short poll window: the file genuinely never grows in this test,
        // so this only needs to prove the poll eventually gives up rather
        // than spend the real 2s default on every test run.
        flushPollTimeoutMs: 50,
        flushPollIntervalMs: 10,
      });
      expect(result.status).toBe("capture-failed");
      if (result.status === "capture-failed") {
        expect(result.reason).toContain("0 bytes");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing pcap file is reported as capture-failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-matrix-offline-"));
    const pcapPath = join(dir, "does-not-exist.pcap");
    try {
      const result = await summarizeCapture(pcapPath, {
        flushPollTimeoutMs: 50,
        flushPollIntervalMs: 10,
      });
      expect(result).toEqual({
        status: "capture-failed",
        reason: `pcap file not found at ${pcapPath}`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("classifyCaptureLines (packet classification — pure function, no tcpdump/pcap needed)", () => {
  test("a line mentioning a resolved provider IP counts as a provider packet", () => {
    const result = classifyCaptureLines(
      ["1758901234.000000 IP 10.0.0.5.51234 > 2.2.2.2.443: Flags [S]"],
      ["2.2.2.2"],
      [],
      "",
    );
    expect(result).toEqual({ providerPackets: 1, providerDnsLookups: 0 });
  });

  test("a DNS line whose payload names a provider host counts as a provider DNS lookup", () => {
    const result = classifyCaptureLines(
      [
        "1758901234.000000 IP 10.0.0.5.51234 > 8.8.8.8.53: 12345+ A? api.openai.com.",
      ],
      [],
      ["api.openai.com", "api.anthropic.com"],
      "...12345+ A? api.openai.com. ...",
    );
    expect(result).toEqual({ providerPackets: 0, providerDnsLookups: 1 });
  });

  test("a DNS line for an unrelated hostname does not count as a provider DNS lookup", () => {
    const result = classifyCaptureLines(
      [
        "1758901234.000000 IP 10.0.0.5.51234 > 8.8.8.8.53: 12345+ A? example.com.",
      ],
      [],
      ["api.openai.com"],
      "...12345+ A? example.com. ...",
    );
    expect(result).toEqual({ providerPackets: 0, providerDnsLookups: 0 });
  });

  test("a loopback-only line never counts as a provider packet (provider IPs never include loopback)", () => {
    const result = classifyCaptureLines(
      ["1758901234.000000 IP 127.0.0.1.51234 > 127.0.0.1.6000: Flags [S]"],
      ["2.2.2.2"],
      [],
      "",
    );
    expect(result).toEqual({ providerPackets: 0, providerDnsLookups: 0 });
  });
});

describe("buildCaptureFilterPlan (BPF filter construction — fake DNS resolver, no real lookups)", () => {
  test("builds a host-scoped filter from resolved provider IPs, with a port-53 DNS fallback clause always present", async () => {
    const resolver: DnsResolver = {
      lookupAll: async (hostname) => {
        if (hostname === "opencode.ai") return ["1.1.1.1"];
        if (hostname === "api.openai.com") return ["2.2.2.2", "2001:db8::2"];
        return [];
      },
    };

    const plan = await buildCaptureFilterPlan(
      ["opencode.ai", "api.openai.com", "api.anthropic.com"],
      resolver,
    );

    expect(plan.resolutionFailed).toBe(false);
    expect(plan.allResolvedIps).toEqual(["1.1.1.1", "2.2.2.2", "2001:db8::2"]);
    expect(plan.filter).toBe(
      "(host 1.1.1.1 or host 2.2.2.2 or host 2001:db8::2) or port 53",
    );
  });

  test("excludes loopback addresses from the host clause even if a resolution returns one", async () => {
    const resolver: DnsResolver = {
      lookupAll: async () => ["127.0.0.1", "::1", "9.9.9.9"],
    };
    const plan = await buildCaptureFilterPlan(["example.test"], resolver);
    expect(plan.allResolvedIps).toEqual(["9.9.9.9"]);
    expect(plan.filter).toBe("(host 9.9.9.9) or port 53");
  });

  test("falls back to a DNS-only filter when every host fails to resolve", async () => {
    const resolver: DnsResolver = { lookupAll: async () => [] };
    const plan = await buildCaptureFilterPlan(["unreachable.test"], resolver);
    expect(plan.resolutionFailed).toBe(true);
    expect(plan.allResolvedIps).toEqual([]);
    expect(plan.filter).toBe("port 53");
  });
});

describe("resolveTcpdumpPid (pid resolution — fake pgrep/ps, no real sudo)", () => {
  test("selects the real tcpdump pid even when another candidate's own command line still shows the full sudo-wrapped invocation (and the exact target path)", async () => {
    const pcapPath = "/tmp/offline.pcap";
    const probe: ProcessProbe = {
      pgrepExact: async (name) => (name === "tcpdump" ? [111, 222] : []),
      commandLineForPid: async (pid) => {
        // Simulates the exact failure mode diagnosed on the owner's
        // machine: a candidate whose reported command line is still the
        // sudo-wrapped invocation (mentioning our path too) — a naive
        // substring-only match would pick this one and signal nothing.
        if (pid === 111) {
          return `sudo -n tcpdump -i any -U -Z mrbrown -w ${pcapPath}`;
        }
        if (pid === 222) {
          return `tcpdump -i any -U -Z mrbrown -w ${pcapPath}`;
        }
        return undefined;
      },
    };

    expect(await resolveTcpdumpPid(pcapPath, probe)).toEqual([222]);
  });

  test("a single pgrep match short-circuits without ever consulting ps", async () => {
    let commandLineCalled = false;
    const probe: ProcessProbe = {
      pgrepExact: async () => [999],
      commandLineForPid: async () => {
        commandLineCalled = true;
        return undefined;
      },
    };

    expect(await resolveTcpdumpPid("/tmp/offline.pcap", probe)).toEqual([999]);
    expect(commandLineCalled).toBe(false);
  });

  test("returns every genuine tcpdump pid that matches the exact -w path when several are running concurrently", async () => {
    const pcapPath = "/tmp/offline.pcap";
    const probe: ProcessProbe = {
      pgrepExact: async () => [10, 20],
      commandLineForPid: async (pid) =>
        `tcpdump -i any -w ${pcapPath} (pid ${pid})`,
    };

    const resolved = [...(await resolveTcpdumpPid(pcapPath, probe))].sort(
      (a, b) => a - b,
    );
    expect(resolved).toEqual([10, 20]);
  });

  test("no pgrep matches resolves to an empty pid list, never a guess", async () => {
    const probe: ProcessProbe = {
      pgrepExact: async () => [],
      commandLineForPid: async () => undefined,
    };

    expect(await resolveTcpdumpPid("/tmp/offline.pcap", probe)).toEqual([]);
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
