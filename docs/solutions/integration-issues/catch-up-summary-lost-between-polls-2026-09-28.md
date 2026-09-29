---
title: A catch-up summary set for one tick never reaches a client that polls once a second
date: 2026-09-28
category: integration-issues
module: client-view
problem_type: integration_issue
component: tooling
symptoms:
  - The packaged app never showed the catch-up panel after a launch with a real gap, although the sidecar computed a summary
  - With the summary never cleared, the panel came back on every frame after the operator dismissed it
  - Sidecar and client unit tests passed with either behavior
root_cause: async_timing
resolution_type: code_fix
severity: medium
tags: [catch-up, sync-frame, polling, latest-value, dismissal, packaged-gate, tauri-proxy]
---

# A catch-up summary set for one tick never reaches a client that polls once a second

## Problem

After a catch-up the sidecar publishes `catchUpSummary` in `/frame`. The Rust shell reads `/frame` on a fixed poll, and the client renders the summary as a dismissible panel. A first version never cleared the summary, so the panel reappeared on every frame. The review fix cleared it on every status update, which left the summary on the frame for at most one tick — shorter than the poll interval — so the packaged app never showed the panel.

## Symptoms

- Launch after a gap of several minutes: the sidecar's catch-up applied the time and the store advanced, but no "Caught up" panel appeared in the packaged window.
- Before the review fix: dismissing the panel hid it for one frame, then it returned.
- `bun run check` was green in both states. Nothing in the unit tests observed the summary across more than one status update.

## What Didn't Work

1. **Never clearing it.** `updateServiceStatus` only assigned when a summary was passed, so the summary stayed on every later frame. The client keyed dismissal by the frame's own sequence (`${view.sessionId}:${view.sequence}`), which changes every tick, so a dismissed summary was a new key on the next frame and the panel returned. There was no way to acknowledge it.
2. **Clearing on every status update.** Making the write unconditional fixed the reappearing panel, because the summary now existed for one tick only:

   ```ts
   // apps/simulation/src/server.ts, updateServiceStatus (before)
   ref.encodedState = worldProjectionCodec.encode(state);
   ref.catchUpSummary = options.catchUpSummary;
   ```

   The live tick loop calls `updateServiceStatus(statusRef, state)` with no options (`apps/simulation/src/index.ts:271`), so the next 1 Hz tick (`TICK_INTERVAL_MS`, `index.ts:41`) erased it. The shell's poll loop sleeps `POLL_INTERVAL` (1 s) before every fetch (`apps/desktop/src-tauri/src/proxy.rs:17`, `proxy.rs:131-135`) and is not synchronized with the tick loop, so a poll rarely lands inside that window. In-process tests read the frame immediately after the update and saw the summary.

## Solution

The sidecar holds the latest summary on every frame until a new catch-up replaces it, and the summary carries its own identity. The client dismisses by that identity.

```ts
// apps/simulation/src/server.ts:230-235
if (options.catchUpSummary) {
  ref.catchUpSummary = {
    ...options.catchUpSummary,
    atSequence: state.lastSequence,
  };
}
```

- An ordinary update (no summary passed) leaves `ref.catchUpSummary` untouched (`apps/simulation/src/server.ts:206-236`).
- A catch-up that applied nothing, skipped nothing, and had no outcomes does not replace the earlier summary (`apps/simulation/src/index.ts:100-108`).
- `CatchUpSummary.atSequence` is the committed sequence the catch-up finished at (`packages/contracts/src/snapshot.ts:41-42`); the parser rejects a summary without it (`snapshot.ts:68-72`).
- The client's dismissal key is `session:atSequence`, not the frame's sequence (`apps/client/src/summary.ts:9-16`), so the same summary keeps one identity across every frame that repeats it, and a later catch-up or a new session shows a new panel.

## Why This Works

`/frame` is a latest-value snapshot polled on the consumer's schedule. A value in it that exists for one producer tick is an edge, and an edge shorter than the consumer's poll interval is only sometimes observed. Holding the summary until it is superseded turns it into level state: every poll sees it, whenever the poll lands. Once it is level state, the consumer owns acknowledgment. That needs a stable identity carried by the value itself; the frame's sequence identifies the frame, not the summary.

## Prevention

- Anything published through a polled latest-value snapshot is level state: hold it until it is superseded, never clear it on the producer's tick.
- Put a stable identity on the value (`atSequence` here) and key the consumer's acknowledgment on it, not on the frame that happened to carry it.
- Timing between a producer's tick and the consumer's poll is not covered by in-process tests. The packaged view gate is the check: launch after a real gap, see the panel, dismiss it, confirm it stays gone ([View gate, check 5a](../../../tools/scenarios/m1-packaged-shell/README.md#view-gate)).
- Tests that pin the behavior now:
  - `apps/simulation/src/recent-events.test.ts:247` fetches `/frame` over HTTP across three ticks and a replacement, expecting the stamped summary to persist and then be replaced.
  - `apps/simulation/src/index.test.ts:106` and `:140` cover an empty catch-up leaving the earlier summary alone and a non-empty one replacing it.
  - `apps/client/src/summary.test.ts:51` and `:61` and `:69` cover dismissal holding across later frames, a later catch-up showing again, and a new session showing again at the same sequence.
  - `packages/contracts/src/snapshot.test.ts:183` and `:199` cover the required, non-negative-integer `atSequence`.

## Related Issues

- [m1-packaged-shell scenario, View gate](../../../tools/scenarios/m1-packaged-shell/README.md#view-gate)
- [World and persistence composed incorrectly despite green package tests](world-persistence-composition-broken-after-reopen-2026-09-27.md) — another defect that only the composed system showed
