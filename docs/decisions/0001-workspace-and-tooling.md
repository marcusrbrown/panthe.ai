# 0001: Workspace and tooling

## Status

Accepted.

## Context

Owner decision D19/D21 fixes a Bun-managed workspace and MIT licensing; the workspace layout, build tooling, and CI shape are delegated under D23. [architecture-options.md](../product/architecture-options.md) proposes the `apps/`, `packages/`, `tools/`, `content/` layout used here.

## Decision

Use Bun 1.4.2 workspaces across `apps/*`, `packages/*`, `tools/*`. Tauri 2.12.0 is the desktop shell: Rust crate `tauri`, `@tauri-apps/cli`, and `@tauri-apps/api` are pinned to the same version. The client uses Vite 7 with React 19 (precedent: Mothership uses the same Tauri/Vite/React shape; `three-flatland/react` exists for the renderer integration; no evidence contradicts this pairing). Biome 2 is the formatter/linter. TypeScript runs in strict mode across the workspace.

`bun run check` is the single local gate: typecheck, lint, test. CI runs `bun run check` plus `cargo fmt --check` and `cargo clippy -- -D warnings` for the Tauri Rust side. GitHub Actions are SHA-pinned. Renovate manages dependency updates. No release pipeline exists until M7 (release hardening). Rust crate and JS API minor versions must match unless a tested exception is recorded here.

## Consequences

A fresh checkout has one Bun entry command set and one lockfile (P03). Rust and JS/TS tooling stay separate but both gate CI. Adding a release pipeline before M7 is out of scope and should be reverted if introduced early.

## Evidence/links

[architecture-options.md](../product/architecture-options.md) workspace layout; [stack-2026-09-26.md](../research/stack-2026-09-26.md) Bun/Tauri version research.

## Requirement IDs

P03, P08.
