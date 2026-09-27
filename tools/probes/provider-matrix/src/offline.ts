// Offline-mode proof has two halves:
//
// 1. A router-level guarantee that's fully testable without any OS
//    tooling: when offline mode is on, the router must never construct a
//    hosted provider client at all — not "construct it and don't call it",
//    construct it *never*. `routeAction` below is that guarantee.
// 2. A packet-capture proof that the process is silent on the wire, which
//    needs `sudo tcpdump`. That step needs a real elevated shell and can't
//    be faked by a weaker code review or a stubbed HTTP layer (Unit 6
//    approach). The probe owns the whole capture window itself
//    (`runOfflineWithCapture`): start tcpdump, run the requests, stop
//    tcpdump in a `finally` (even on failure), then read the pcap back —
//    never the other way around, and never trust a read it can't verify.
//    If non-interactive sudo isn't available, this module reports the
//    exact command for the owner to run instead of claiming a result it
//    can't back up.

import { statSync } from "node:fs";
import type { Action } from "@panthea/tools-probes-shared";

export interface OfflineRouterDeps<HostedClient> {
  readonly offlineMode: boolean;
  /** Never called when `offlineMode` is true — that's the guarantee under test. */
  readonly createHostedClient: () => HostedClient;
  readonly localAction: () => Promise<Action>;
}

/**
 * Routes one action request. When `offlineMode` is true, `createHostedClient`
 * is never invoked — not called-and-ignored, never called at all — and the
 * local action is returned directly.
 */
export async function routeAction<HostedClient>(
  deps: OfflineRouterDeps<HostedClient>,
): Promise<Action> {
  if (deps.offlineMode) {
    return deps.localAction();
  }
  deps.createHostedClient();
  return deps.localAction();
}

export const OFFLINE_INTERFACE = "any";

/** The exact `tcpdump` command a README/owner run should use for the capture window (manual fallback only — the probe owns this itself via `--capture`). */
export function offlineCaptureCommand(pcapPath: string): string {
  return `sudo tcpdump -i ${OFFLINE_INTERFACE} -w ${pcapPath}`;
}

/** The exact DNS-query log command for provider-hostname lookups during the capture window (advisory companion; not sudo-gated). */
export function offlineDnsLogCommand(): string {
  return `log stream --predicate 'process == "mDNSResponder"'`;
}

export type OfflineCaptureStatus =
  | { readonly status: "available" }
  | {
      readonly status: "pending-owner-run";
      readonly command: string;
      readonly reason: string;
    };

export interface SudoProbe {
  /** Returns true if `sudo -n true` succeeds (non-interactive sudo is available — e.g. after `sudo -v` primed the timestamp cache). */
  readonly nonInteractiveSudoAvailable: () => Promise<boolean>;
}

