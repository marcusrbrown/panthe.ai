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

import { lookup as dnsLookup } from "node:dns/promises";
import { rmSync, statSync } from "node:fs";
import { userInfo } from "node:os";
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

/**
 * Hostnames the offline capture scopes itself to. Offline mode's own
 * guarantee (zero hosted-client constructions) never talks to these; the
 * capture proof is that the wire agrees. A hit against any of these
 * (directly, or via a DNS lookup naming one of them) is the only thing
 * that can make a capture `not-silent` — unrelated background traffic on
 * the machine no longer counts (see {@link summarizeCapture}).
 */
export const OFFLINE_PROVIDER_HOSTS: readonly string[] = [
  "opencode.ai",
  "api.openai.com",
  "api.anthropic.com",
];

export interface DnsResolver {
  /** Resolves `hostname` to every A/AAAA address it has, or `[]` if resolution fails (offline machine, no DNS, etc). */
  readonly lookupAll: (hostname: string) => Promise<readonly string[]>;
}

const defaultDnsResolver: DnsResolver = {
  async lookupAll(hostname) {
    try {
      const results = await dnsLookup(hostname, {
        all: true,
        verbatim: true,
      });
      return results.map((result) => result.address);
    } catch {
      return [];
    }
  },
};

function isLoopbackIp(ip: string): boolean {
  return ip === "::1" || ip.startsWith("127.");
}

export interface ProviderHostResolution {
  readonly host: string;
  /** Resolved, non-loopback addresses for `host` — empty when resolution failed or only returned loopback (never used to build the filter; see {@link isLoopbackIp}'s doc comment on {@link buildCaptureFilterPlan}). */
  readonly ips: readonly string[];
}

export interface CaptureFilterPlan {
  /** The BPF filter expression passed to `tcpdump` as its final argument. */
  readonly filter: string;
  readonly resolvedHosts: readonly ProviderHostResolution[];
  /** Every resolved IP across all hosts, flattened — also what's recorded in the persisted capture diagnostics. */
  readonly allResolvedIps: readonly string[];
  /** True when NOT ONE provider host resolved to any (non-loopback) IP — e.g. this machine has no network at all. The filter falls back to DNS-only (`port 53`), and callers should say so rather than claim IP-level scoping that isn't actually in effect. */
  readonly resolutionFailed: boolean;
}

/**
 * Resolves {@link OFFLINE_PROVIDER_HOSTS} to IPs and builds the BPF filter
 * the capture is scoped to: `(host <ip1> or host <ip2> ...) or port 53`.
 * Loopback addresses are never included in the `host` clause even if a
 * resolution somehow returns one — `host 127.0.0.1` would match ALL
 * loopback traffic on the machine, reintroducing exactly the
 * false-positive problem this filter exists to avoid.
 *
 * If every host fails to resolve (no network), the filter falls back to
 * `port 53` alone so a DNS-based provider-lookup signal is still possible
 * even though IP-level scoping isn't — `resolutionFailed` on the returned
 * plan says so explicitly, for the diagnostics/README to report honestly.
 */
export async function buildCaptureFilterPlan(
  hosts: readonly string[] = OFFLINE_PROVIDER_HOSTS,
  resolver: DnsResolver = defaultDnsResolver,
): Promise<CaptureFilterPlan> {
  const resolvedHosts: ProviderHostResolution[] = [];
  for (const host of hosts) {
    const rawIps = await resolver.lookupAll(host);
    resolvedHosts.push({
      host,
      ips: rawIps.filter((ip) => !isLoopbackIp(ip)),
    });
  }
  const allResolvedIps = resolvedHosts.flatMap((resolved) => resolved.ips);
  const resolutionFailed = allResolvedIps.length === 0;
  const filter = resolutionFailed
    ? "port 53"
    : `(${allResolvedIps.map((ip) => `host ${ip}`).join(" or ")}) or port 53`;
  return { filter, resolvedHosts, allResolvedIps, resolutionFailed };
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

export type CaptureStopPath =
  | "sigint-child"
  | "sigint-sudo-fallback"
  | "sigkill-timeout";

export interface CaptureStopDiagnostics {
  /** PID(s) of the real `tcpdump` process(es) this stop attempt resolved and signaled directly — empty when resolution found nothing and the sudo-fallback path was used instead. */
  readonly resolvedPids: readonly number[];
  /** Which signaling path this stop attempt actually took — see {@link resolveTcpdumpPid}'s doc comment for why this matters. */
  readonly stopPath: CaptureStopPath;
  /** tcpdump's own exit code (same value as `CaptureStopResult.exitCode`, duplicated here so it survives being spread into the persisted capture summary). */
  readonly tcpdumpExitCode: number | null;
  /** Last `STDERR_TAIL_MAX_CHARS` characters of tcpdump's stderr — enough to diagnose a failed capture without needing to reproduce it. */
  readonly stderrTail: string;
}

export interface CaptureStopResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly diagnostics: CaptureStopDiagnostics;
}

