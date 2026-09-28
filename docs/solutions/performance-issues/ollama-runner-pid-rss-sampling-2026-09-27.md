---
title: Sampling Ollama's real memory usage needs re-resolving the runner child pid every poll
date: 2026-09-27
category: performance-issues
module: inference-baseline
problem_type: performance_issue
component: tooling
symptoms:
  - the recommended `llama3.2:3b` profile reported ~29 MiB "server RSS peak" while the parallel run of the same model showed 2,780 MiB
  - nine of thirteen published suite rows carried a supervisor-pid reading
  - a child pid resolved once at start goes stale when the next model loads
root_cause: scope_issue
resolution_type: code_fix
severity: medium
tags: [ollama, rss, process-sampling, benchmarking, inference-baseline, runner-pid, p04, p06]
---

# Sampling Ollama's real memory usage needs re-resolving the runner child pid every poll

## Problem

Measuring peak resident memory for a locally served model means polling a process over time.
`ollama serve`'s pid is stable across a run but is only a supervisor: the weights live in a
separate `llama-server`-shaped runner child that Ollama spawns per loaded model. Sampling the
supervisor reports tens of MiB and looks plausible enough to publish — which the first version of
the inference probe did, until [PR #19](https://github.com/marcusrbrown/panthea/pull/19)'s
review compared it with the parallel run.

## Symptoms

- `llama3.2:3b` @ 4K: 29 MiB in the candidate table, 2,780 MiB in the parallel=1 table of the
  same README.
- `results/summary.json`: nine suite rows flagged `rssBug: true` with the on-disk model size as a
  lower-bound proxy.

## What Didn't Work

- Sampling `ollama serve`'s pid.
- Resolving the child once at start: each model load (and reload) spawns a new runner pid, so a
  multi-model suite drifts back to the wrong process.

## Solution

`tools/probes/inference-baseline/src/run.ts` (`findOllamaRunnerPids`, `resolveRssPids`): for
`--server ollama` the supplied pid is treated as the supervisor, and on **every poll tick** the
sampler resolves its runner children (`pgrep -P <ollama pid>`, filtered by the runner name) and
sums their RSS; if no child matches the runner name it falls back to summing all direct children
rather than reporting the supervisor. Rows whose raw records could not be re-measured keep
`rssBug: true` and `diskSizeBytes` as a labelled proxy. The baseline suite was re-run: **2,783
MiB**, matching the parallel figure. The coexistence probe's sampler (`tools/probes/coexistence/
src/sample.ts`, `ollamaRunnerTarget`) applies the same per-tick resolution.

```ts
async function resolveRssPids(serverKind: ServerKind, supervisorPid: number): Promise<number[]> {
  if (serverKind !== "ollama") return [supervisorPid];
  const runners = await findOllamaRunnerPids(supervisorPid); // pgrep -P, name filter
  return runners.length > 0 ? runners : await directChildren(supervisorPid);
}
```

## Why This Works

The supervisor/worker split is the whole bug: the runner holds the weights, so the sampler must
follow that boundary and follow it continuously, because Ollama does not promise a stable runner
pid across loads. Ollama's docs expose `ollama ps` for the loaded-model view but no runner-pid
contract.

## Prevention

- For any supervisor-shaped server, sample the worker and publish which pid was sampled and
  whether the figure is RSS or a proxy.
- Cross-check with `ollama ps` (loaded model size) when a reading looks too small.
- The published `summary.json` carries the `rssBug` flag so a proxy can never be mistaken for a
  measurement.

## Re-check

On any Ollama release: verify `findOllamaRunnerPids` still matches the runner process name and
parent/child shape before trusting new RSS numbers.

## Related Issues

- [ADR-0005 Model providers](../../decisions/0005-model-providers.md) — local baseline profile
- [P04, P06](../../product/requirements.md)
- [Proving "offline mode sends nothing" needs a self-owned, falsifiable packet capture](../test-failures/tcpdump-sudo-pid-resolution-offline-proof-2026-09-27.md)
  — same "signal or sample the real child, not the wrapper" pattern
- [tools/probes/inference-baseline/README.md](../../../tools/probes/inference-baseline/README.md),
  [docs/research/inference-2026-09-26.md](../../research/inference-2026-09-26.md),
  [PR #19](https://github.com/marcusrbrown/panthea/pull/19)
