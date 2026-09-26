---
title: WKWebView does not expose WebGPU on macOS 15
date: 2026-09-26
category: renderer
requirement_ids: [P02]
tags: [webgpu, wkwebview, tauri, macos]
---

## Problem

Tauri renders its macOS UI through the system WKWebView. The product direction requested a WebGPU renderer (Three.js `WebGPURenderer` + Three Flatland) on the M1 Pro macOS 15 baseline. It was unknown whether the embedded WKWebView exposes `navigator.gpu` on that OS version, which gates whether the requested renderer works at all on the baseline machine.

## Method

Ran [tools/probes/webgpu-wkwebview/probe.swift](../../tools/probes/webgpu-wkwebview/probe.swift), an ad-hoc Swift script (`swift probe.swift`, no Xcode project) that creates a `WKWebView` and evaluates `typeof navigator.gpu` inside it. Two runs: (a) default `WKWebViewConfiguration`; (b) same, but first enumerating WebKit's private `_features()` / `_experimentalFeatures()` / `_internalDebugFeatures()` SPI, finding every GPU-related flag, and force-enabling all of them (including `WebGPUEnabled`) via `_setEnabled:forFeature:` before creating the view. Environment: macOS 15.7.9, WebKit 20621.3.11.11.3, Apple M1 Pro.

Private WebKit feature-flag enumeration/enabling worked mechanically (no crash, calls succeeded) — the failure is not a broken script, it's WebGPU genuinely not wired up for this WKWebView on this OS.

## Result

`navigator.gpu` was `undefined` in both runs, including after force-enabling `WebGPUEnabled`. No adapter/device was reachable in either run. WebKit gates the WebGPU JS API to macOS 26; the private feature flag does not unlock it on macOS 15 for a third-party WKWebView host. Caveat: the probe ran as an unsigned `swift <file>` process, not a signed `.app` bundle — if WebKit's gating depends on code-signing/entitlements rather than purely the feature flag, a packaged Tauri `.app` could theoretically behave differently. That is unverified and worth a second data point if it becomes load-bearing.

## Decision

Dual-backend rendering, WebGL2 baseline: keep Three.js `WebGPURenderer` + Three Flatland, but use the WebGL2 backend where `navigator.gpu` is absent (macOS 15 WKWebView) and WebGPU where present (macOS 26+, Windows WebView2 where supported). See [ADR-0002](../decisions/0002-renderer-backend.md) and decision D25 in [decisions.md](../product/decisions.md). P02's acceptance evidence was amended accordingly.

## Re-check

Re-run this probe (or the packaged-app equivalent) after upgrading the test machine to macOS 26, and separately inside a signed `.app` bundle rather than an ad-hoc script, before assuming the WebGPU code path is available on any macOS target. Also re-run against Windows WebView2 and WebKitGTK (Linux) — neither has been probed yet.