/**
 * The full diagnostics attached to a persisted {@link CaptureSummary}:
 * everything from the stop signal itself ({@link CaptureStopDiagnostics}),
 * plus orchestration-level context {@link runOfflineWithCapture} alone
 * knows about — the grace period actually used, and the BPF filter/IPs
 * this capture was scoped to (if any).
 */
export interface CaptureDiagnostics extends CaptureStopDiagnostics {
  /** How long {@link runOfflineWithCapture} waited after the offline request burst finished, before signaling stop — gives BPF/tcpdump real wall-clock time to process anything in flight (the in-memory request burst itself finishes in milliseconds). */
  readonly graceMs: number;
  /** The BPF filter passed to `tcpdump` for this capture, when a {@link CaptureFilterPlan} was supplied. */
  readonly filter?: string;
  /** Provider IPs the filter resolved to (see {@link CaptureFilterPlan.allResolvedIps}). */
  readonly resolvedProviderIps?: readonly string[];
  /** True when provider-host DNS resolution failed entirely and the filter fell back to DNS-only matching — see {@link CaptureFilterPlan.resolutionFailed}. */
  readonly filterResolutionFailed?: boolean;
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
  /**
   * Stops the capture by signaling the real `tcpdump` process (not
   * `sudo`) with SIGINT so it flushes its pcap writes, then waits up to
   * {@link CAPTURE_STOP_TIMEOUT_MS} for it to exit before force-killing.
   */
  stop(): Promise<CaptureStopResult>;
}

/** tcpdump prints this once it has actually opened the interface and started capturing. */
const LISTENING_ON_PATTERN = /listening on/i;
/** How long to wait for tcpdump's readiness line before giving up. */
export const CAPTURE_READINESS_TIMEOUT_MS = 10_000;

/**
 * How long to wait for `sudo`/tcpdump to exit after being signaled to
 * stop before this gives up and force-kills the process tree. Chosen to
 * comfortably outlast tcpdump's own flush-on-signal work while still
 * bounding how long a genuinely stuck capture can hang the probe.
 */
export const CAPTURE_STOP_TIMEOUT_MS = 5_000;

/** Resolves once `ms` milliseconds have elapsed. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The user tcpdump should drop root privileges to (via `-Z`) once it has
 * opened the capture device — equivalent to `` `id -un` ``. Passing this
 * explicitly avoids two failure modes of tcpdump's own default privilege
 * handling: it can drop to a user (commonly `nobody`) that lacks write
 * access to the `-w` target directory, and even when the write succeeds,
 * a root-owned pcap file can't be read back by the unprivileged
 * `tcpdump -r` call in {@link summarizeCapture}.
 */
const CAPTURE_USER = userInfo().username;

/** Chars of tcpdump stderr retained in {@link CaptureStopDiagnostics.stderrTail}. */
const STDERR_TAIL_MAX_CHARS = 500;

function tailOf(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? trimmed.slice(-maxChars) : trimmed;
}

export interface ProcessProbe {
  /** PIDs of every process whose name is *exactly* `name` (`pgrep -x <name>`). */
  readonly pgrepExact: (name: string) => Promise<readonly number[]>;
  /** Full command line for `pid` (`ps -o args= -p <pid>`), or `undefined` if the process doesn't exist or `ps` failed. */
  readonly commandLineForPid: (pid: number) => Promise<string | undefined>;
}

async function pgrepExactPids(name: string): Promise<readonly number[]> {
  try {
    const proc = Bun.spawn(["pgrep", "-x", name], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [output, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return [];
    }
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => !Number.isNaN(pid));
  } catch {
    return [];
  }
}

async function commandLineForPid(pid: number): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["ps", "-o", "args=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [output, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return undefined;
    }
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

const defaultProcessProbe: ProcessProbe = {
  pgrepExact: pgrepExactPids,
  commandLineForPid,
};

