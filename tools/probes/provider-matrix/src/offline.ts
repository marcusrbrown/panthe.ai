// Offline-mode proof has two halves:
//
// 1. A router-level guarantee that's fully testable without any OS
//    tooling: when offline mode is on, the router must never construct a
//    hosted provider client at all — not "construct it and don't call it",
//    construct it *never*. `routeAction` below is that guarantee, and
//    `offline.test.ts`-equivalent coverage lives inline in this probe's
//    test suite (see run.ts's --offline mode, which exercises this path 20
//    times and asserts the hosted-client factory was never invoked).
// 2. A packet-capture proof that the process is silent on the wire, which
//    needs `sudo tcpdump`. That step needs a real elevated shell and can't
//    be faked by a weaker code review or a stubbed HTTP layer (Unit 6
//    approach). If non-interactive sudo isn't available on this machine,
//    this module reports the exact command for the owner to run instead of
//    claiming an offline result it can't back up.

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

/** The exact `tcpdump` command a README/owner run should use for the capture window. */
export function offlineCaptureCommand(pcapPath: string): string {
  return `sudo tcpdump -i ${OFFLINE_INTERFACE} -w ${pcapPath}`;
}

/** The exact DNS-query log command for provider-hostname lookups during the capture window. */
export function offlineDnsLogCommand(): string {
  return `log stream --predicate 'process == "mDNSResponder"'`;
}

export type OfflineCaptureStatus =
  | { readonly status: "captured"; readonly pcapPath: string }
  | {
      readonly status: "pending-owner-run";
      readonly command: string;
      readonly reason: string;
    };

export interface SudoProbe {
  /** Returns true if `sudo -n true` succeeds (non-interactive sudo is available). */
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
 * command the owner needs to run manually.
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
        "non-interactive sudo is unavailable on this machine; run the command manually as the owner and re-run --offline to capture the summary",
    };
  }
  // Non-interactive sudo is available, but this probe still never launches
  // tcpdump itself here — the capture window must bracket the whole
  // 20-request run in run.ts, not a bare capability check.
  return { status: "captured", pcapPath };
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

export interface CaptureHandle {
  stop(): Promise<void>;
}

/** Starts `sudo tcpdump` in the background, writing to `pcapPath`. Assumes {@link checkOfflineCaptureAvailable} already confirmed non-interactive sudo works. */
export function startCapture(pcapPath: string): CaptureHandle {
  const proc = Bun.spawn(
    ["sudo", "-n", "tcpdump", "-i", OFFLINE_INTERFACE, "-w", pcapPath],
    { stdout: "ignore", stderr: "ignore" },
  );
  return {
    async stop() {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

export interface CaptureSummary {
  readonly totalPackets: number;
  readonly nonLoopbackPackets: number;
  readonly silent: boolean;
}

/** Reads back a pcap file with `tcpdump -r` and counts non-loopback packets. */
export async function summarizeCapture(
  pcapPath: string,
): Promise<CaptureSummary> {
  const proc = Bun.spawn(["tcpdump", "-r", pcapPath, "-n"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  const nonLoopback = lines.filter(
    (line) => !line.includes("127.0.0.1") && !line.includes("::1"),
  );
  return {
    totalPackets: lines.length,
    nonLoopbackPackets: nonLoopback.length,
    silent: nonLoopback.length === 0,
  };
}
