## Question

Do QuickJS (quickjs-emscripten 0.32.x) and Lua (wasmoon 1.16.x) reliably terminate adversarial generated-behavior code and leave the host process healthy for the next execution — and which one settles ADR-0004's sandbox mechanism?

## How to run

```sh
cd tools/probes/sandbox
bun run matrix   # bun run src/run.ts --all
```

Single fixture (what `host.ts` spawns as a child):

```sh
bun run src/run.ts --runtime quickjs --fixture loop-infinite
bun run src/run.ts --runtime lua --fixture loop-infinite
```

Every fixture always runs in its own `Bun.spawn` subprocess — a Worker is in-process and shares the heap, so it cannot give a separate RSS boundary or survive a memory bomb.

## Caveat

Stock QuickJS's `setMemoryLimit` is a **soft** limit against the prebuilt WASM variant used here: with WASM memory growth enabled, a tight allocation loop can grow host memory well past the configured limit before (or instead of) QuickJS raising an OOM error — see [quickjs-emscripten#255](https://github.com/justjake/quickjs-emscripten/issues/255). Separately, the interrupt handler is checked between bytecode instructions, not inside a single native operation, so an operation like a huge array-to-string conversion can run to completion (or to a native OOM/crash) without the interrupt ever firing mid-operation — see [quickjs-emscripten#219](https://github.com/justjake/quickjs-emscripten/issues/219). Both are why every fixture here runs in an isolated, wall-clock-and-RSS-supervised subprocess rather than trusting the in-process limit alone.

## Environment

| Field | Value |
| --- | --- |
| Hardware | Apple M1 Pro |
| Memory | 17179869184 |
| OS | macOS 15.7.9 (24G830) |
| Bun | 1.4.2 |
| Tauri | 2.12.0 |
| Three.js | 0.185.1 |
| Three Flatland | 0.1.0-alpha.10 |
| quickjs-emscripten | 0.32.0 |
| wasmoon | 1.16.0 |

## Results

#### Happy path

| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | `happy-path` | completed | completed | 30 | n/a | exit 0 |
| lua | `happy-path` | completed | completed | 35 | n/a | exit 0 |

#### External capability access

| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | `external-require` | blocked | blocked | 30 | n/a | exit 0 |
| quickjs | `external-process` | blocked | blocked | 30 | n/a | exit 0 |
| quickjs | `external-fetch` | blocked | blocked | 32 | n/a | exit 0 |
| quickjs | `external-bun-global` | blocked | blocked | 29 | n/a | exit 0 |
| quickjs | `external-globalthis-leak` | blocked | blocked | 32 | n/a | exit 0 |
| quickjs | `external-function-eval-ctor` | blocked | blocked | 30 | n/a | exit 0 |
| quickjs | `external-symbol-for` | blocked | blocked | 29 | n/a | exit 0 |
| quickjs | `external-webassembly` | blocked | blocked | 32 | n/a | exit 0 |
| quickjs | `external-atomics-wait` | blocked | blocked | 32 | n/a | exit 0 |
| quickjs | `external-timers` | blocked | blocked | 30 | n/a | exit 0 |
| lua | `external-require` | blocked | blocked | 30 | n/a | exit 0 |
| lua | `external-io-os` | blocked | blocked | 30 | n/a | exit 0 |
| lua | `external-process` | blocked | blocked | 31 | n/a | exit 0 |
| lua | `external-globalthis-leak` | blocked | blocked | 33 | n/a | exit 0 |
| lua | `external-function-eval-ctor` | blocked | blocked | 32 | n/a | exit 0 |

#### Loop / recursion

| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | `loop-infinite` | terminated | terminated | 278 | 70.7 MiB | exit 0 |
| quickjs | `loop-deep-recursion` | terminated | terminated | 31 | n/a | exit 0 |
| lua | `loop-infinite` | terminated | terminated | 282 | 74.8 MiB | exit 0 |
| lua | `loop-deep-recursion` | terminated | terminated | 283 | 74.4 MiB | exit 0 |

#### Allocation

| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | `allocation-array-growth` | terminated | terminated | 355 | 317.0 MiB | exit 0 |
| quickjs | `allocation-string-doubling` | terminated | completed | 34 | n/a | exit 0 |
| quickjs | `allocation-json-stringify-bomb` | terminated | terminated | 292 | 96.1 MiB | exit 0 |
| lua | `allocation-array-growth` | terminated | terminated | 258 | 597.8 MiB | killed by supervisor (SIGKILL) |
| lua | `allocation-string-doubling` | terminated | terminated | 96 | 624.4 MiB | killed by supervisor (SIGKILL) |

#### Async hang

| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | `async-unresolved-promise` | completed | completed | 33 | n/a | exit 0 |
| quickjs | `async-microtask-recursion` | terminated | completed | 30 | n/a | exit 0 |
| lua | `async-coroutine-attempt` | blocked | blocked | 32 | n/a | exit 0 |

#### Malformed API input

| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | `malformed-wrong-types` | blocked | blocked | 32 | n/a | exit 0 |
| quickjs | `malformed-stale-entity-id` | blocked | blocked | 30 | n/a | exit 0 |
| quickjs | `malformed-over-budget` | blocked | blocked | 32 | n/a | exit 0 |
| quickjs | `malformed-proxy-args` | completed | completed | 32 | n/a | exit 0 |
| quickjs | `malformed-getter-side-effect` | blocked | blocked | 33 | n/a | exit 0 |
| quickjs | `malformed-nested-getter-parity` | blocked | blocked | 33 | n/a | exit 0 |
| quickjs | `malformed-coercion` | blocked | blocked | 30 | n/a | exit 0 |
| lua | `malformed-wrong-types` | blocked | blocked | 30 | n/a | exit 0 |
| lua | `malformed-stale-entity-id` | blocked | blocked | 30 | n/a | exit 0 |
| lua | `malformed-over-budget` | blocked | blocked | 31 | n/a | exit 0 |
| lua | `malformed-string-metatable` | blocked | blocked | 30 | n/a | exit 0 |

#### Partial-failure rollback

| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | `partial-failure` | completed | completed | 33 | n/a | exit 0 |
| lua | `partial-failure` | completed | completed | 30 | n/a | exit 0 |

#### Next-run health (after a terminated fixture)

| Runtime | Prior fixture | Prior outcome | Follow-up outcome | Supervisor healthy |
| --- | --- | --- | --- | --- |
| quickjs | `loop-infinite` | terminated | completed | yes |
| lua | `loop-infinite` | terminated | completed | yes |

No external-capability fixture escaped the host boundary in this run.

#### Partial-failure API log evidence

- `quickjs/partial-failure`: 2 staged call(s), status `rolled-back`.
- `lua/partial-failure`: 2 staged call(s), status `rolled-back`.

## Findings