/**
 * Resolves the PID(s) of the real `tcpdump` process(es) started by
 * {@link startCapture}. Matching on the *exact* process name
 * (`pgrep -x tcpdump`) is required, not a `pgrep -P <sudo pid>` parent
 * lookup or a `pgrep -f` command-line substring match:
 *
 * - macOS `sudo` 1.9 with `use_pty` (the default) forks a PTY-monitor
 *   process, so tcpdump ends up as sudo's *grandchild*, not its direct
 *   child — `pgrep -P <sudo pid>` resolves the monitor (or nothing).
 * - `pgrep -f` matches on the full command line, so it matches `sudo`'s
 *   own invocation (`sudo -n tcpdump -i any ... -w <pcapPath>`) before it
 *   ever reaches the real tcpdump process, since both contain the same
 *   substring.
 *
 * Signaling either of those wrong PIDs does nothing observable: SIGINT
 * goes to a process that isn't tcpdump, the stop timeout elapses, and
 * the eventual SIGKILL cuts tcpdump off before its pcap-ng buffers ever
 * flush to disk — a 0-byte pcap despite tcpdump "running cleanly" and
 * exiting 0. Confirmed empirically: `sudo kill -INT $(pgrep -x tcpdump)`
 * reliably produces a valid, multi-MB pcap; the parent- and
 * command-line-based lookups do not reliably resolve to the same PID.
 *
 * Every candidate — even a single `pgrep -x` match — is validated against
 * its own command line (`ps -o args=`) before being trusted: the match
 * must actually be invoked as `tcpdump` (its argv[0], not `sudo` — a
 * defensive second check in case a `pgrep -x` implementation ever
 * behaves more loosely than expected) AND have been started with *this*
 * capture's exact `-w <pcapPath>`. A single exact-name match is the
 * overwhelmingly common case, but it is not automatically the RIGHT
 * process — a stale/unrelated `tcpdump` left running from a previous
 * capture (or something else entirely) could still be the only exact
 * match `pgrep -x` finds, and signaling it would silently do nothing
 * useful while looking like a resolved pid.
 */
export async function resolveTcpdumpPid(
  pcapPath: string,
  probe: ProcessProbe = defaultProcessProbe,
): Promise<readonly number[]> {
  const candidates = await probe.pgrepExact("tcpdump");
  const matches: number[] = [];
  for (const pid of candidates) {
    const commandLine = await probe.commandLineForPid(pid);
    if (!commandLine) {
      continue;
    }
    const argv0 = commandLine.trim().split(/\s+/)[0];
    const invokedAsTcpdump =
      argv0 !== undefined && argv0.split("/").pop() === "tcpdump";
    if (invokedAsTcpdump && commandLine.includes(`-w ${pcapPath}`)) {
      matches.push(pid);
    }
  }
  return matches;
}

export interface StartCaptureOptions {
  /** BPF filter expression (e.g. from {@link buildCaptureFilterPlan}) to scope the capture to — tcpdump's final positional argument. Unfiltered (captures everything on the interface) when omitted. */
  readonly filter?: string;
}

