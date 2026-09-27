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
| quickjs | `happy-path` | completed | completed | 33 | n/a | exit 0 |
| lua | `happy-path` | completed | completed | 33 | n/a | exit 0 |

#### External capability access

| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | `external-require` | blocked | blocked | 30 | n/a | exit 0 |
| quickjs | `external-process` | blocked | blocked | 31 | n/a | exit 0 |
| quickjs | `external-fetch` | blocked | blocked | 31 | n/a | exit 0 |
| quickjs | `external-bun-global` | blocked | blocked | 29 | n/a | exit 0 |
| quickjs | `external-globalthis-leak` | blocked | blocked | 34 | n/a | exit 0 |
| quickjs | `external-function-eval-ctor` | blocked | blocked | 32 | n/a | exit 0 |
| quickjs | `external-symbol-for` | blocked | blocked | 32 | n/a | exit 0 |
| quickjs | `external-webassembly` | blocked | blocked | 31 | n/a | exit 0 |
| quickjs | `external-atomics-wait` | blocked | blocked | 30 | n/a | exit 0 |
| quickjs | `external-timers` | blocked | blocked | 28 | n/a | exit 0 |
| lua | `external-require` | blocked | blocked | 32 | n/a | exit 0 |
| lua | `external-io-os` | blocked | blocked | 31 | n/a | exit 0 |
| lua | `external-process` | blocked | blocked | 32 | n/a | exit 0 |
| lua | `external-globalthis-leak` | blocked | blocked | 31 | n/a | exit 0 |
| lua | `external-function-eval-ctor` | blocked | blocked | 32 | n/a | exit 0 |

#### Loop / recursion

| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | `loop-infinite` | terminated | terminated | 279 | 67.9 MiB | exit 0 |
| quickjs | `loop-deep-recursion` | terminated | terminated | 32 | n/a | exit 0 |
| lua | `loop-infinite` | terminated | terminated | 284 | 80.1 MiB | exit 0 |
| lua | `loop-deep-recursion` | terminated | terminated | 282 | 79.3 MiB | exit 0 |

#### Allocation

| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | `allocation-array-growth` | terminated | terminated | 338 | 298.0 MiB | exit 0 |
| quickjs | `allocation-string-doubling` | terminated | terminated | 30 | n/a | exit 0 |
| quickjs | `allocation-json-stringify-bomb` | terminated | terminated | 292 | 98.8 MiB | exit 0 |
| lua | `allocation-array-growth` | terminated | terminated | 608 | 592.5 MiB | killed by supervisor (SIGKILL) |
| lua | `allocation-string-doubling` | terminated | terminated | 94 | 540.6 MiB | killed by supervisor (SIGKILL) |

#### Async hang

| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | `async-unresolved-promise` | completed | completed | 29 | n/a | exit 0 |
| quickjs | `async-microtask-recursion` | terminated | terminated | 95 | 67.1 MiB | exit 0 |
| lua | `async-coroutine-attempt` | blocked | blocked | 31 | n/a | exit 0 |

#### Malformed API input

| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | `malformed-wrong-types` | blocked | blocked | 31 | n/a | exit 0 |
| quickjs | `malformed-stale-entity-id` | blocked | blocked | 33 | n/a | exit 0 |
| quickjs | `malformed-over-budget` | blocked | blocked | 33 | n/a | exit 0 |
| quickjs | `malformed-proxy-args` | completed | completed | 34 | n/a | exit 0 |
| quickjs | `malformed-getter-side-effect` | blocked | blocked | 33 | n/a | exit 0 |
| quickjs | `malformed-nested-getter-parity` | blocked | blocked | 33 | n/a | exit 0 |
| quickjs | `malformed-overwrite-descriptor-fn` | completed | completed | 33 | n/a | exit 0 |
| quickjs | `malformed-proxy-descriptor-trap` | completed | completed | 33 | n/a | exit 0 |
| quickjs | `malformed-coercion` | blocked | blocked | 34 | n/a | exit 0 |
| lua | `malformed-wrong-types` | blocked | blocked | 32 | n/a | exit 0 |
| lua | `malformed-stale-entity-id` | blocked | blocked | 31 | n/a | exit 0 |
| lua | `malformed-over-budget` | blocked | blocked | 32 | n/a | exit 0 |
| lua | `malformed-string-metatable` | blocked | blocked | 31 | n/a | exit 0 |

#### Partial-failure rollback

| Runtime | Fixture | Expected | Outcome | Time (ms) | Peak RSS | Exit |
| --- | --- | --- | --- | --- | --- | --- |
| quickjs | `partial-failure` | completed | completed | 33 | n/a | exit 0 |
| lua | `partial-failure` | completed | completed | 31 | n/a | exit 0 |

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

