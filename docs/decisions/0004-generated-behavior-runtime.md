# 0004: Generated behavior runtime

## Status

Proposed. Confirmation requires the M0 sandbox probe (escape attempts, instruction/memory limits, partial-failure recovery).

## Context

D12 requires generated game behavior to activate only after automatic validation; D13 makes Lua optional but requires generated code to have no host access. U04/U05 require a measured, bounded execution boundary, not an assumed one.

## Decision

First candidate: QuickJS via `quickjs-emscripten` (`quickjs-emscripten-core@0.32.0`), which documents `setInterruptHandler`, `setMemoryLimit`, `setMaxStackSize`, and a custom module loader. Run a fresh interpreter instance per execution, disable module loading, expose no host bridge beyond an explicit, validated set of world-API calls, and enforce an outer wall-clock timeout in addition to the interpreter's own limits. `wasmoon` (Lua 5.4 WASM) remains an optional alternate per D13 if a behavior-language requirement later needs Lua semantics, but it lacks documented instruction-budget or hard-memory-limit hooks and would need additional host-side metering.

The world's action validator is the authority regardless of interpreter: a generated behavior that produces an invalid or unauthorized world mutation is rejected by the validator even if the sandbox itself did not fault.

## Consequences

QuickJS's documented limit hooks reduce custom engineering versus Lua, at the cost of behaviors being written in a JS-like language rather than Lua. Escape-attempt and OOM/timeout-recovery tests must run against the exact pinned build before this ADR can move to Accepted. Generated behavior cannot alter its own admission rules regardless of sandbox choice.

## Evidence/links

[architecture-options.md](../product/architecture-options.md) behavior execution section; [stack-2026-09-26.md](../research/stack-2026-09-26.md) sandboxed generated behavior table; [inference-2026-09-26.md](../research/inference-2026-09-26.md) generated-code sandbox section.

## Requirement IDs

U04, U05, D12, D13.