/** Starts `sudo tcpdump` in the background, writing to `pcapPath`. Assumes {@link checkOfflineCaptureAvailable} already confirmed non-interactive sudo works. */
export function startCapture(
  pcapPath: string,
  options: StartCaptureOptions = {},
): CaptureHandle {
  // A stale savefile from an earlier run may be root-owned (tcpdump opens it
  // before dropping privileges), which makes the next run fail with
  // "Permission denied" after -Z. Remove it first; sudo handles root-owned
  // leftovers the invoking user cannot delete.
  try {
    rmSync(pcapPath, { force: true });
  } catch {
    Bun.spawnSync(["sudo", "-n", "rm", "-f", pcapPath]);
  }
  const proc = Bun.spawn(
    [
      "sudo",
      "-n",
      "tcpdump",
      "-i",
      OFFLINE_INTERFACE,
      // Packet-buffered: flush each packet to the savefile as it's
      // captured rather than waiting for tcpdump's internal buffer (or
      // process exit) to fill — otherwise a pcap read immediately after
      // stop can still see 0 bytes even though tcpdump exited cleanly.
      "-U",
      // Bypasses BPF's kernel-side read timeout/buffering entirely, so a
      // matching packet is delivered to tcpdump's userspace loop (and
      // written out, given -U above) as soon as it arrives — without
      // this, a short-lived capture window (the offline request burst
      // finishes in milliseconds) can end and get SIGINT'd before BPF's
      // own timeout ever wakes tcpdump up to process anything, even
      // packets the kernel already received and counted.
      "--immediate-mode",
      // Drop root privileges to the invoking user once the capture
      // device is open — see CAPTURE_USER's doc comment.
      "-Z",
      CAPTURE_USER,
      "-w",
      pcapPath,
      ...(options.filter ? [options.filter] : []),
    ],
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

      // Signal the real tcpdump process(es), not sudo — see
      // resolveTcpdumpPid's doc comment for why sudo's own PID is the
      // wrong target.
      const resolvedPids = await resolveTcpdumpPid(pcapPath);
      let stopPath: CaptureStopPath;
      if (resolvedPids.length > 0) {
        stopPath = "sigint-child";
        await Promise.all(
          resolvedPids.map(
            (pid) =>
              Bun.spawn(["sudo", "-n", "kill", "-INT", String(pid)], {
                stdout: "ignore",
                stderr: "ignore",
              }).exited,
          ),
        );
      } else {
        // Last resort only: pid resolution found nothing to signal
        // directly. Signaling sudo's own PID is unreliable (see
        // resolveTcpdumpPid's doc comment) and may not reach tcpdump at
        // all, but there's nothing better left to try.
        stopPath = "sigint-sudo-fallback";
        proc.kill("SIGINT");
      }

      let timedOut = false;
      const exitCode = await Promise.race([
        proc.exited,
        delay(CAPTURE_STOP_TIMEOUT_MS).then(async () => {
          timedOut = true;
          // sudo/tcpdump didn't exit in time; force-kill so the probe
          // never hangs waiting on a stuck capture process.
          if (resolvedPids.length > 0) {
            await Promise.all(
              resolvedPids.map((pid) =>
                Bun.spawn(["sudo", "-n", "kill", "-KILL", String(pid)], {
                  stdout: "ignore",
                  stderr: "ignore",
                }).exited.catch(() => undefined),
              ),
            );
          }
          proc.kill("SIGKILL");
          return proc.exited;
        }),
      ]);

      await stderrDrained;
      return {
        exitCode,
        stderr: stderrAccumulated,
        diagnostics: {
          resolvedPids,
          stopPath: timedOut ? "sigkill-timeout" : stopPath,
          tcpdumpExitCode: exitCode,
          stderrTail: tailOf(stderrAccumulated, STDERR_TAIL_MAX_CHARS),
        },
      };
    },
  };
}

export type CaptureSummary =
  | {
      readonly status: "silent";
      readonly totalPackets: number;
      readonly diagnostics?: CaptureDiagnostics;
    }
  | {
      readonly status: "not-silent";
      readonly totalPackets: number;
      /** Packets whose source or destination matched a resolved provider IP directly. */
      readonly providerPackets: number;
      /** Count of {@link OFFLINE_PROVIDER_HOSTS} entries seen by name in a DNS query/response payload during the capture. */
      readonly providerDnsLookups: number;
      /** First 5 packet lines (local addresses redacted) — enough to see what actually matched without dumping the whole capture. */
      readonly sampleLines: readonly string[];
      readonly diagnostics?: CaptureDiagnostics;
    }
  | {
      readonly status: "capture-failed";
      readonly reason: string;
      readonly diagnostics?: CaptureDiagnostics;
    }
  | {
      /**
       * Zero matching packets were reported at the tcpdump-process level
       * (`0 packets captured`), but that alone can't be trusted as
       * `silent` — see {@link runCaptureWindow}'s doc comment on why. Only
       * an accompanying passing positive control (checked by the caller,
       * not this module) can upgrade this to a real `silent` verdict.
       */
      readonly status: "inconclusive";
      readonly reason: string;
      readonly diagnostics?: CaptureDiagnostics;
    };

/** Size in bytes of a valid pcap global header — anything smaller can't be a real capture. */
const PCAP_MIN_VALID_BYTES = 24;
/** Default time to wait for a just-stopped tcpdump's flush to land on disk before declaring the pcap unreadable. */
const DEFAULT_FLUSH_POLL_TIMEOUT_MS = 2_000;
/** Poll interval while waiting for the flush above. */
const DEFAULT_FLUSH_POLL_INTERVAL_MS = 100;
/** Max sample lines kept on a `not-silent` result. */
const MAX_SAMPLE_LINES = 5;

