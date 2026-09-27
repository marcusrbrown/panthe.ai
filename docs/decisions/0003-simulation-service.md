# 0003: Simulation service

## Status

Accepted (2026-09-27). Confirmed by the M0 backend-lifecycle probe: all five required lifecycle transitions pass against a packaged, ad-hoc-signed `.app`, each hard-asserted by a script that exits non-zero on the first violated invariant (`tools/probes/backend-lifecycle/README.md`).

## Context

[architecture-options.md](../product/architecture-options.md) recommends a separate authoritative simulation service rather than folding world state into the renderer. D23 delegates the exact backend choice; W03 and O03 require offscreen evolution and capped catch-up even when the window is closed.

## Decision

Confirmed shape: a Bun TypeScript service using `bun:sqlite`, packaged as a Tauri sidecar (one binary per target triple via `bundle.externalBin`) and run as a supervised child process of the Tauri app. The app stays alive in system tray mode after window close, with an explicit Quit command, rather than silently terminating the service. The backend-lifecycle probe confirms tray-mode supervision is sufficient for every required transition; the fallback — a separate OS-managed agent (Launch Agent/service) with authenticated local IPC, a heavier install/upgrade path — is **not needed** for M0/M1 and stays a documented alternative only if tray-mode supervision is later found insufficient (e.g., a requirement for the world to outlive a full app quit).

## Consequences

Sidecar spawn/shutdown is not a documented auto-detach guarantee; the app must track the child handle and shut it down explicitly, watching for orphaned processes — **confirmed handled**: both the stdin-EOF path and the parent-PID poll are load-bearing orphan guards, and a force-killed shell leaves no orphaned sidecar. Per-platform binary signing and notarization for a Bun sidecar inside a Tauri bundle is unverified (ad-hoc signing only, per M0 scope) and still needs its own packaging test before M7. Choosing the tray-supervised model over the OS-agent model trades simplicity for the world not surviving a full app quit unless the operator chooses background mode explicitly (per defaults.md "Background mode").

**Confirmed by measurement** ([tools/probes/backend-lifecycle/README.md](../../tools/probes/backend-lifecycle/README.md)): window close keeps the sidecar ticking in tray mode (event count strictly increased, 161→166, in the 5s after close); an explicit quit (SIGTERM to the shell, the tray-Quit equivalent) exits both processes within 10s with no orphan; a `kill -9`'d sidecar is restarted by the shell's supervisor with strictly increasing event ids (169→172), never a reset; a force-killed shell leaves no orphan (the sidecar self-terminates via stdin-EOF in under 1s, faster than the 2s parent-PID poll backstop); a duplicate launch is refused before it ever reaches the sidecar (`tauri-plugin-single-instance` registered first, confirmed exactly one `panthea-sim` process throughout); and a simulated sleep/resume (`SIGSTOP`/`SIGCONT`, 120s, a safe stand-in for the wall-clock effect of a real sleep) applies its elapsed interval **exactly once**, bounded below by the actual stop duration (120923 ms applied for a 120000 ms stop) — no double-apply, no drop. The shell↔sidecar auth token is required on every request (a request without it is rejected with 401); the compiled sidecar binary (`bun build --compile`, 59 MB) embeds no build-host path, username, or secret-shaped environment value, and needs no `bun` on the runtime PATH. `PRAGMA integrity_check` passed after every kill. One item remains an unscripted, manual spot-check before this ships to a real device: a genuine `pmset sleepnow`/lid-close cycle — `SIGSTOP`/`SIGCONT` is a safe, sufficient stand-in for the clock-cursor guarantee but not a substitute for observing the actual OS sleep/wake process lifecycle once.

**Heavy-work memory policy** (measured by the M0 coexistence probe, [tools/probes/coexistence/README.md](../../tools/probes/coexistence/README.md); canonical wording and full numbers in [ADR-0005](0005-model-providers.md)): image generation must be admission-gated, not run unconstrained or behind a global mutex, so it never blocks LLM inference or the renderer. A global mutex serializing all heavy work measured a +1404% LLM p95 penalty (one LLM request waiting out a full image job); unconstrained concurrency measured +44%; both are rejected. An admission-controlled queue (image jobs start only when free+inactive memory is ≥ 3 GiB, one image job in flight) measured -10.6% LLM p95 while completing every queued image job. The simulation service is the natural place to enforce this admission gate: it already owns process supervision and is the authoritative source for what else is running, so a future implementation should have it (or a layer it directly coordinates with) gate image-job starts rather than duplicating that state in `packages/agents`/`packages/assets`.

## Evidence/links

[architecture-options.md](../product/architecture-options.md) backend comparison; [inference-2026-09-26.md](../research/inference-2026-09-26.md) backend lifecycle in Tauri; [tools/probes/backend-lifecycle/README.md](../../tools/probes/backend-lifecycle/README.md); [tools/probes/coexistence/README.md](../../tools/probes/coexistence/README.md).

## Requirement IDs

P01, P03, W03, O03.
