# 0003: Simulation service

## Status

Proposed. Confirmation requires the M0 backend lifecycle probe (start, close window, stop, restart, crash, sleep/resume, duplicate-start).

## Context

[architecture-options.md](../product/architecture-options.md) recommends a separate authoritative simulation service rather than folding world state into the renderer. D23 delegates the exact backend choice; W03 and O03 require offscreen evolution and capped catch-up even when the window is closed.

## Decision

First candidate: a Bun TypeScript service using `bun:sqlite`, packaged as a Tauri sidecar (one binary per target triple via `bundle.externalBin`) and run as a supervised child process of the Tauri app. The app stays alive in system tray mode after window close, with an explicit Quit command, rather than silently terminating the service. If the service must outlive the app entirely (e.g., world continues after full app quit), the fallback is a separate OS-managed agent (Launch Agent/service) with authenticated local IPC — a heavier install/upgrade path, used only if tray-mode supervision proves insufficient.

## Consequences

Sidecar spawn/shutdown is not a documented auto-detach guarantee; the app must track the child handle and shut it down explicitly, watching for orphaned processes. Per-platform binary signing and notarization for a Bun sidecar inside a Tauri bundle is unverified and needs its own packaging test before M7. Choosing the tray-supervised model over the OS-agent model trades simplicity for the world not surviving a full app quit unless the operator chooses background mode explicitly (per defaults.md "Background mode").

## Evidence/links

[architecture-options.md](../product/architecture-options.md) backend comparison; [inference-2026-09-26.md](../research/inference-2026-09-26.md) backend lifecycle in Tauri.

## Requirement IDs

P01, P03, W03, O03.
