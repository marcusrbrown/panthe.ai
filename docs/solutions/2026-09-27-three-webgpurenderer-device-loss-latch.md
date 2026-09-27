---
title: three@0.185.1's WebGPURenderer never recovers from a WebGL context loss on the same instance
date: 2026-09-27
category: renderer
requirement_ids: [P02, P05]
module: probe-renderer
problem_type: integration_issue
severity: high
symptoms:
  - "`webglcontextlost` and `webglcontextrestored` both fire, but the same renderer instance stays blank"
  - sprites are rebuilt from retained app state, yet no pixels are presented
  - click-to-visible latency kept resolving after loss until it was gated
root_cause: wrong_api
resolution_type: code_fix
tags: [three-js, webgpurenderer, webgl2, context-loss, device-lost, recovery, probe-renderer]
---

## Problem

A packaged renderer must survive display sleep/wake and other events that drop the WebGL
context. three.js documents recovery for `WebGPURenderer` via an `onDeviceLost` hook that
re-calls `init()` ([three.js PR #29767](https://github.com/mrdoob/three.js/pull/29767)). On the
pinned 0.185.1 with the WebGL2 backend, that contract does not hold: the browser restores the
context, the renderer instance never resumes.

## Symptoms

- Forced loss via `WEBGL_lose_context` (`l` key in the probe app): `lostCount` and
  `restoredCount` both increment, `spriteCount` rebuilds to 230, the canvas stays blank.
- The probe's first report published a 21 ms "post-loss click latency" — fabricated, because
  `noteRenderSubmitted` was called for frames that were never presented.

## What didn't work

- Rebuilding scene state on the same renderer (`apps/probe-renderer/src/Scene.tsx`, `onLost`):
  logical state returns, pixels do not.
- Disposing and re-initialising on the same canvas: `WebGLBackend.dispose()` calls
  `WEBGL_lose_context.loseContext()` itself, so a replacement renderer on that canvas loses
  context again.
- `renderer.init()` as a reset: `init()` returns its cached promise, and the `_isDeviceLost`
  latch set in the lost handler is never cleared (`Renderer.js` ~1225–1237; `dispose()`
  ~2533–2567 does not reset it; `init()` ~767–773 returns the memoised promise).
- The first write-up's "force-quit required" — overstated. An independent source review
  confirmed the latch and the lack of automatic recovery, and pointed out that app-managed
  reconstruction had simply not been tested.

## Solution

Treat loss as a single-flight recovery state machine, recorded for ADR-0002:

1. `onDeviceLost` enters `recovering`; ignore re-entrant loss events.
2. Detach input handlers, clear selection, drop in-flight click timing.
3. Dispose the old renderer; create a **fresh canvas** and a new renderer; `await init()`.
4. Rebuild the presentation layer from app-retained state (the simulation owns truth, so nothing
   is lost).
5. Resume only after a verified frame has been presented.
6. Bounded retries, then an explicit failure UI.

Metrics honesty in the meantime (`apps/probe-renderer/src/metrics.ts`, `Scene.tsx`):
`ClickLatencyTracker.hitCount` counts every raycast hit; a `deviceLost` flag set in `onLost` and
never cleared gates `noteRenderSubmitted`, so latency freezes at its pre-loss value instead of
inventing post-loss numbers. Verified on the packaged app: after loss+restore a new click bumps
`clickHitCount` 1→2 while `clickToVisibleLatencyMs` stays exactly frozen.

## Why this works

The renderer's lost state is a one-way latch in this build, `init()` is memoised, and
`dispose()` tears the backend down by losing its own context — so nothing on the same instance
or canvas can bring pixels back. A fresh canvas plus a new renderer is the only path the code
allows, and gating the metric on a presented frame keeps the evidence truthful until that path
is implemented.

## Prevention

- Keep CPU-side hit counting separate from visible-latency reporting; never record a render as
  submitted unless the caller can vouch a frame was presented.
- Label the last pre-loss latency stale in the overlay (open nit from
  [PR #12](https://github.com/marcusrbrown/panthe.ai/pull/12)).
- No same-canvas dispose/re-init recovery gets approved without a packaged-app proof on the
  exact three build shipped.

## Re-check

- On every three.js bump: is `_isDeviceLost` still never cleared, is `init()` still cached, does
  `WebGLBackend.dispose()` still lose its own context?
- App-managed fresh-canvas reconstruction is documented but **untested**; real sleep/wake
  (`pmset displaysleepnow`) is **untested** — forced `WEBGL_lose_context` is not a full
  suspend/resume proxy. Both are M1 renderer work.

## Related

- [ADR-0002 Renderer backend](../decisions/0002-renderer-backend.md) — recovery pattern
- [WKWebView does not expose WebGPU on macOS 15](2026-09-26-wkwebview-webgpu-unavailable-macos-15.md)
  — why the WebGL2 backend is the one that matters here
- [three-flatland's koota dependency needs 'unsafe-eval' under Tauri's packaged CSP](2026-09-27-koota-new-function-tauri-csp.md)
  — same probe app
- [tools/probes/renderer-webgl2/README.md](../../tools/probes/renderer-webgl2/README.md),
  [PR #12](https://github.com/marcusrbrown/panthe.ai/pull/12)
