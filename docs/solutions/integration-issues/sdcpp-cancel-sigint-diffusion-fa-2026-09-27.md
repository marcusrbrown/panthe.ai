---
title: stable-diffusion.cpp needs --diffusion-fa and has no real job cancellation
date: 2026-09-27
category: integration-issues
module: art-local
problem_type: integration_issue
component: tooling
symptoms:
  - the same 512x512 12-step generation takes ~127 s without `--diffusion-fa` and ~24 s with it on the Metal build
  - "`GET /sdcpp/v1/capabilities` reports `features_by_mode.img_gen.cancel_generating: false`"
  - SIGINT to `sd-server` is ignored; the process keeps running and starts the next queued job
  - after SIGTERM the process was still alive 3 ms later at idle CPU — not a confirmed termination
root_cause: wrong_api
resolution_type: config_change
severity: medium
tags: [stable-diffusion-cpp, sd-server, diffusion-fa, cancellation, sigint, sigterm, u06, u07]
---

# stable-diffusion.cpp needs --diffusion-fa and has no real job cancellation

## Problem

Two assumptions needed checking before treating `sd-server` as the base local image arm: whether
its default flags are usable at all, and whether an in-flight job can be abandoned. D15 requires
activity and input never to block on image generation, which implies a real way to drop a slow
job.

## Symptoms

- Without `--diffusion-fa` the same no-LoRA generation measured ~127 s; with it ~24 s (≈5×).
- `features_by_mode.img_gen.cancel_generating` is `false` on the pinned build
  (`master-921-168f7b8`), so `POST /sdcpp/v1/jobs/{id}/cancel` only affects a still-queued job.
- `SIGINT` was silently ignored — the server kept generating and picked up the next job.
- `SIGTERM` quieted the process, but it was still alive 3 ms later below the 5% CPU threshold; the
  published record is `outcome: idle-cpu`, `supported: false`
  (`tools/probes/art-local/results/summary.json`).

## What Didn't Work

- HTTP cancel on an in-flight job — the capability bit says no, and it did nothing.
- `SIGINT` — ignored.
- Publishing "SIGTERM → idle in 7 ms" as a cancellation result. Fro Bot's review on
  [PR #21](https://github.com/marcusrbrown/panthea/pull/21) rejected it: a low-CPU reading with
  the process alive is not termination, and a whole-process kill is not job cancellation.

## Solution

- `--diffusion-fa` is mandatory for this arm; every sd.cpp number in the probe README was
  measured with it (`tools/probes/art-local/README.md`, How to run).
- Cancellation is classified, never assumed (`tools/probes/art-local/src/bench.ts`):
  - HTTP path (`runSdCppCancellation`): only a job that reaches `cancelled` counts; `completed`
    or `failed` after the request is reported as not cancelled.
  - Signal path (`runSdCppSignalCancel`, `mapIdleOutcomeToCancellationResult`): outcomes are
    `terminated` (process gone), `idle-cpu` (alive, quiet), or `timeout`; only `terminated` is a
    supported process-kill proxy, and even that is labelled a proxy, not job cancellation.
- Capability first: `getImgGenFeatures` (`src/sdcpp.ts`) reads `cancel_generating` before any
  cancel path is attempted.

## Why This Works

The capability bit is the source of truth for in-flight cancel support on a given build. The
outcome enum forces the distinction between "confirmed gone" and "went quiet" that the first
measurement blurred, so the record states exactly what the HTTP API can do (nothing in flight)
and what the process fallback proved (not enough).

## Decision

Ship `--diffusion-fa` unconditionally ([ADR-0007](../../decisions/0007-local-image-generation.md)).
Do not build a product "cancel this image" feature on `sd-server`'s HTTP API — it does not exist.
Image jobs are async and abandonable at the queue level (placeholder first, hot-swap on
completion), which satisfies D15 without in-flight cancel. If a hard abort is ever required, it is
a subprocess restart (kill and relaunch the server) whose warmup (~37 s to first image at Q8_0)
must be budgeted into the UX.

## Prevention

- Read `capabilities` before assuming any cancel semantics on a new build.
- Never publish a proxy measurement as the real thing; the outcome enum and its tests
  (`bench.test.ts`: `timeout` and `idle-cpu` never report `supported: true`; HTTP `completed`
  after cancel is not a cancellation) guard the report.
- Design the generation queue so in-flight cancel is never needed on the play path.

## Re-check

On each stable-diffusion.cpp release: re-run the capabilities probe, the SIGINT test, and the
SIGTERM fallback; publish only the confirmed outcome. Re-time with and without `--diffusion-fa`
if the Metal attention path changes upstream. (The pinned tag's README and `docs/backend.md`
do not document `--diffusion-fa` or the cancel semantics; the probe artifacts are the authority.)

## Related Issues

- [ADR-0007 Local image generation](../../decisions/0007-local-image-generation.md)
- [D15](../../product/decisions.md), [U06, U07](../../product/requirements.md)
- [A LoRA on a quantized stable-diffusion.cpp checkpoint can silently no-op](lora-silent-noop-on-quantized-sdcpp-weights-2026-09-27.md)
  — same arm, quantization/LoRA behaviour
- [tools/probes/art-local/README.md](../../../tools/probes/art-local/README.md),
  [PR #21](https://github.com/marcusrbrown/panthea/pull/21)
