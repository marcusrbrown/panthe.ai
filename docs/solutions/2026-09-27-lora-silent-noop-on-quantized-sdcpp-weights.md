---
title: A LoRA on a quantized stable-diffusion.cpp checkpoint can silently no-op
date: 2026-09-27
category: content
requirement_ids: [U06, U07]
tags: [stable-diffusion.cpp, lora, quantization, art-local]
---

## Problem

`stable-diffusion.cpp`'s `sd-server` accepts a `--lora-model-dir` and applies a LoRA at request
time regardless of the base checkpoint's quantization. Applying the same pixel-art LoRA to SD 1.5
at Q4_0, Q8_0, and f16 gave visibly different results across arms — but nothing in the server's
HTTP response, logs, or exit code indicates whether the LoRA actually applied. A quantization that
silently drops the LoRA would look identical to a quantization that applies it correctly, unless
you go looking.

## Method

Generate the same fixed-seed prompt twice per quantization: once with `--lora-model-dir` pointing
at the LoRA, once without it (base checkpoint only). Diff the two images. A quantization where the
LoRA is actually applying produces a visibly different (styled) image; a quantization where it
silently no-ops produces the same image both times.

## Result

Q8_0: visible style change with the LoRA present — confirmed applying. Q4_0: the LoRA-present and
LoRA-absent outputs were indistinguishable — the LoRA is a **silent no-op** at this quantization.
f16 (the precision Draw Things uses) crashed the pinned `stable-diffusion.cpp` build reproducibly
when the LoRA was applied — a separate, confirmed upstream bug, not a no-op.

## Decision

Q8_0 is the only tested quantization that combines a working LoRA with a stable server; it is the
accepted base-arm quantization in [ADR-0007](../decisions/0007-local-image-generation.md). Q4_0 is
recorded for speed/RSS comparison only and must never be used to judge LoRA/pixel-art quality or
ship as a default — its numbers looking "fine" is exactly the trap (same speed, same RSS, silently
wrong style).

## Re-check

Any LoRA + quantized-checkpoint pairing added later (a new base model, a new LoRA, a new
quantization level) needs this same fixed-seed with/without diff before being trusted — a plausible
generation time and a plausible-looking image are not evidence the LoRA applied.