async function statSizeOrUndefined(path: string): Promise<number | undefined> {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

/** tcpdump's one-line decode puts the destination `ip.port:` right before the colon — this matches DNS traffic (port 53) in either direction. */
const DNS_LINE_PATTERN = /\.53[:>]/;

/** RFC1918 / loopback / link-local address fragments — redacted from sample lines before they're persisted or shown, so a diagnostic capture never leaks the operator's local network topology. */
const LOCAL_IPV4_PATTERN =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
const LOCAL_IPV6_PATTERN = /\b(?:::1|fe80::[0-9a-fA-F:]+)\b/g;

function redactLocalAddresses(line: string): string {
  return line
    .replace(LOCAL_IPV4_PATTERN, "<local-ip>")
    .replace(LOCAL_IPV6_PATTERN, "<local-ip>");
}

export interface PcapReadResult {
  readonly lines: readonly string[];
  readonly exitCode: number | null;
  readonly stderrText: string;
}

export interface PcapReader {
  /** Reads `pcapPath` with `tcpdump -r ... -n -tt <extraArgs>` (e.g. `["-A"]` for the ASCII payload dump). */
  readonly readLines: (
    pcapPath: string,
    extraArgs: readonly string[],
  ) => Promise<PcapReadResult>;
}

async function readPcapLines(
  pcapPath: string,
  extraArgs: readonly string[] = [],
): Promise<PcapReadResult> {
  const proc = Bun.spawn(
    ["tcpdump", "-r", pcapPath, "-n", "-tt", ...extraArgs],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    lines: output.split("\n").filter((line) => line.trim().length > 0),
    exitCode,
    stderrText,
  };
}

/**
 * Reads back a pcap file with `tcpdump -r` and classifies what's in it
 * against {@link OFFLINE_PROVIDER_HOSTS}/`providerIps` — NOT "any
 * non-loopback packet", which false-positives on the operator's own
 * unrelated background traffic that the capture's `... or port 53` BPF
 * clause also lets through (any DNS query on the machine, not just ones
 * naming a provider). A capture only becomes `not-silent` when a packet
 * actually involves a provider IP, or a DNS payload actually names a
 * provider host — the latter needs a second, payload-visible pass
 * (`-A`), since the one-line summary never shows a query's name.
 *
 * Never turns a failed read into a silent result: the pcap must exist, be
 * at least header-sized, and `tcpdump -r` must exit cleanly before this
 * returns anything but `capture-failed`.
 *
 * A pcap can still be sub-header-sized for a brief moment right after
 * `stop()` returns, even with `-U` packet buffering (the write lands on
 * disk asynchronously relative to the signaled process exiting), so this
 * polls briefly for the file to reach a valid size before giving up — a
 * file that's still short after the poll window is reported as
 * `capture-failed`, never silently treated as a valid empty capture. (A
 * *known-empty* capture — tcpdump itself reported 0 packets captured on a
 * clean exit — is short-circuited earlier, in {@link runOfflineWithCapture},
 * and never reaches this poll at all.)
 */
const defaultPcapReader: PcapReader = { readLines: readPcapLines };

export async function summarizeCapture(
  pcapPath: string,
  options: {
    readonly flushPollTimeoutMs?: number;
    readonly flushPollIntervalMs?: number;
    /** Provider IPs to match packets against directly (see {@link CaptureFilterPlan.allResolvedIps}). */
    readonly providerIps?: readonly string[];
    /** Provider hostnames to look for in DNS payloads (see {@link OFFLINE_PROVIDER_HOSTS}). */
    readonly providerHosts?: readonly string[];
    /** Injectable for testing the `-A` exit-status propagation without a real pcap/tcpdump. */
    readonly pcapReader?: PcapReader;
  } = {},
): Promise<CaptureSummary> {
  const flushPollTimeoutMs =
    options.flushPollTimeoutMs ?? DEFAULT_FLUSH_POLL_TIMEOUT_MS;
  const flushPollIntervalMs =
    options.flushPollIntervalMs ?? DEFAULT_FLUSH_POLL_INTERVAL_MS;
  const providerIps = options.providerIps ?? [];
  const providerHosts = options.providerHosts ?? [];
  const pcapReader = options.pcapReader ?? defaultPcapReader;

  let size = await statSizeOrUndefined(pcapPath);
  const deadline = performance.now() + flushPollTimeoutMs;
  while (
    (size === undefined || size < PCAP_MIN_VALID_BYTES) &&
    performance.now() < deadline
  ) {
    await delay(flushPollIntervalMs);
    size = await statSizeOrUndefined(pcapPath);
  }

  if (size === undefined) {
    return {
      status: "capture-failed",
      reason: `pcap file not found at ${pcapPath}`,
    };
  }
  if (size < PCAP_MIN_VALID_BYTES) {
    return {
      status: "capture-failed",
      reason: `pcap file is smaller than a valid capture header (${size} bytes < ${PCAP_MIN_VALID_BYTES}) after waiting up to ${flushPollTimeoutMs}ms for tcpdump's flush`,
    };
  }

  const { lines, exitCode, stderrText } = await pcapReader.readLines(
    pcapPath,
    [],
  );
  if (exitCode !== 0) {
    return {
      status: "capture-failed",
      reason: `tcpdump -r exited ${exitCode}${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
    };
  }

  const totalPackets = lines.length;
  if (totalPackets === 0) {
    return { status: "silent", totalPackets: 0 };
  }

  const hasDnsLine = lines.some((line) => DNS_LINE_PATTERN.test(line));
  let dnsPayloadText = "";
  if (providerHosts.length > 0 && hasDnsLine) {
    // Query/response names only show up in the ASCII payload dump, not
    // the default one-line summary — this is how a provider-hostname
    // lookup is told apart from the operator's own unrelated DNS traffic
    // that the capture filter's `or port 53` clause also let through.
    const verboseRead = await pcapReader.readLines(pcapPath, ["-A"]);
    if (verboseRead.exitCode !== 0) {
      return {
        status: "capture-failed",
        reason: `tcpdump -r -A exited ${verboseRead.exitCode}${verboseRead.stderrText.trim() ? `: ${verboseRead.stderrText.trim()}` : ""}`,
      };
    }
    dnsPayloadText = verboseRead.lines.join("\n");
  }

  const { providerPackets, providerDnsLookups } = classifyCaptureLines(
    lines,
    providerIps,
    providerHosts,
    dnsPayloadText,
  );

  if (providerPackets === 0 && providerDnsLookups === 0) {
    // Packets exist (e.g. unrelated background DNS the filter's `port 53`
    // clause let through) but none of them are provider-related — still
    // silent, with the total kept only for context.
    return { status: "silent", totalPackets };
  }

  return {
    status: "not-silent",
    totalPackets,
    providerPackets,
    providerDnsLookups,
    sampleLines: lines.slice(0, MAX_SAMPLE_LINES).map(redactLocalAddresses),
  };
}

/**
 * Pure classification core of {@link summarizeCapture}: given the pcap's
 * one-line-per-packet summary, the provider IPs to match packets against
 * directly, the provider hostnames to look for in DNS payloads, and the
 * (optionally empty) ASCII payload dump text to search those hostnames
 * in, returns how many packets/lookups were provider-related. Kept
 * dependency-free (no file I/O, no subprocess) so it's directly
 * unit-testable against hand-written sample lines.
 */
export function classifyCaptureLines(
  lines: readonly string[],
  providerIps: readonly string[],
  providerHosts: readonly string[],
  dnsPayloadText: string,
): { readonly providerPackets: number; readonly providerDnsLookups: number } {
  const providerPackets = lines.filter((line) =>
    providerIps.some((ip) => line.includes(ip)),
  ).length;
  const providerDnsLookups = providerHosts.filter((host) =>
    dnsPayloadText.includes(host),
  ).length;
  return { providerPackets, providerDnsLookups };
}

/** Default grace period — see {@link CaptureOrchestrationDeps.graceMs}. */
export const DEFAULT_CAPTURE_GRACE_MS = 2_000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** tcpdump's shutdown summary includes a `N packets captured` line — this is the userspace count (what tcpdump actually processed and could have written), as opposed to `N packets received by filter` (the kernel/BPF count, which can be nonzero even when tcpdump processed nothing before being signaled). */
const PACKETS_CAPTURED_PATTERN = /(\d+)\s+packets captured/;
/** The BPF/kernel-level receive count — see {@link parseCapturedCount}'s doc comment and libpcap's `pcap_stats(3PCAP)` note on `ps_recv`. */
const PACKETS_RECEIVED_PATTERN = /(\d+)\s+packets received by filter/;

function parseStatLine(stderr: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(stderr);
  if (!match) {
    return undefined;
  }
  const raw = match[1];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseCapturedCount(stderr: string): number | undefined {
  return parseStatLine(stderr, PACKETS_CAPTURED_PATTERN);
}

function parseReceivedByFilterCount(stderr: string): number | undefined {
  return parseStatLine(stderr, PACKETS_RECEIVED_PATTERN);
}

interface CaptureWindowDeps<T> {
  readonly pcapPath: string;
  readonly startCapture: (pcapPath: string) => CaptureHandle;
  /** Runs the capture's whole traffic window; must only execute *after* the capture has started. */
  readonly runWindow: () => Promise<T>;
  readonly summarizeCapture: (pcapPath: string) => Promise<CaptureSummary>;
  /** How long to wait after `runWindow` resolves before stopping the capture, giving BPF/tcpdump real wall-clock time to process anything in flight. Defaults to {@link DEFAULT_CAPTURE_GRACE_MS}. */
  readonly graceMs?: number;
  /** The filter plan this capture was started with, if any — recorded into the returned diagnostics so a persisted result shows exactly what the capture was (and wasn't) scoped to. */
  readonly filterPlan?: CaptureFilterPlan;
}

interface CaptureWindowResult<T> {
  readonly windowResult: T;
  readonly capture: CaptureSummary;
}

function buildCaptureDiagnostics<T>(
  stopDiagnostics: CaptureStopDiagnostics | undefined,
  deps: CaptureWindowDeps<T>,
  graceMs: number,
): CaptureDiagnostics | undefined {
  if (!stopDiagnostics) {
    return undefined;
  }
  return {
    ...stopDiagnostics,
    graceMs,
    filter: deps.filterPlan?.filter,
    resolvedProviderIps: deps.filterPlan?.allResolvedIps,
    filterResolutionFailed: deps.filterPlan?.resolutionFailed,
  };
}

/**
 * The shared ordering primitive both the offline-mode proof
 * ({@link runOfflineWithCapture}) and the positive control
 * ({@link runControlCapture}) depend on: start the capture, wait for it
 * to actually become ready (not just spawned), run the window's traffic,
 * wait out a grace period for anything in flight to actually be
 * processed (see {@link CaptureWindowDeps.graceMs}), stop the capture in
 * a `finally` (so a failing window still stops tcpdump), and only then
 * read the pcap back. A capture that never becomes ready, or fails to
 * stop cleanly, is reported as `capture-failed` rather than silently
 * summarized — and when readiness itself fails, the window never runs
 * (`onReadinessFailure` supplies the placeholder `windowResult` for that
 * case).
 *
 * A clean exit that itself reports zero packets captured (tcpdump's own
 * `0 packets captured` shutdown line) is short-circuited to `inconclusive`
 * — NOT `silent` — without ever touching the pcap on disk. This is
 * deliberately weaker than a claim of silence: per libpcap's
 * `pcap_stats(3PCAP)`, "`ps_recv` ... on some platforms include[s]
 * packets that didn't pass the filter" (BSD/macOS's BPF device delivers
 * packets to the kernel side before the filter is applied), so a nonzero
 * "packets received by filter" alongside `0 packets captured` most
 * likely means the filter correctly rejected them — not that the capture
 * missed real provider traffic. That's plausible, even likely, but it's
 * an inference, not a measurement: only a same-invocation *passing*
 * positive control (the same filter plan, an actual not-silent result
 * from a real request) earns the stronger `silent` claim — the caller
 * (not this function, which has no visibility into whether a control
 * ran) is responsible for that upgrade. See {@link summarizeCapture}'s
 * doc comment for the *other* 0-byte case, which still fails outright.
 */
async function runCaptureWindow<T>(
  deps: CaptureWindowDeps<T>,
  onReadinessFailure: () => T,
): Promise<CaptureWindowResult<T>> {
  const graceMs = deps.graceMs ?? DEFAULT_CAPTURE_GRACE_MS;
  const handle = deps.startCapture(deps.pcapPath);

  try {
    await handle.ready;
  } catch (error) {
    // Best-effort cleanup only; the capture never became ready so there's
    // nothing meaningful to read back, and the window never runs.
    const stopResult = await handle.stop().catch(() => undefined);
    return {
      windowResult: onReadinessFailure(),
      capture: {
        status: "capture-failed",
        reason: describeError(error),
        diagnostics: buildCaptureDiagnostics(
          stopResult?.diagnostics,
          deps,
          graceMs,
        ),
      },
    };
  }

  let windowResult: T;
  let stopResult: CaptureStopResult;
  try {
    windowResult = await deps.runWindow();
    await delay(graceMs);
  } finally {
    stopResult = await handle.stop();
  }

  if (stopResult.exitCode !== 0) {
    return {
      windowResult,
      capture: {
        status: "capture-failed",
        reason: `tcpdump exited ${stopResult.exitCode}${stopResult.stderr.trim() ? `: ${stopResult.stderr.trim()}` : ""}`,
        diagnostics: buildCaptureDiagnostics(
          stopResult.diagnostics,
          deps,
          graceMs,
        ),
      },
    };
  }

  const capturedCount = parseCapturedCount(stopResult.stderr);
  if (capturedCount === 0) {
    const receivedCount = parseReceivedByFilterCount(stopResult.stderr);
    return {
      windowResult,
      capture: {
        status: "inconclusive",
        reason:
          "no matching packets; positive control not run" +
          (receivedCount !== undefined && receivedCount > 0
            ? ` (BPF received ${receivedCount} packet(s) before the filter ran — expected per libpcap's ps_recv semantics, not evidence of a missed capture)`
            : ""),
        diagnostics: buildCaptureDiagnostics(
          stopResult.diagnostics,
          deps,
          graceMs,
        ),
      },
    };
  }

  const capture = await deps.summarizeCapture(deps.pcapPath);
  return {
    windowResult,
    capture: {
      ...capture,
      diagnostics: buildCaptureDiagnostics(
        stopResult.diagnostics,
        deps,
        graceMs,
      ),
    },
  };
}

