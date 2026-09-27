---
title: three-flatland's koota dependency needs 'unsafe-eval' under Tauri's packaged CSP
date: 2026-09-27
category: renderer
requirement_ids: [P02]
tags: [koota, csp, tauri, three-flatland, ecs]
---

## Problem

A packaged (`tauri build`) `.app` rendered a completely blank WKWebView content area — no error in
`log show`/`log stream`, no crash, the window itself appeared with correct chrome. `tauri dev` and
`vite preview` + Safari, loading the identical production JS bundle, both worked fine. The blank
window looked like a renderer/WebGPU/WebGL problem but wasn't.

## Method

A debug-profile bundle (`tauri build --debug`, still ad-hoc signed) exposes the WKWebView inspector
without needing the `devtools` Cargo feature; a temporary `window.open_devtools()` call in
`.setup()` (removed once read) surfaced the real error in the Web Inspector's Console tab — the
only place it was visible, since it never reached `log show`/`log stream` for in-page JS
exceptions:

```
EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval'
is not an allowed source of script in the following Content Security Policy
directive: "script-src 'self' 'self' 'sha256-...' ...".
```

Root cause: `three-flatland` depends on `koota` (an ECS library), whose trait system generates its
struct-of-arrays property accessors via `new Function("index", "store", "value", ...)` at
store-creation time — a legitimate perf pattern (compile a specialized accessor once per component
shape), but one requiring `'unsafe-eval'`. This runs during module import, before React's first
commit, so the uncaught `EvalError` aborted the whole module before anything painted. Confirmed
with an A/B: reverting `script-src` to `'self'` alone reproduces the blank window and the identical
error on demand; restoring `'unsafe-eval'` renders correctly every time.

Why only the packaged build was affected: Tauri only synthesizes and enforces a CSP response header
for content served through its own custom protocol (`tauri://localhost` on macOS) — what
`frontendDist`-based production builds use. `tauri dev` serves from Vite's dev server over plain
HTTP (no CSP header at all); `vite preview` + a normal browser tab has no CSP either. Neither
reproduces a CSP violation regardless of what the bundle actually needs.

## Result

Fix: add `'unsafe-eval'` to `app.security.csp.script-src` in both `tauri.conf.json` (production)
and `tauri.dev.conf.json` (kept in sync for if/when `devUrl` enforcement changes) — not
`'wasm-unsafe-eval'`; the violated directive was explicitly `'unsafe-eval'` and nothing in this
scene exercises WASM.

## Decision

Any Panthea surface that imports `three-flatland` must include `'unsafe-eval'` in `script-src`.
This is conditional on U05 holding: the generated-behavior runtime must stay isolated in the
simulation service and never load into the renderer's WKWebView/JS realm — `'unsafe-eval'` here
widens what the renderer's own trusted first-party code can do, not what generated content can do.
See [ADR-0002](../decisions/0002-renderer-backend.md). The alternative that removes the requirement
entirely is patching `koota`'s accessor generation to avoid `new Function(...)` (a generic
interpreted accessor, or build-time codegen) — worth an upstream issue/PR rather than treating
`'unsafe-eval'` as permanent.

## Re-check

Re-verify this CSP requirement whenever `apps/client`/`apps/desktop` adopt `three-flatland` for
real (not just the probe app), and re-check it against U05 whenever the generated-behavior/renderer
process boundary changes. Also worth periodically checking whether a `koota`/`three-flatland`
release removes the `new Function` accessor path.
