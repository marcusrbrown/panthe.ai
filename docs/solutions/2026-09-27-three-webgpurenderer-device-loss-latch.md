---
title: three@0.185.1's WebGPURenderer never recovers from a WebGL context loss on the same instance
date: 2026-09-27
category: renderer
requirement_ids: [P02]
tags: [three.js, webgpurenderer, context-loss, webgl2]
---

## Problem

A packaged renderer needs to survive display sleep/wake and other events that can trigger a WebGL
context loss. three.js's `WebGPURenderer` (running its WebGL2 fallback backend here) is documented
to support recovery via an `onDeviceLost` hook and re-calling `init()`, per
[three.js PR #29767](https://github.com/mrdoob/three.js/pull/29767) (October 2024). Whether that
guidance actually holds at the pinned `three@0.185.1` needed to be measured, not assumed.

## Method

Forced a synthetic context loss (`WEBGL_lose_context.loseContext()`, then `restoreContext()` after
2s) against the packaged `.app`, and read `three`'s own source for what state changes on loss and
restore (`WebGLBackend.js`, `Renderer.js` at the pinned version) rather than only observing
black-box behavior.

## Result

`WebGLBackend` registers `webglcontextlost` with `event.preventDefault()`
(`WebGLBackend.js:230–247`); `_isDeviceLost` is set at `Renderer.js:1225–1237` and **never cleared
anywhere in the module** — zero references to `webglcontextrestored` in the installed build.
`dispose()` (`Renderer.js:2533–2567`) doesn't reset it either, and `init()`
(`Renderer.js:767–773`) returns the already-cached `_initPromise` rather than re-initializing — so
re-calling `init()` per the upstream guidance is a no-op at this pinned version. App-level state
(the ECS/sprite objects, raycast hit-testing) recovers fine after a manual rebuild, but the canvas
itself stays permanently blank on the **same renderer instance** after any context loss. A naive
fix (dispose the lost renderer, construct a new `WebGPURenderer` on the *same* canvas) has a trap:
`WebGLBackend.dispose()` (`WebGLBackend.js:2829–2836`) itself calls
`WEBGL_lose_context.loseContext()` on that canvas as part of teardown — forcing a *second* context
loss on the exact canvas a replacement renderer would try to attach to.

## Decision

Treat `onDeviceLost` as the entry to a single-flight recovery state machine, not a terminal error:
(1) detach all handlers bound to the lost renderer/canvas; (2) `dispose()` the old renderer
(accepting it forces `WEBGL_lose_context` per the trap above); (3) create a **fresh** `<canvas>`
element and construct a new `WebGPURenderer` against it, `await init()`; (4) rebuild the
presentation layer from state the app already retains outside the renderer, not from anything the
old instance held; (5) resume only after a render call is independently verified to have produced a
frame (a readback or frame-presented callback — not just "render() didn't throw", which is exactly
what misled the first pass here); (6) bound the retry count and fall through to an explicit failure
UI, never a silently blank window. This pattern is documented but **not implemented or tested** —
see [ADR-0002](../decisions/0002-renderer-backend.md).

## Re-check

Before treating the recovery pattern above as required forever: try a newer `three.js` release and
check whether its `init()` memoization behavior changed (this was not checked in the probe that
found this). Re-test after implementing application-managed reconstruction, and separately test a
real `pmset displaysleepnow` sleep/wake cycle — both remain untested against this specific finding.
