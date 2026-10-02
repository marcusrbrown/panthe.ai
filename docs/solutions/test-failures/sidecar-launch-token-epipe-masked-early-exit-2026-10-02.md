---
title: A broken pipe on the launch-token write hid why the sidecar exited
date: 2026-10-02
category: test-failures
module: workspace
problem_type: test_failure
component: testing_framework
symptoms:
  - "`startSidecar` failed with `EPIPE` when the sidecar closed stdin or exited before the launch token write finished"
  - The scenario harness reported the broken pipe instead of the sidecar's own startup failure
  - A deterministic regression test failed 5 of 5 times with `EPIPE` before the fix
root_cause: async_timing
resolution_type: code_fix
severity: medium
tags: [sidecar, stdin, epipe, child-process, launch-token, early-exit, scenario-harness, ci-flake]
---

# A broken pipe on the launch-token write hid why the sidecar exited

## Problem

The scenario harness (`tools/scenarios/m1-living-world/src/sidecar.ts`) starts the sidecar, writes the launch token to its stdin, and waits for `PANTHEA_PORT`. If the sidecar had already refused to start, closed stdin, or exited, the write failed with `EPIPE`. The harness surfaced that broken pipe instead of the sidecar's exit, which hid the real cause and showed up as a CI flake.

## Symptoms

- `startSidecar` threw `EPIPE` from the token write or flush.
- The caller never saw the useful error, `sidecar exited (<code>) before printing its port`.
- The regression test added in PR #80 failed 5 of 5 times with `EPIPE` before the fix.

## What Didn't Work

The token write ran as an unguarded setup step:

```ts
child.stdin.write(`${token}\n`);
await child.stdin.flush();
```

That works only while the child is alive and reading. The timeout and exit race that came after it never ran, because the failure happened before the harness reached the `Promise.race` on port, exit, and timeout.

## Solution

PR #80 (commit `d3329e9`) guards the write. If it fails, the harness gives the child up to a second to report its exit. If the child has exited, the harness reports that exit; it rethrows the write error only if the child is still running. Since provider settings (#84) the same guard covers both stdin lines, the token and the launch config:

```ts
try {
  child.stdin.write(`${token}\n${JSON.stringify(options.launchConfig ?? NO_SETTINGS)}\n`);
  await child.stdin.flush();
} catch (error) {
  // A child that closed its stdin or exited before reading the token breaks the pipe:
  // report its exit, and rethrow the write error only if it is still running.
  const code = await Promise.race([exited, Bun.sleep(1000).then(() => undefined)]);
  if (code === undefined) throw error;
  throw new Error(`sidecar exited (${code}) before printing its port:\n${output}`);
}
```

The test forces the race instead of hoping for it. A shell script closes fd 0, writes a marker file, and exits. `onSpawn` may now return a promise, so the test waits for the marker before `startSidecar` writes:

```ts
writeFileSync(script, `#!/bin/sh\nexec 0<&-\n: > "${marker}"\nsleep 0.2\nexit 0\n`);

await expect(
  startSidecar(script, "/tmp/unused", {
    startTimeoutMs: 5000,
    onSpawn: async () => {
      while (!existsSync(marker)) await Bun.sleep(5);
    },
  }),
).rejects.toThrow(/exited \(0\) before printing its port/);
expect(liveSidecarCount()).toBe(before);
```

## Why This Works

During the handshake, a broken pipe almost always means the child is already gone, so the pipe error is a symptom. Waiting briefly on the child's exit recovers the real error and keeps the existing wording.

Stdin carries meaning in this design. The sidecar reads the token and then the launch config from it, and stdin EOF later is its shutdown and orphan signal (ADR-0003, `apps/simulation/src/lifecycle.ts`). The harness has to tell "the write failed because startup already failed" apart from a real transport problem.

## Prevention

- In any stdin handshake with a child process, guard the write and flush, race the failure against the child's exit, and prefer the exit over `EPIPE`.
- Rethrow the write error only when the child is still running.
- Make the race deterministic in tests: force an early exit or closed stdin, and gate the write on a marker.
- Assert behaviour, not just the error: the failed launch leaves no tracked child (`liveSidecarCount()` unchanged), and timeout failures still kill the child.

## Related Issues

- [PR #80: report a sidecar that exits before reading its token](https://github.com/marcusrbrown/panthea/pull/80)
- [A headless scenario needs a positive control per negative claim](../best-practices/end-to-end-scenario-with-positive-controls-2026-09-28.md): the same harness and the same token-write step
- [Lifecycle state behind one lock](../best-practices/lifecycle-state-one-lock-transitions-2026-09-28.md): the shell side of launch and exit races