export interface CaptureOrchestrationDeps {
  readonly pcapPath: string;
  readonly startCapture: (pcapPath: string) => CaptureHandle;
  /** Runs the whole offline-mode request window; must only execute *after* the capture has started. */
  readonly runRequests: () => Promise<OfflineRunSummary>;
  readonly summarizeCapture: (pcapPath: string) => Promise<CaptureSummary>;
  /** How long to wait after `runRequests` resolves before stopping the capture, giving BPF/tcpdump real wall-clock time to process anything in flight — the offline request burst itself finishes in milliseconds, well before a kernel-buffered packet would otherwise reach tcpdump's userspace loop. Defaults to {@link DEFAULT_CAPTURE_GRACE_MS}. */
  readonly graceMs?: number;
  /** The filter plan this capture was started with, if any — recorded into the returned diagnostics so a persisted result shows exactly what the capture was (and wasn't) scoped to. */
  readonly filterPlan?: CaptureFilterPlan;
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

/**
 * Orchestrates the offline-mode proof's capture window — see
 * {@link runCaptureWindow} for the ordering guarantee this specializes.
 */
export async function runOfflineWithCapture(
  deps: CaptureOrchestrationDeps,
): Promise<CaptureOrchestrationResult> {
  const result = await runCaptureWindow(
    {
      pcapPath: deps.pcapPath,
      startCapture: deps.startCapture,
      runWindow: deps.runRequests,
      summarizeCapture: deps.summarizeCapture,
      graceMs: deps.graceMs,
      filterPlan: deps.filterPlan,
    },
    () => ZERO_REQUESTS_RUN,
  );
  return { routerGuarantee: result.windowResult, capture: result.capture };
}

export interface ControlCaptureDeps {
  readonly pcapPath: string;
  readonly startCapture: (pcapPath: string) => CaptureHandle;
  /**
   * Makes exactly one live (offline mode OFF) request through the real
   * provider adapter — the positive control's whole point is that this
   * request must actually reach the network so the capture path can be
   * proven capable of seeing provider traffic at all. Must not throw:
   * catch and record any failure internally (e.g. via the returned
   * `requestError` a caller layers on top) so the capture window still
   * completes and gets summarized — whatever DNS/TCP activity happened
   * before a request-level failure is still meaningful evidence.
   */
  readonly sendControlRequest: () => Promise<void>;
  readonly summarizeCapture: (pcapPath: string) => Promise<CaptureSummary>;
  readonly graceMs?: number;
  /** The filter plan to reuse — the positive control must be scoped identically to the capture it's validating, not re-resolved. */
  readonly filterPlan?: CaptureFilterPlan;
}

export interface ControlCaptureResult {
  readonly capture: CaptureSummary;
}

/**
 * Runs the positive-control capture window: starts a second capture with
 * the identical filter plan, sends exactly one real (non-offline) request,
 * grace, stop, summarize — see {@link runCaptureWindow} for the ordering
 * guarantee. A `not-silent` result here is what makes a `silent` offline
 * result trustworthy: it proves the filter and capture path can actually
 * see provider traffic, not just that nothing showed up.
 */
export async function runControlCapture(
  deps: ControlCaptureDeps,
): Promise<ControlCaptureResult> {
  const result = await runCaptureWindow(
    {
      pcapPath: deps.pcapPath,
      startCapture: deps.startCapture,
      runWindow: deps.sendControlRequest,
      summarizeCapture: deps.summarizeCapture,
      graceMs: deps.graceMs,
      filterPlan: deps.filterPlan,
    },
    () => undefined,
  );
  return { capture: result.capture };
}