- **Round 1 (escape found)**: a `Proxy` `get` trap that alternates its answer by call-count parity got `{x: 999999, y: 1}` committed as `move()`'s target, because the host read each field via `context.dump()`'s ordinary `[[Get]]`-based traversal. A naive fix (dump the same handle twice, reject on disagreement) was tried and **measured to not work**: with exactly two fields and one `get` call per field per dump, every dump starts on the same parity phase as the last, so two independent dumps always agree with each other while both are equally wrong — verified directly against the fixture before being discarded. **Round 2 (descriptor fix, still bypassed)**: reading fields via `Object.getOwnPropertyDescriptor` (`[[GetOwnProperty]]`) instead of `[[Get]]` closed the parity-flip Proxy, but a code review (Fro Bot) reproduced a stronger bypass: the descriptor-reading helper was a small function evaluated *inside the guest context*, and its body still referenced the identifier `Object.getOwnPropertyDescriptor`  — a dynamic lookup resolved at CALL time, not at the time the helper was defined. `malformed-overwrite-descriptor-fn` reassigns that global to a function returning a fabricated `{value: 999999, ...}` descriptor before ever calling `api.move()`, and the helper faithfully read the fabricated value back — reproduced directly before this fix. **Round 3 (this fix)**: the *function value* of `Object.getOwnPropertyDescriptor` is captured as a `QuickJSHandle` immediately after `newContext()`, before a single byte of guest source has evaluated. Every later field read calls that captured handle directly via `context.callFunction` — never by looking up an identifier again — so there is no global binding left for a guest to poison. Any descriptor carrying a `get`/`set` function, or that isn't writable/enumerable/configurable, is rejected outright, which is why `malformed-getter-side-effect` and `malformed-nested-getter-parity` (plain getters, no Proxy) are rejected before their getters ever run (measured: getterInvoked=false, innerReads=0). **Residual, accepted limitation**: capturing the function only stops a *global reassignment* attack. A Proxy that defines its OWN `getOwnPropertyDescriptor` trap (not just `get`) is still legitimately invoked by the real, captured function — that trap IS the object's `[[GetOwnProperty]]`, and refusing to call it isn't possible without refusing to read the object at all. `malformed-proxy-descriptor-trap` measures exactly this: the trap fabricates x's value, and the committed value (`{"x":999999,"y":1}`) equals exactly what the trap presented — predictable and bounded to a schema-valid number, never a host escape, never a corrupted or unrelated field, and still subject to ordinary value validation afterward. This is accepted as-is, not closed by this unit. **Current measured status**: `malformed-proxy-args` → `completed`, committed `{"x":1,"y":1}`; `malformed-overwrite-descriptor-fn` → `completed`, committed `{"x":1,"y":1}` — both are the *true* target values, the guest's tampering had zero effect, and every integrity fixture (proxy-args, getter-side-effect, nested-getter-parity, overwrite-descriptor-fn, proxy-descriptor-trap) ran and matched its expected outcome: the escape is closed.
- No fixture in either runtime reached a real host capability (filesystem, process, network, Bun, WebAssembly, Atomics) — every external-capability fixture ended `blocked`.
- 15 QuickJS fixture(s) have no Lua equivalent (`fetch`, `Bun`, `WebAssembly`, `Atomics.wait`, timers, `Proxy`-based coercion) because Lua's config (`openStandardLibs: false`, `injectObjects: false`, `enableProxy: false`) leaves no ambient surface for those concepts to exist on in the first place — the absence itself is the finding, not a gap in fixture coverage.
- With `openStandardLibs: false`, the Lua guest has no base library at all: no `pcall`, `error`, `tostring`, `getmetatable`, or `load` beyond the raw language and the injected `api` table. Every bad-path Lua fixture therefore ends the whole chunk with an uncaught runtime error rather than a guest-caught, continuable failure — QuickJS's fixtures can (and do) `try`/`catch` around a rejected call and keep running; Lua's cannot.
- Of 3 QuickJS allocation fixtures: 0 were actually stopped by `setMemoryLimit` raising an out-of-memory error, 1 hit the engine's own max-string-length invariant instead, and 2 grew past 96 MiB (1.5x the configured 64 MiB limit) before anything stopped them (measured peak RSS: `allocation-array-growth` 298 MiB, `allocation-json-stringify-bomb` 99 MiB) — direct, measured confirmation of quickjs-emscripten#255 (`setMemoryLimit` is soft against this growable-WASM build). Correction: `allocation-string-doubling` was previously mis-reported as `completed` here — it actually ends in an uncaught engine error (`string too long`) that the classifier didn't recognize as a stop signal unless tagged with a known `limitKind`. The fix is two-fold: `limitKind` now explicitly recognizes the `string too long` message (`"string-length"`), and the loop-recursion/allocation category classifier now treats *any* abnormal ending (`ok: false`) as `terminated`, not just a recognized one — `completed` in this category means the fixture ran to the end genuinely unstopped, never "stopped for an unrecognized reason." None of the three measured stopping mechanisms here (deadline, `setMemoryLimit`, string-length cap) should be read as "allocation defenses work uniformly" — which one fires is pattern-dependent and only the deadline/RSS supervisor is guaranteed present for every pattern; see the bottom line.
- Every runtime's supervisor stayed healthy after a terminated fixture: the very next execution, in a fresh runtime/process, completed normally.
- An unresolved, un-chained promise did not hang this driver (outcome `completed` in 29ms, jobsExecuted=0): it creates no reaction job at all (nothing calls `.then()` on it), so even with the job pump below actively running after every fixture, there is nothing queued to drain.
- The infinitely self-requeuing microtask fixture is now actually exercised: this driver runs a bounded pending-job pump (`runtime.executePendingJobs()` in batches, under the same interrupt deadline) after the top-level script returns, rather than never draining the job queue at all. Measured: `50000` jobs executed before the pump's own 50,000-job budget tripped (`limitKind: "job-budget"`) in 95ms — faster than either the job budget or the interrupt deadline alone would guarantee, so both bounds are real, independent backstops, not just one masking the other. Outcome: `terminated`.
- The partial-failure fixture staged exactly 2 call(s) before its intentional throw, and the log's status resolved to `rolled-back` — confirming the transaction boundary holds regardless of how the guest execution ends.
- wasmoon's `CreateEngineOptions` has no memory-limit field at all — capping Lua memory requires the separate, undocumented-here `traceAllocations`+`setMemoryMax` pair, which this probe does not configure per the plan's stated options (`openStandardLibs`, `injectObjects`, `enableProxy`, `functionTimeout`). Both measured Lua allocation fixtures grew unchecked until the outer supervisor's RSS bound killed them (measured peak RSS: `allocation-array-growth` 592 MiB, `allocation-string-doubling` 541 MiB) — unlike QuickJS, Lua as configured here has *no* in-runtime memory boundary, only the external supervisor.

