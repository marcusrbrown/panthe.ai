---
title: WKWebView does not expose WebGPU on macOS 15
date: 2026-09-26
last_updated: 2026-09-27
category: renderer
requirement_ids: [P02]
module: probe-renderer
problem_type: integration_issue
severity: high
symptoms:
  - "`typeof navigator.gpu` is `undefined` inside a WKWebView on macOS 15.7.9"
  - unchanged after force-enabling WebKit's private `WebGPUEnabled` feature flag
  - the packaged Tauri app on the same OS reports `renderer.backend.isWebGLBackend === true`
root_cause: config_error
resolution_type: config_change
tags: [webgpu, wkwebview, tauri, macos, webgl2, dual-backend, d25]
---

## Problem

Tauri renders its macOS UI through the system WKWebView. The product direction requested a
WebGPU renderer (Three.js `WebGPURenderer` + Three Flatland) on the M1 Pro macOS 15 baseline. It
was unknown whether the embedded WKWebView exposes `navigator.gpu` on that OS version, which gates
whether the requested renderer works at all on the baseline machine. Deciding this before any
renderer code existed turned a possible rewrite into a one-day probe.

## Symptoms

- `typeof navigator.gpu === "undefined"` in a `WKWebView` on macOS 15.7.9 (WebKit
  20621.3.11.11.3, Apple M1 Pro).
- Same result after enumerating WebKit's private `_features()` / `_experimentalFeatures()` /
  `_internalDebugFeatures()` and force-enabling every GPU-related flag (`WebGPUEnabled`,
  `WebGPUHDREnabled`, `WebXRWebGPUBindingsEnabled`) via `_setEnabled:forFeature:`.
- Later confirmed from inside the packaged probe app: `WEBGL_debug_renderer_info` shows the Apple
  GPU and `renderer.backend.isWebGLBackend` is `true`
  ([tools/probes/renderer-webgl2/README.md](../../tools/probes/renderer-webgl2/README.md)).

## What didn't work

- Private WebKit feature flags. The SPI calls succeed mechanically — no crash, flags read back
  enabled — but WebKit gates the WebGPU JS API to macOS 26; the flag does not unlock it for a
  third-party WKWebView host on 15.
- Treating this as a script problem. The probe is an ad-hoc `swift probe.swift`
  ([tools/probes/webgpu-wkwebview/probe.swift](../../tools/probes/webgpu-wkwebview/probe.swift));
  its only unverified caveat is code-signing, addressed under Re-check.

## Solution

Owner decision D25 (2026-09-26): dual-backend rendering with WebGL2 as the baseline. Keep
Three.js `WebGPURenderer` + Three Flatland and let the renderer pick the backend at runtime —
WebGL2 where `navigator.gpu` is absent (macOS 15 WKWebView), WebGPU where present (macOS 26+,
Windows WebView2 where supported). Recorded in [ADR-0002](../decisions/0002-renderer-backend.md);
P02's acceptance evidence amended to match.

The packaged WebGL2 path was then measured rather than assumed: 17 ms frame p50/p95 (~59 fps),
230 sprites, click-to-visible p50 28 ms / p95 31 ms over 14 real clicks, zero effect failures
([PR #12](https://github.com/marcusrbrown/panthe.ai/pull/12)).

## Why this works

`WebGPURenderer` in three 0.185.1 already carries a WebGL2 backend and selects it when
`navigator.gpu` is missing, so one renderer and one scene graph serve both targets; the cost is
that TSL effects must stay within what the WebGL2 backend transpiles (verified for the probe's
sprite/tilemap/effect set, not for lighting or particles).

## Prevention

- Probe platform capabilities on the actual embedding host (WKWebView, WebView2, WebKitGTK), not
  in a desktop browser — a Safari tab on the same machine is not evidence about WKWebView.
- Keep the backend decision in the renderer, never in content or the simulation, so a WebGPU
  host needs no content changes.
- Any renderer feature added later gets a packaged WebGL2 run before it is relied on.

## Re-check

- Inside a signed `.app` bundle (not the ad-hoc script) on macOS 15 — the only remaining way the
  gate could differ; the ad-hoc-signed packaged probe app already agrees with the script, a
  Developer-ID-signed build has not been tried.
- After the test machine moves to macOS 26: does `navigator.gpu` appear in WKWebView, and does
  the WebGPU backend clear the same packaged measurements?
- Windows WebView2 and WebKitGTK (Linux) remain unprobed; ADR-0002 gates Linux on a packaged
  either-backend result. These four re-checks are listed in
  [docs/product/m0-exit.md](../product/m0-exit.md).

## Related

- [ADR-0002 Renderer backend](../decisions/0002-renderer-backend.md), D25 in
  [decisions.md](../product/decisions.md)
- [three-flatland's koota dependency needs 'unsafe-eval' under Tauri's packaged CSP](2026-09-27-koota-new-function-tauri-csp.md)
  — same packaged surface; a blank packaged window can be CSP, not WebGPU
- [three@0.185.1's WebGPURenderer never recovers from a context loss on the same instance](2026-09-27-three-webgpurenderer-device-loss-latch.md)
  — the WebGL2 backend's recovery limit
- [tools/probes/webgpu-wkwebview/README.md](../../tools/probes/webgpu-wkwebview/README.md),
  [docs/research/stack-2026-09-26.md](../research/stack-2026-09-26.md)
