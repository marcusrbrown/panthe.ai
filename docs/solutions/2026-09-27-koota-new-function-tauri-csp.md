---
title: three-flatland's koota dependency needs 'unsafe-eval' under Tauri's packaged CSP
date: 2026-09-27
category: renderer
requirement_ids: [P02]
module: probe-renderer
problem_type: integration_issue
severity: high
symptoms:
  - packaged Tauri .app shows a blank white WKWebView with correct window chrome
  - no CSP or JS error in `log show` / `log stream`
  - Web Inspector logs `EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source`
  - `tauri dev` and `vite preview` + Safari render the identical bundle fine
root_cause: config_error
resolution_type: config_change
tags: [koota, csp, tauri, three-flatland, ecs, unsafe-eval, wkwebview]
---

## Problem

A packaged (`tauri build`) `.app` rendered a completely blank WKWebView content area — no error
in `log show`/`log stream`, no crash, the window appeared with correct chrome. `tauri dev` and
`vite preview` + Safari, loading the identical production JS bundle, both worked. The first
`tauri dev` run of the probe had shown the scene; the blank window appeared after the probe's own
edits, which reframed it as a regression rather than a bundling property.

## Symptoms

- Blank white content area in the packaged app only.
- Nothing in the unified log for in-page JS exceptions.
- Once the Web Inspector was reachable: `EvalError: Refused to evaluate a string as JavaScript
  because 'unsafe-eval' is not an allowed source of script in the following Content Security
  Policy directive: "script-src 'self' …"`.

## What didn't work

- Chasing WebGL2 / three-flatland / renderer initialisation — the failure is a synchronous throw
  before first paint.
- Reading the unified log — WKWebView does not forward in-page exceptions there.
- Treating `vite preview` in Safari as a stand-in for the packaged app — a browser tab has no
  CSP, so it cannot reproduce a CSP violation whatever the bundle needs.

## Solution

Add `'unsafe-eval'` to `script-src` in both config files:

```json
"script-src": "'self' 'unsafe-eval'"
```

`apps/probe-renderer/src-tauri/tauri.conf.json:23` (production) and
`apps/probe-renderer/src-tauri/tauri.dev.conf.json:7` (kept in sync). Not `'wasm-unsafe-eval'` —
the violated directive was `'unsafe-eval'` and nothing in the scene touches WASM.

Diagnosis path: a debug-profile bundle (`tauri build --debug`, still ad-hoc signed) plus a
temporary `window.open_devtools()` in `.setup()` exposed the Web Inspector Console; the
`EvalError` was visible there and nowhere else. Verified by A/B: reverting to `'self'` alone
reproduces the blank window and the identical error on demand; restoring `'unsafe-eval'` renders
every time. Measured afterwards on the packaged binary: 17 ms frame p50/p95, 59 fps, 230 sprites,
zero effect failures ([PR #12](https://github.com/marcusrbrown/panthe.ai/pull/12)).

## Why this works

`three-flatland` depends on `koota` (ECS), whose trait system generates struct-of-arrays property
accessors with `new Function("index", "store", "value", …)` at store-creation time
(`koota/dist/chunk-*.js`, called from `three-flatland/dist/ecs/traits.js`; upstream
`packages/core/src/storage/accessors.ts`). That runs during module import, before React's first
commit, so the uncaught `EvalError` aborts the module before anything paints. Tauri only
synthesises and enforces the CSP header for content served through its own protocol
(`tauri://localhost` on macOS — what `frontendDist` builds use); `tauri dev` serves from Vite's
dev server over plain HTTP with no CSP header, and a browser tab has none either.

## Decision

Any Panthea surface that imports `three-flatland` carries `'unsafe-eval'` in `script-src`,
recorded in [ADR-0002](../decisions/0002-renderer-backend.md). This is conditional on U05: the
generated-behavior runtime stays in the simulation service and never loads into the renderer's JS
realm, so `'unsafe-eval'` widens what trusted first-party renderer code may do, not what generated
content may do. The scope is renderer shells that load this dependency chain — the probe proves
nothing about `apps/client`/`apps/desktop` until they are packaged with it.

## Prevention

- Test the packaged bundle, not `tauri dev` or a browser preview, before calling a renderer
  change verified.
- When adding a frontend dependency, grep its built artifacts for `new Function(` and `eval(`
  before assuming CSP compatibility.
- Keep the exception documented in ADR-0002 with the U05 condition; treat patching koota's
  accessor generation (interpreted accessor or build-time codegen) as the upstream path to
  removing it.

## Re-check

- On any `koota` or `three-flatland` upgrade: does koota still generate accessors with
  `new Function`?
- When `apps/client`/`apps/desktop` adopt three-flatland for real, and whenever the
  generated-behavior/renderer process boundary (U05) changes.
- On Tauri CSP or protocol changes.

## Related

- [ADR-0002 Renderer backend](../decisions/0002-renderer-backend.md)
- [WKWebView does not expose WebGPU on macOS 15](2026-09-26-wkwebview-webgpu-unavailable-macos-15.md)
  — same packaged WKWebView surface; a blank packaged window can be CSP, not only WebGPU absence
- [three@0.185.1's WebGPURenderer never recovers from a context loss on the same instance](2026-09-27-three-webgpurenderer-device-loss-latch.md)
  — same probe app, different failure
- [docs/research/stack-2026-09-26.md](../research/stack-2026-09-26.md),
  [tools/probes/renderer-webgl2/README.md](../../tools/probes/renderer-webgl2/README.md),
  [PR #12](https://github.com/marcusrbrown/panthe.ai/pull/12)