- **`malformed-proxy-args` escape, root cause, and fix (ADR-0004 world-API rule)**: this fixture originally escaped — a `Proxy` `get` trap that alternates its answer by a call-count parity got `{x: 999999, y: 1}` committed as `move()`'s target, because the host read each field via `context.dump()`'s ordinary `[[Get]]`-based traversal. A first attempted fix (dump the same handle twice, reject on disagreement) was tried and **measured to not work**: with exactly two fields and one `get` call per field per dump, every dump starts on the same parity phase as the last, so two independent dumps of the same object always agree with each other while both are equally wrong — verified directly against the running fixture before being discarded. The actual fix reads object fields via property **descriptors** (`Object.getOwnPropertyDescriptor`, i.e. `[[GetOwnProperty]]`) instead of `[[Get]]`: the fixture's Proxy defines only a `get` trap, so the default `getOwnPropertyDescriptor` behavior reads the *target*'s real descriptor directly and the adversarial trap is never invoked at all. Any descriptor carrying a `get`/`set` function, or that isn't writable/enumerable/configurable, is rejected outright — this is why `malformed-getter-side-effect` and the added `malformed-nested-getter-parity` fixture (plain getters, no Proxy, one layer of nesting) are now rejected before their getters ever run (measured: getterInvoked=false, innerReads=0). This is now the standing ADR-0004 rule for every world-API argument, both runtimes: snapshot to plain data using a mechanism that cannot be gamed by a stateful trap (descriptors, not property access), then reject anything that isn't a plain value, array, or `Object.prototype` object with no functions and no accessors. Current measured status: `malformed-proxy-args` → `completed`, committed value `{"x":1,"y":1}` (the *true* target values, not the trap's poisoned ones) — the escape is closed.
- No fixture in either runtime reached a real host capability (filesystem, process, network, Bun, WebAssembly, Atomics) — every external-capability fixture ended `blocked`.
- 13 QuickJS fixture(s) have no Lua equivalent (`fetch`, `Bun`, `WebAssembly`, `Atomics.wait`, timers, `Proxy`-based coercion) because Lua's config (`openStandardLibs: false`, `injectObjects: false`, `enableProxy: false`) leaves no ambient surface for those concepts to exist on in the first place — the absence itself is the finding, not a gap in fixture coverage.
- With `openStandardLibs: false`, the Lua guest has no base library at all: no `pcall`, `error`, `tostring`, `getmetatable`, or `load` beyond the raw language and the injected `api` table. Every bad-path Lua fixture therefore ends the whole chunk with an uncaught runtime error rather than a guest-caught, continuable failure — QuickJS's fixtures can (and do) `try`/`catch` around a rejected call and keep running; Lua's cannot.
- Of 3 QuickJS allocation fixtures: 0 were actually stopped by `setMemoryLimit` raising an out-of-memory error, 1 hit the engine's own max-string-length invariant instead, and 2 grew past 96 MiB (1.5x the configured 64 MiB limit) before anything stopped them (measured peak RSS: `allocation-array-growth` 317 MiB, `allocation-json-stringify-bomb` 96 MiB) — direct, measured confirmation of quickjs-emscripten#255 (`setMemoryLimit` is soft against this growable-WASM build).
- Every runtime's supervisor stayed healthy after a terminated fixture: the very next execution, in a fresh runtime/process, completed normally.
- An unresolved, un-chained promise did not hang this driver (outcome `completed` in 33ms): this driver never calls `runtime.executePendingJobs()`, so a settled-never promise with no reaction simply has nothing left to run. A driver that does drain the job queue would need its own bounded pump loop — the infinite-microtask-recursion fixture exists precisely to measure that case.
- The partial-failure fixture staged exactly 2 call(s) before its intentional throw, and the log's status resolved to `rolled-back` — confirming the transaction boundary holds regardless of how the guest execution ends.
- wasmoon's `CreateEngineOptions` has no memory-limit field at all — capping Lua memory requires the separate, undocumented-here `traceAllocations`+`setMemoryMax` pair, which this probe does not configure per the plan's stated options (`openStandardLibs`, `injectObjects`, `enableProxy`, `functionTimeout`). Both measured Lua allocation fixtures grew unchecked until the outer supervisor's RSS bound killed them (measured peak RSS: `allocation-array-growth` 598 MiB, `allocation-string-doubling` 624 MiB) — unlike QuickJS, Lua as configured here has *no* in-runtime memory boundary, only the external supervisor.

## Bottom line

The `malformed-proxy-args` Proxy-parity escape found earlier in this probe's development is closed: the world API now reads object-argument fields via property descriptors rather than `[[Get]]`, and rejects any accessor (getter/setter) descriptor outright. See Findings for the root cause and why a naive dump-twice-and-compare fix did not work. QuickJS (quickjs-emscripten 0.32.x), run one fresh interpreter per execution inside an isolated `Bun.spawn` subprocess with an outer wall-clock/RSS supervisor, is the mechanism this probe recommends for ADR-0004: it blocked every external-capability fixture and every malformed-input fixture, it can `try`/`catch` a rejected API call and keep running (Lua's zero-stdlib config cannot), and the world's action validator remains the real authority regardless of interpreter. The runtime's own `setMemoryLimit` is **not** sufficient by itself: measured allocation fixtures grew well past the configured 64 MiB before the deadline (not the memory limit) stopped them, confirming quickjs-emscripten#255/#219 directly on this machine. A fixed-memory (non-growable) WASM build, or accepting the subprocess wall-clock/RSS bound as the *real* memory boundary, is required before relying on `setMemoryLimit` alone. Lua (wasmoon 1.16.x) does not win on any measured criterion here: it terminates loops via the same class of mechanism (a `lua_sethook` count hook reachable through `Thread.run({ timeout })`, not through `functionTimeout`/`doString` alone, which only bounds JS callbacks invoked *from* Lua), but its locked-down configuration (`openStandardLibs: false`) leaves generated behaviors with no base library at all, making even ordinary error handling unavailable to the guest. ADR-0004 should stay on QuickJS.