## Bottom line

The `malformed-proxy-args` Proxy-parity escape found earlier in this probe's development is closed: the world API now reads object-argument fields via property descriptors rather than `[[Get]]`, and rejects any accessor (getter/setter) descriptor outright. Every integrity fixture (proxy-args, getter-side-effect, nested-getter-parity, overwrite-descriptor-fn, proxy-descriptor-trap) ran and matched its expected outcome. See Findings for the root cause and why a naive dump-twice-and-compare fix did not work. QuickJS (quickjs-emscripten 0.32.x), run one fresh interpreter per execution inside an isolated `Bun.spawn` subprocess with an outer wall-clock/RSS supervisor, is the mechanism this probe recommends for ADR-0004: it blocked every external-capability fixture, and every malformed-input fixture either committed exactly the true (schema-validated) value, was rejected outright, or — in one accepted residual case (a Proxy's own `getOwnPropertyDescriptor` trap) — committed exactly what the trap presented, bounded by ordinary value validation, never a host escape. QuickJS can `try`/`catch` a rejected API call and keep running (Lua's zero-stdlib config cannot), and the world's action validator remains the real authority regardless of interpreter. Allocation defenses are **not** a uniform success story — do not read the category as "solved": which mechanism stops a given allocation pattern (the deadline, `setMemoryLimit` raising OOM, or an unrelated engine invariant like max-string-length) is pattern-dependent, and this run measured `setMemoryLimit` itself firing zero times. Measured allocation fixtures grew well past the configured 64 MiB before anything recognized stopped them, confirming quickjs-emscripten#255/#219 directly on this machine. The only mechanism guaranteed present for every pattern is the outer subprocess wall-clock/RSS supervisor — treat that as the *real* memory boundary, and `setMemoryLimit`/the engine's own invariants as an unreliable bonus, not the other way around. A fixed-memory (non-growable) WASM build is the only way to make `setMemoryLimit` itself trustworthy. Async hangs are now actually measured, not merely assumed absent: this driver runs a bounded pending-job pump after the top-level script returns, under the same interrupt deadline, so an infinitely self-requeuing microtask chain is drained (and terminated by a job-count budget) instead of never being exercised at all. An unresolved, un-chained promise remains a non-issue on its own merits (it queues no reaction job), not because the driver ignores the job queue. Lua (wasmoon 1.16.x) does not win on any measured criterion here: it terminates loops via the same class of mechanism (a `lua_sethook` count hook reachable through `Thread.run({ timeout })`, not through `functionTimeout`/`doString` alone, which only bounds JS callbacks invoked *from* Lua), but its locked-down configuration (`openStandardLibs: false`) leaves generated behaviors with no base library at all, making even ordinary error handling unavailable to the guest. ADR-0004 should stay on QuickJS.