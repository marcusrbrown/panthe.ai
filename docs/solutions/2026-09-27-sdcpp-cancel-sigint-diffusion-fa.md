---
title: stable-diffusion.cpp needs --diffusion-fa and has no real job cancellation
date: 2026-09-27
category: content
requirement_ids: [U06, U07]
tags: [stable-diffusion.cpp, sd-server, cancellation, metal]
---

## Problem

Two separate assumptions needed checking before treating `stable-diffusion.cpp`'s `sd-server` as
the base local image-generation arm: whether its default flags are fast enough to be usable, and
whether an in-flight job can actually be cancelled (D15 requires activity/input to never block on
image generation, which implies a real way to abandon a slow job).

## Method

Timed the same generation with and without `--diffusion-fa` on the Metal build. Attempted
cancellation three ways in order: (1) the server's own `POST /sdcpp/v1/jobs/{id}/cancel` endpoint,
(2) `SIGINT` to the `sd-server` process, (3) `SIGTERM` to the `sd-server` process — each only
attempted once the prior one was confirmed not to work, and each measured for time-to-idle.

## Result

`--diffusion-fa` is **not optional**: the same generation measured roughly 5x slower without it.
Cancellation: this build reports `cancel_generating: false` — the HTTP cancel endpoint cannot stop
an in-flight job. `SIGINT` was tried and measured to be **silently ignored** — the process kept
running and started its next queued job as if nothing happened. The only path that did anything was
`SIGTERM`, which kills the **entire server process**, not just the one job — a real, coarser proxy
for "how fast can the GPU be reclaimed by force" when the HTTP API can't cancel. Measured ~11.2s
from signal to the process dropping below an idle-CPU threshold at 30% of baseline generation time,
though not confirmed fully terminated within the poll window used.

## Decision

Ship `--diffusion-fa` unconditionally for this arm (see [ADR-0007](../decisions/0007-local-image-generation.md)).
Do not build a product-level "cancel this one image job" feature against `sd-server`'s HTTP API —
it doesn't exist. A future implementation needs a subprocess-restart strategy (kill and relaunch the
whole server) if in-flight cancellation is required, not an HTTP job-cancel call — and that
restart's cost (warmup time again) needs to be budgeted into the UX for "cancel."

## Re-check

Re-test cancellation behavior against any newer `stable-diffusion.cpp` release before relying on
this finding — `cancel_generating: false` is a build-specific limitation, not a documented, stable
API contract, and a future release may add real job-level cancellation.
