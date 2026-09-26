# 0007: Local image generation

## Status

Proposed. Confirmation requires the M0/M4 local-art probes (baseline memory, duration, cancellation, coexistence with gameplay).

## Context

D15 requires procedural and image-model visual generation with activity taking priority over new artwork; U06/U07 require offline local image generation plus an optional hosted adapter, asynchronous scheduling, and coherent temporary art while a job runs.

## Decision

Procedural composition ships first and is always available, independent of any image model. The first local image-model adapter candidate is `stable-diffusion.cpp` (`sd-server` HTTP interface, Metal acceleration, cross-platform), starting from SD 1.5 at 512px plus a pixel-art LoRA (candidates: PixelArt.Redmond 1.5V, `pixel_dream_LORA` — verify licenses before bundling). Draw Things is a macOS/iOS-only alternate if `sd-server` proves insufficient on that platform. A hosted image adapter remains optional and explicitly configured, never a silent fallback.

## Consequences

No verified seconds-per-image figure exists yet for the M1 Pro 16 GB baseline; the M0/M4 probes set the real scheduling and generation-profile numbers. Image jobs can take minutes; core simulation and input must never block on them (D15, technical-constraints.md). LoRA/model licensing must be checked before any asset ships in the content pack.

## Evidence/links

[inference-2026-09-26.md](../research/inference-2026-09-26.md) local image generation table; [technical-constraints.md](../product/technical-constraints.md) model and image adapters.

## Requirement IDs

U06, U07, D15.
