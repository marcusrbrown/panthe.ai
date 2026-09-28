---
title: Proving "offline mode sends nothing" needs a self-owned, falsifiable packet capture
date: 2026-09-27
category: test-failures
module: provider-matrix
problem_type: test_failure
component: tooling
symptoms:
  - "`results/offline.pcap` was 0 bytes after a clean-looking run; the first summary reported it as `capture-failed`"
  - "`tcpdump: results/offline.pcap: Permission denied` after a previous run's root-owned savefile blocked the next open"
  - "`stopPath: sigint-child`, `tcpdumpExitCode: 0`, stderr `0 packets captured / 96 packets received by filter`, file still 0 bytes"
  - "`0 packets captured / 382 received by filter` on a provider-host filter — the legitimate silent shape, but only provable with a control"
root_cause: missing_tooling
resolution_type: code_fix
severity: medium
tags: [tcpdump, sudo, offline, packet-capture, positive-control, provider-matrix, p07]
---

# Proving "offline mode sends nothing" needs a self-owned, falsifiable packet capture

## Problem

D22 requires offline mode to make no network requests to hosted providers. "No hosted-client
constructed" (a router-level assertion) is necessary but not sufficient — it doesn't rule out
another code path opening a socket. A real proof needs a packet capture showing zero
provider-bound traffic, but a capture that observes nothing ("0 packets") is indistinguishable
from a capture that is simply blind: wrong process signalled, packets never flushed, filter too
wide, or tcpdump never attached.

Five owner-run iterations of `bun run src/run.ts --offline --capture` produced a 0-byte pcap
before the proof held. Each round removed one way the capture could lie.

## Symptoms

- `results/offline.pcap` was 0 bytes after a clean-looking run; the first summary reported it
  as `capture-failed` (correct honesty, wrong outcome).
- Run 3: `tcpdump: results/offline.pcap: Permission denied` — the previous run's root-owned
  savefile blocked the next open after `-Z` dropped privileges.
- Run 4: `stopPath: sigint-child`, `tcpdumpExitCode: 0`, stderr `0 packets captured / 96 packets
  received by filter`, file still 0 bytes.
- Run 5: `0 packets captured / 382 received by filter` on a provider-host filter — which is the
  legitimate silent shape, but only provable with a control.

## What Didn't Work

1. **Signalling the `sudo` pid.** `proc.kill("SIGTERM")` on `sudo -n tcpdump …` never reached
   tcpdump: macOS sudo 1.9 runs with `use_pty`, which forks a monitor, so tcpdump is a
   *grandchild*. The 5 s timeout fired, SIGKILL cut the process, nothing flushed.
2. **`pgrep -P <sudo pid>` and `pgrep -f "tcpdump.*-w <path>"`.** The first returns the monitor
   (or nothing); the second matches sudo's own argv first, because it contains the identical
   substring.
3. **Leaving the previous pcap in place.** tcpdump opens the savefile as root before `-Z` drops
   privileges, so a stale root-owned file makes the next run fail with `Permission denied`.
4. **Stopping immediately after the requests.** Twenty in-memory requests finish in milliseconds;
   BPF's read timeout never delivered packets to userspace before the stop, so tcpdump processed
   zero.
5. **Treating any non-loopback packet as a leak.** With `-i any` the owner's background traffic
   (96–382 packets per window) would have false-positived a working capture.
