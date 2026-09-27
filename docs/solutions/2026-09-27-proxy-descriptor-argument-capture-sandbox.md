---
title: Reading validated arguments out of a sandboxed guest needs a captured accessor handle, not a live global lookup
date: 2026-09-27
category: sandbox
requirement_ids: [U04, U05]
tags: [quickjs, proxy, property-descriptor, sandbox, generated-code]
---

## Problem

A world API bridge (`move(x, y)`) exposed to a QuickJS guest needs to read plain data out of
guest-supplied object arguments without letting the guest control what value is actually read. The
obvious approach — read each field with the context's ordinary `[[Get]]`-based traversal — turned
out to be bypassable, and the first two fixes were each found bypassable in turn.

## Method

Adversarial fixtures, each designed to defeat the previous round's fix, run against the real
`quickjs-emscripten` context (not a simulated one):

- **Round 1**: a `Proxy` `get` trap that alternates its answer by call-count parity got
  `{x: 999999, y: 1}` committed as `move()`'s target, because the host read each field via
  `context.dump()`'s ordinary `[[Get]]` traversal. A candidate fix — dump the same handle twice,
  reject on disagreement — was tried and measured to **not work**: with exactly two fields and one
  `get` call per field per dump, every dump starts on the same parity phase as the last, so two
  independent dumps always agree with each other while both are equally wrong.
- **Round 2**: reading fields via `Object.getOwnPropertyDescriptor` (`[[GetOwnProperty]]`) instead
  of `[[Get]]` closed the parity-flip Proxy. A stronger bypass was then found: the
  descriptor-reading helper was a small function evaluated *inside the guest context*, and its body
  still referenced the identifier `Object.getOwnPropertyDescriptor` — a dynamic lookup resolved at
  *call* time, not definition time. A fixture reassigned that global to a function returning a
  fabricated descriptor before ever calling the API, and the helper faithfully read the fabricated
  value back.
- **Round 3 (the fix)**: capture the *function value* of `Object.getOwnPropertyDescriptor` as a
  `QuickJSHandle` immediately after `newContext()`, before a single byte of guest source has
  evaluated. Every later field read calls that captured handle directly via
  `context.callFunction` — never by looking up an identifier again — so there is no global binding
  left for a guest to poison.

## Result

Zero escapes across every integrity fixture (`malformed-proxy-args`,
`malformed-getter-side-effect`, `malformed-nested-getter-parity`,
`malformed-overwrite-descriptor-fn`, `malformed-proxy-descriptor-trap`) after Round 3's fix. Any
descriptor carrying a `get`/`set` function, or that isn't writable/enumerable/configurable, is
rejected outright.

## Decision

For any sandboxed-guest-to-host bridge that reads structured arguments: capture the accessor
function(s) you need (`Object.getOwnPropertyDescriptor`, or equivalent) as a handle at context
creation, before any guest code runs, and call that captured handle directly — never re-resolve an
identifier from inside the guest realm after guest code may have run. A "read it twice and compare"
defense is not sufficient against a state machine timed to the read pattern. See
[ADR-0004](../decisions/0004-generated-behavior-runtime.md).

## Re-check

Apply this same three-round adversarial process (naive read → descriptor read → captured-handle
read) to any new API surface exposed to the sandbox, and to a Lua/`wasmoon` bridge if that runtime
becomes primary — its `enableProxy: false` configuration removes the Proxy-specific attack surface
but was not itself adversarially tested against a metatable-based equivalent to this exact bypass
chain.
