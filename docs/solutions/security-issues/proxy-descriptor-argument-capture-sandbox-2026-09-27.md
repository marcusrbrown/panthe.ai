---
title: Reading validated arguments out of a sandboxed guest needs a captured accessor handle, not a live global lookup
date: 2026-09-27
category: security-issues
module: sandbox
problem_type: security_issue
component: tooling
symptoms:
  - "a Proxy argument with a parity-flipping `get` trap committed `{x: 999999, y: 1}` through validation instead of `{x: 1, y: 1}`"
  - guest code that reassigns `Object.getOwnPropertyDescriptor` before calling the API poisons a host lookup made by identifier
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [quickjs, proxy, property-descriptor, sandbox, security, intrinsics, u04, u05]
---

# Reading validated arguments out of a sandboxed guest needs a captured accessor handle, not a live global lookup

## Problem

The world API bridge exposed to a QuickJS guest (`move(x, y)` and friends) must read plain data
out of guest-supplied objects without letting the guest decide what value the host reads.
Reading fields through the context's ordinary `[[Get]]` traversal was bypassable, and the first
two fixes were each bypassed in turn across three review rounds on
[PR #14](https://github.com/marcusrbrown/panthea/pull/14).

## Symptoms

- The `proxy-parity-flip` fixture (`tools/probes/sandbox/src/fixtures/manifest.ts`) got a
  poisoned `{x: 999999, y: 1}` past validation: the validator and the committer each performed a
  separate `[[Get]]`, and the Proxy's `get` trap returned a benign value on one read and the
  poison on the next.
- The `guest-reassigns-descriptor` fixture poisoned the second fix by overwriting the global
  `Object.getOwnPropertyDescriptor` before calling `api.move()`.

## What Didn't Work

1. **Separate `[[Get]]` per field** — the guest controls every read.
2. **"Dump twice and compare"** — measured to fail: both dumps land on the same parity phase of
   the trap, so they agree and are both wrong.
3. **`Object.getOwnPropertyDescriptor` resolved by identifier at call time** — reproduced: a
   guest that reassigns that global first makes the host read fabricated descriptors.

## Solution

`tools/probes/sandbox/src/quickjs.ts`: capture the intrinsic immediately after `newContext()`,
before any guest source evaluates, and call the captured handle — never an identifier lookup —
for every host read of guest object data.

```ts
const context = runtime.newContext();
const intrinsics = captureIntrinsics(context); // getOwnPropertyDescriptor handle, pre-guest

const desc = context.unwrapResult(
  context.callFunction(intrinsics.getOwnPropertyDescriptor, context.undefined, objectHandle, keyHandle),
);
const get = context.getProp(desc, "get");
const set = context.getProp(desc, "set");
if (context.typeof(get) === "function" || context.typeof(set) === "function") {
  throw new ValidationError(path, `accessor property not allowed: ${key}`);
}
// a descriptor whose writable, enumerable, or configurable is false is rejected too;
// only a plain data descriptor reaches assertPlainData and the schema validator
```

Evidence integrity around it (`src/host.ts`, `applyExpectationOverride`): malicious fixtures
declare `expect.committed` / `expect.status`; any mismatch between the manifest expectation and
the actual committed value or status is forced to `escaped`, so a "fixed" fixture cannot pass by
accident. An async-job pump (`runtime.executePendingJobs` under the same deadline with a bounded
job budget) makes self-requeuing microtask chains measurable as `terminated` instead of silently
`completed`.

Result: zero escapes across the re-verified matrix. Residual: a Proxy's own
`getOwnPropertyDescriptor` trap can still lie about the returned field values
(`malformed-proxy-descriptor-trap` fixture), but only through the ordinary host-side snapshot
path — it cannot rebind the intrinsic or escape the host boundary. The damage is bounded by
`assertPlainData` and `WorldApi.parseMoveTarget`'s finite-number checks, not by any separate
range check; a finite poisoned coordinate is still possible and is the world rules' job to
reject.

## Why This Works

`[[GetOwnProperty]]` never invokes the Proxy `get` trap, so the parity flip has nothing to hook.
A function value captured before guest evaluation is immune to later global reassignment.
Rejecting accessor descriptors up front removes getters/setters as a smuggling channel.

## Prevention

- Every guest-argument property read goes through the captured extractor; no new host→guest
  argument-read path ships without it. (Reads of the descriptor object the captured intrinsic
  returns, and of eval results, are host-owned and deliberate.)
- Malicious fixtures carry expected committed values and status; mismatches report `escaped`.
- Real-runtime regression tests (`src/quickjs.test.ts`) cover the parity flip, the global
  reassignment, and the residual Proxy descriptor trap.

## Re-check

- Any `quickjs-emscripten` upgrade, any new guest-visible API surface, any new host→guest read
  path, or any change that reintroduces identifier lookup from inside the guest realm.
- If Lua/wasmoon ever becomes primary: ADR-0004 records that its metatable-equivalent bypass was
  not adversarially tested.

## Related Issues

- [ADR-0004 Generated behavior runtime](../../decisions/0004-generated-behavior-runtime.md)
- [U04, U05](../../product/requirements.md)
- [tools/probes/sandbox/README.md](../../../tools/probes/sandbox/README.md),
  [docs/research/stack-2026-09-26.md](../../research/stack-2026-09-26.md) (sandbox section),
  [PR #14](https://github.com/marcusrbrown/panthea/pull/14)
