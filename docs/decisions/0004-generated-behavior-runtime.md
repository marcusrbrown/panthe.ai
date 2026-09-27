# 0004: Generated behavior runtime

## Status

Accepted (2026-09-27). Confirmed by the M0 sandbox probe: both QuickJS and Lua terminate every adversarial fixture with the host process intact; QuickJS is the recommended mechanism, with the outer subprocess wall-clock/RSS supervisor — not the interpreter's own `setMemoryLimit` — as the real, guaranteed memory boundary (`tools/probes/sandbox/README.md`).

## Context

D12 requires generated game behavior to activate only after automatic validation; D13 makes Lua optional but requires generated code to have no host access. U04/U05 require a measured, bounded execution boundary, not an assumed one.

## Decision

First candidate: QuickJS via `quickjs-emscripten` (`quickjs-emscripten-core@0.32.0`), which documents `setInterruptHandler`, `setMemoryLimit`, `setMaxStackSize`, and a custom module loader. Run a fresh interpreter instance per execution, disable module loading, expose no host bridge beyond an explicit, validated set of world-API calls, and enforce an outer wall-clock timeout in addition to the interpreter's own limits. `wasmoon` (Lua 5.4 WASM) remains an optional alternate per D13 if a behavior-language requirement later needs Lua semantics, but it lacks documented instruction-budget or hard-memory-limit hooks and would need additional host-side metering.

The world's action validator is the authority regardless of interpreter: a generated behavior that produces an invalid or unauthorized world mutation is rejected by the validator even if the sandbox itself did not fault.

## Consequences

QuickJS's documented limit hooks reduce custom engineering versus Lua, at the cost of behaviors being written in a JS-like language rather than Lua. Escape-attempt and OOM/timeout-recovery tests must run against the exact pinned build before this ADR can move to Accepted — **done**, see below. Generated behavior cannot alter its own admission rules regardless of sandbox choice.

**Confirmed by measurement** ([tools/probes/sandbox/README.md](../../tools/probes/sandbox/README.md)): across every external-capability fixture in both runtimes (`require`/`import`/`io`/`os`/`process`/`fetch`/`Bun`/`Function`-`eval`-ctor/`Symbol.for`/`WebAssembly`/`Atomics.wait`/timers), zero escapes reached the host — every fixture ended `blocked`. Three escalating rounds of a `Proxy`/property-descriptor argument-capture bypass were found and closed during this probe (a parity-flipping `Proxy` `get` trap on `move()`'s arguments, then a guest-poisoned `Object.getOwnPropertyDescriptor` global read at call time, then the fix: capturing the descriptor-reader function's handle immediately after `newContext()`, before any guest source ever runs, so there is no live global binding left to poison) — **0 escapes remain** after the fix; every malformed-input and integrity fixture (`malformed-proxy-args`, `malformed-getter-side-effect`, `malformed-nested-getter-parity`, `malformed-overwrite-descriptor-fn`, `malformed-proxy-descriptor-trap`) matched its expected outcome.

QuickJS's `setMemoryLimit` is confirmed **soft**: two of three allocation fixtures grew to roughly 1.5x the configured 64 MiB limit (298 MiB and 99 MiB peak RSS) before anything recognized stopped them, and zero allocation fixtures were actually stopped by `setMemoryLimit` itself raising an OOM error — directly confirming quickjs-emscripten#255/#219 on this machine, not merely citing them. The outer `Bun.spawn`-per-execution subprocess with a wall-clock/RSS supervisor is therefore the real, guaranteed memory boundary, not the interpreter's own limit hooks; every fixture still terminated (via the deadline, the RSS supervisor, or an incidental engine invariant), and the very next execution in a fresh runtime was healthy after every terminated fixture. A fixed-memory QuickJS WASM build remains M1 sandbox hardening (deferred per the plan's Scope Boundaries), not an M0 blocker.

`wasmoon`/Lua (`openStandardLibs: false`, `injectObjects: false`, `enableProxy: false`) also blocked every capability fixture it has an equivalent for (15 QuickJS-only fixtures have no Lua equivalent because Lua's zero-stdlib config leaves no ambient surface for `fetch`/`Bun`/`WebAssembly`/etc. to exist on in the first place), but it has **no memory-limit hook at all** — both Lua allocation fixtures grew unchecked to 541–592 MiB before the external RSS supervisor killed them — and, with `openStandardLibs: false`, cannot `try`/`catch` a rejected API call to keep running the way QuickJS's guest code can. It remains the D13-optional alternate, not the primary. The partial-failure fixture left exactly the committed calls with a `rolled-back` marker in both runtimes, confirming the transaction boundary holds regardless of interpreter.

## Evidence/links

[architecture-options.md](../product/architecture-options.md) behavior execution section; [stack-2026-09-26.md](../research/stack-2026-09-26.md) sandboxed generated behavior table; [inference-2026-09-26.md](../research/inference-2026-09-26.md) generated-code sandbox section; [tools/probes/sandbox/README.md](../../tools/probes/sandbox/README.md).

## Requirement IDs

U04, U05, D12, D13.
