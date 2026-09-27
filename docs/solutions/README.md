# Solutions

Reusable engineering lessons captured through the Systematic compound workflow (`ce:compound`). Write an entry whenever a probe, a bug, or a design dead-end produces a lesson worth not re-deriving later.

## Frontmatter convention

Each entry is `docs/solutions/YYYY-MM-DD-slug.md` with YAML frontmatter following the `ce:compound` schema, plus this project's `category` and `requirement_ids`:

```yaml
---
title: Short problem statement
date: YYYY-MM-DD
category: renderer | backend | sandbox | providers | telemetry | content | tooling
requirement_ids: [P02]
module: probe-renderer
problem_type: integration_issue   # ce:compound enum; bug track (defects) or knowledge track (guidance)
severity: high
symptoms: […]                     # bug track: 1–5; knowledge track: use applies_when instead
root_cause: config_error          # bug track
resolution_type: config_change    # bug track
tags: [webgpu, wkwebview, macos]
---
```

Body sections (bug track): Problem, Symptoms, What didn't work, Solution, Why this works, Prevention, Re-check, Related. Knowledge track: Problem/Context, Method, Result, Why this works, Prevention, Decision, Re-check, Related. Always link the ADR or decision row and the probe README that carries the evidence; Re-check says how and when to redo the investigation.

## Entries

| Date | Title | Requirement IDs |
| --- | --- | --- |
| [2026-09-26](2026-09-26-wkwebview-webgpu-unavailable-macos-15.md) | WKWebView does not expose WebGPU on macOS 15 | P02 |
| [2026-09-27](2026-09-27-koota-new-function-tauri-csp.md) | three-flatland's koota dependency needs 'unsafe-eval' under Tauri's packaged CSP | P02 |
| [2026-09-27](2026-09-27-three-webgpurenderer-device-loss-latch.md) | three@0.185.1's WebGPURenderer never recovers from a WebGL context loss on the same instance | P02 |
| [2026-09-27](2026-09-27-proxy-descriptor-argument-capture-sandbox.md) | Reading validated arguments out of a sandboxed guest needs a captured accessor handle, not a live global lookup | U04, U05 |
| [2026-09-27](2026-09-27-ollama-runner-pid-rss-sampling.md) | Sampling Ollama's real memory usage needs re-resolving the runner child pid every poll | P04, P06 |
| [2026-09-27](2026-09-27-tcpdump-sudo-pid-resolution-offline-proof.md) | Proving "offline mode sends nothing" needs a self-owned, falsifiable packet capture | P07 |
| [2026-09-27](2026-09-27-lora-silent-noop-on-quantized-sdcpp-weights.md) | A LoRA on a quantized stable-diffusion.cpp checkpoint can silently no-op | U06, U07 |
| [2026-09-27](2026-09-27-sdcpp-cancel-sigint-diffusion-fa.md) | stable-diffusion.cpp needs --diffusion-fa and has no real job cancellation | U06, U07 |