const defaultSudoProbe: SudoProbe = {
  async nonInteractiveSudoAvailable() {
    try {
      const proc = Bun.spawn(["sudo", "-n", "true"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  },
};

/**
 * Checks whether the offline packet capture can actually be run right now.
 * Never attempts an interactive sudo prompt: if non-interactive `sudo -n`
 * fails, this refuses to claim a capture and instead returns the exact
 * command the owner needs to run manually (or the `sudo -v` priming step
 * that would let the probe own the capture on the next invocation).
 */
export async function checkOfflineCaptureAvailable(
  pcapPath: string,
  sudoProbe: SudoProbe = defaultSudoProbe,
): Promise<OfflineCaptureStatus> {
  const available = await sudoProbe.nonInteractiveSudoAvailable();
  if (!available) {
    return {
      status: "pending-owner-run",
      command: offlineCaptureCommand(pcapPath),
      reason:
        "non-interactive sudo is unavailable on this machine; run `sudo -v` first to prime the sudo timestamp cache and re-run with --capture " +
        "(or run the whole command under `sudo -E` — the -E preserves $HOME so auth.json still resolves — if timestamp caching isn't available/persistent here)",
    };
  }
  return { status: "available" };
}

export interface OfflineRunSummary {
  readonly requestCount: number;
  readonly hostedClientConstructions: number;
  readonly allRoutineOnly: boolean;
}

/**
 * Runs `count` requests through {@link routeAction} with `offlineMode: true`
 * and asserts (by counting, never by trusting the caller) that the hosted
 * client factory was invoked zero times. This is the fully-testable half of
 * the offline proof; it does not touch the network itself.
 */
export async function runOfflineRequests<HostedClient>(
  count: number,
  createHostedClient: () => HostedClient,
  localAction: () => Promise<Action>,
): Promise<OfflineRunSummary> {
  let hostedClientConstructions = 0;
  const actions: Action[] = [];
  for (let index = 0; index < count; index += 1) {
    const action = await routeAction({
      offlineMode: true,
      createHostedClient: () => {
        hostedClientConstructions += 1;
        return createHostedClient();
      },
      localAction,
    });
    actions.push(action);
  }
  return {
    requestCount: count,
    hostedClientConstructions,
    allRoutineOnly: actions.every((action) => action.kind === "idle"),
  };
}

export interface CaptureStopResult {
  readonly exitCode: number | null;
  readonly stderr: string;
}

export interface CaptureHandle {
  /**
   * Resolves once tcpdump has confirmed it's actually listening (parsed
   * from its stderr "listening on ..." line) — spawning the process is not
   * the same as it being ready to see traffic. Rejects if tcpdump exits
   * before that line appears (e.g. `sudo` denied the request) or if
   * readiness doesn't arrive within the timeout.
   */
  readonly ready: Promise<void>;
  stop(): Promise<CaptureStopResult>;
}

/** tcpdump prints this once it has actually opened the interface and started capturing. */
const LISTENING_ON_PATTERN = /listening on/i;
/** How long to wait for tcpdump's readiness line before giving up. */
export const CAPTURE_READINESS_TIMEOUT_MS = 10_000;

/** Starts `sudo tcpdump` in the background, writing to `pcapPath`. Assumes {@link checkOfflineCaptureAvailable} already confirmed non-interactive sudo works. */
export function startCapture(pcapPath: string): CaptureHandle {
  const proc = Bun.spawn(
    ["sudo", "-n", "tcpdump", "-i", OFFLINE_INTERFACE, "-w", pcapPath],
    { stdout: "ignore", stderr: "pipe" },
  );

  let stderrAccumulated = "";
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (reason: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      readySettled = true;
      resolve();
    };
    rejectReady = (reason: Error) => {
      readySettled = true;
      reject(reason);
    };
  });

  const readinessTimer = setTimeout(() => {
    if (!readySettled) {
      rejectReady(
        new Error(
          `capture did not become ready within ${CAPTURE_READINESS_TIMEOUT_MS}ms`,
        ),
      );
    }
  }, CAPTURE_READINESS_TIMEOUT_MS);

  // Drain stderr as it arrives (so the child's pipe never backs up while
  // the capture window is open) and watch for the readiness line.
  const stderrDrained = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        stderrAccumulated += decoder.decode(value, { stream: true });
        if (!readySettled && LISTENING_ON_PATTERN.test(stderrAccumulated)) {
          clearTimeout(readinessTimer);
          resolveReady();
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();

  // tcpdump exiting before it ever reported readiness (e.g. sudo denied
  // the request, or the interface couldn't be opened) is itself a
  // readiness failure, not a later "capture stopped cleanly" outcome.
  void proc.exited.then((exitCode) => {
    if (!readySettled) {
      clearTimeout(readinessTimer);
      rejectReady(
        new Error(
          `tcpdump exited before becoming ready (code ${exitCode})${
            stderrAccumulated.trim() ? `: ${stderrAccumulated.trim()}` : ""
          }`,
        ),
      );
    }
  });

  return {
    ready,
    async stop(): Promise<CaptureStopResult> {
      clearTimeout(readinessTimer);
      proc.kill("SIGTERM");
      const [exitCode] = await Promise.all([proc.exited, stderrDrained]);
      return { exitCode, stderr: stderrAccumulated };
    },
  };
}

export type CaptureSummary =
  | { readonly status: "silent"; readonly totalPackets: number }
  | {
      readonly status: "not-silent";
      readonly totalPackets: number;
      readonly nonLoopbackPackets: number;
    }
  | { readonly status: "capture-failed"; readonly reason: string };

/** Size in bytes of a valid pcap global header — anything smaller can't be a real capture. */
const PCAP_MIN_VALID_BYTES = 24;

/**
 * Reads back a pcap file with `tcpdump -r` and counts non-loopback packets.
 * Never turns a failed read into a silent result: the pcap must exist, be
 * at least header-sized, and `tcpdump -r` must exit cleanly before this
 * returns anything but `capture-failed`.
 */
export async function summarizeCapture(
  pcapPath: string,
): Promise<CaptureSummary> {
  let size: number;
  try {
    size = statSync(pcapPath).size;
  } catch {
    return {
      status: "capture-failed",
      reason: `pcap file not found at ${pcapPath}`,
    };
  }
  if (size < PCAP_MIN_VALID_BYTES) {
    return {
      status: "capture-failed",
      reason: `pcap file is smaller than a valid capture header (${size} bytes < ${PCAP_MIN_VALID_BYTES})`,
    };
  }

  const proc = Bun.spawn(["tcpdump", "-r", pcapPath, "-n"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    return {
      status: "capture-failed",
      reason: `tcpdump -r exited ${exitCode}${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
    };
  }

  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  const nonLoopback = lines.filter(
    (line) => !line.includes("127.0.0.1") && !line.includes("::1"),
  );
  return nonLoopback.length === 0
    ? { status: "silent", totalPackets: lines.length }
    : {
        status: "not-silent",
        totalPackets: lines.length,
        nonLoopbackPackets: nonLoopback.length,
      };
}

export interface CaptureOrchestrationDeps {
  readonly pcapPath: string;
  readonly startCapture: (pcapPath: string) => CaptureHandle;
  /** Runs the whole offline-mode request window; must only execute *after* the capture has started. */
  readonly runRequests: () => Promise<OfflineRunSummary>;
  readonly summarizeCapture: (pcapPath: string) => Promise<CaptureSummary>;
}

export interface CaptureOrchestrationResult {
  readonly routerGuarantee: OfflineRunSummary;
  readonly capture: CaptureSummary;
}

/** A router-guarantee placeholder for when the capture never became ready and zero requests were run. */
const ZERO_REQUESTS_RUN: OfflineRunSummary = {
  requestCount: 0,
  hostedClientConstructions: 0,
  allRoutineOnly: true,
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Orchestrates the ordering the offline proof depends on: start the
 * capture, wait for it to actually become ready (not just spawned), run
 * every request only after that, stop the capture in a `finally` (so a
 * failing request run still stops tcpdump), and only then read the pcap
 * back. A capture that never becomes ready, or fails to stop cleanly, is
 * reported as `capture-failed` rather than silently summarized — and when
 * readiness itself fails, no request is ever run.
 */
export async function runOfflineWithCapture(
  deps: CaptureOrchestrationDeps,
): Promise<CaptureOrchestrationResult> {
  const handle = deps.startCapture(deps.pcapPath);

  try {
    await handle.ready;
  } catch (error) {
    // Best-effort cleanup only; the capture never became ready so there's
    // nothing meaningful to read back, and no request may run.
    await handle.stop().catch(() => undefined);
    return {
      routerGuarantee: ZERO_REQUESTS_RUN,
      capture: {
        status: "capture-failed",
        reason: describeError(error),
      },
    };
  }

  let routerGuarantee: OfflineRunSummary;
  let stopResult: CaptureStopResult;
  try {
    routerGuarantee = await deps.runRequests();
  } finally {
    stopResult = await handle.stop();
  }

  if (stopResult.exitCode !== 0) {
    return {
      routerGuarantee,
      capture: {
        status: "capture-failed",
        reason: `tcpdump exited ${stopResult.exitCode}${stopResult.stderr.trim() ? `: ${stopResult.stderr.trim()}` : ""}`,
      },
    };
  }

  const capture = await deps.summarizeCapture(deps.pcapPath);
  return { routerGuarantee, capture };
}