6. **Short-circuiting `0 packets captured` to `silent`.** Fro Bot's review on
   [PR #18](https://github.com/marcusrbrown/panthea/pull/18) rejected this: 5,156 packets
   "received by filter" with an empty pcap is not evidence the capture saw the offline window.

## Solution

The probe owns the whole window — start → ready → requests → grace → stop → read back — and
pairs every offline capture with a positive control through the identical filter.

**Resolve the real tcpdump pid** (`tools/probes/provider-matrix/src/offline.ts`, `resolveTcpdumpPid`):

```ts
const candidates = await probe.pgrepExact("tcpdump"); // pgrep -x, never -P or -f
for (const pid of candidates) {
  const commandLine = await probe.commandLineForPid(pid); // ps -o args= -p <pid>
  const argv0 = commandLine.trim().split(/\s+/)[0];
  if (argv0.split("/").pop() === "tcpdump" && commandLine.includes(`-w ${pcapPath}`)) {
    matches.push(pid);
  }
}
```

**Capture invocation** (`startCapture`): remove any stale savefile first, then

```sh
sudo -n tcpdump -i any -U --immediate-mode -Z <invoking-user> -w <pcap> '(host <ip1> or host <ip2> …) or port 53'
```

`--immediate-mode` bypasses the BPF read timeout, `-U` flushes per packet, `-Z` leaves the file
readable by the unprivileged `tcpdump -r` pass. The filter comes from `buildCaptureFilterPlan`,
which resolves the provider hosts (`opencode.ai`, `api.openai.com`, `api.anthropic.com`, A and
AAAA) and falls back to `port 53` alone if resolution fails. A 2 s grace runs after the last
request; `stop()` sends `SIGINT` to the resolved pid and escalates to `SIGKILL` only on timeout.

**Classification** (`summarizeCapture`, `classifyCaptureLines`): provider packets are lines
involving a resolved provider IP; provider DNS lookups are `port 53` payloads naming a provider
host (`tcpdump -r -A`, exit status propagated). Both zero → `silent`; either nonzero →
`not-silent` with redacted sample lines. A missing or sub-header pcap, or a failed read, is
`capture-failed`.

**Control gate** (`run.ts`, `resolveOfflineCaptureVerdict`): a clean exit with `0 packets
captured` is `inconclusive`, not `silent`. Only when the same invocation's `--control` window —
one live `space-bunny-free` request under the same filter — reports `not-silent` is the offline
verdict upgraded.

Measured on the M1 Pro: offline window `silent` (20 requests through the real fallback chain, 0
hosted-client constructions, 0 matching packets); control `not-silent` (39 packets to the
resolved opencode.ai addresses).

## Why This Works

- With `use_pty`, tcpdump is never sudo's direct child; only an exact-name lookup validated
  against the `-w` path signals the process holding the capture handle.
- libpcap's `ps_recv` ("received by filter") counts packets delivered to BPF *before* the filter
  runs on BSD/macOS, so nonzero received with zero captured means the filter rejected them — an
  inference, which is why the control is required to turn it into evidence.
- Apple's tcpdump writes no pcap-ng header when zero packets match, so a 0-byte file after a
  clean exit is the expected silent artifact, not a failure — once a control proves the path.
- `--immediate-mode` plus the grace closes the buffering race that made a millisecond request
  burst invisible.

## Prevention

- Any "we don't phone home" claim backed by a capture must own the capture window, signal the
  real capturing process, filter on the resolved provider hosts, and pass a positive control in
  the same invocation. No control, no proof.
- Agent shells have no tty, so the owner's `sudo -v` timestamp does not reach them; sudo-gated
  runs are owner-executed:

  ```sh
  cd tools/probes/provider-matrix && sudo -v && bun run src/run.ts --offline --capture --control
  ```

- Keep raw pcaps out of git; publish the verdict, the diagnostics (resolved pids, stop path,
  tcpdump exit and stderr tail, filter, grace) and the control result.
- Regression tests cover: `0 packets captured` with nonzero received → `inconclusive` without a
  control; `-A` decode exit ≠ 0 → `capture-failed`; single-pid `ps` validation; stop not called
  before the grace elapses.

## Decision

Recorded in [ADR-0005](../../decisions/0005-model-providers.md) (offline consequence) and
[tools/probes/provider-matrix/README.md](../../../tools/probes/provider-matrix/README.md). Scope:
this proves the *probe's* fallback router; the product service's offline guard is M1 work and
needs its own capture plus control, not a reused result.

## Re-check

- New macOS or tcpdump version (`tcpdump --version`; this was 4.99.1 Apple 148 on 15.7.9),
  a sudo configuration change, or a new provider host set: re-run the owner command above and
  confirm `stopPath: sigint-child`, a non-`port 53`-only filter, and a `not-silent` control.
- When the offline guard moves into the product network layer (M1+).

## Related Issues

- [ADR-0005 Model providers](../../decisions/0005-model-providers.md) — offline consequence
- [D22](../../product/decisions.md), [P07](../../product/requirements.md) — the invariant and its
  requirement
- [Sampling Ollama's real memory usage needs the runner child pid](../performance-issues/ollama-runner-pid-rss-sampling-2026-09-27.md)
  — same "resolve the real child process, not the wrapper" pattern
- [PR #13](https://github.com/marcusrbrown/panthea/pull/13) (capture pending),
  [PR #18](https://github.com/marcusrbrown/panthea/pull/18) (falsifiable proof)
