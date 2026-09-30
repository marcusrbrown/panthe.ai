---
title: An unawaited god-turn promise crashed the sidecar on a store fault
date: 2026-09-29
category: runtime-errors
module: simulation-core
problem_type: runtime_error
component: background_job
symptoms:
  - A store read could throw before the god-turn runner entered its handled path
  - "`dispatch()` stored a rejecting promise that the live tick loop never awaited"
  - A store fault in the fire-and-forget turn path became an unhandled rejection
  - The sidecar could exit instead of reporting `store-error` and halting ticks
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [unhandled-rejection, async, tick-loop, bun-sidecar, god-turn, floating-promise, store-error]
---

# An unawaited god-turn promise crashed the sidecar on a store fault

## Problem

The god-turn runner starts from the live tick loop after each committed tick, and the tick loop deliberately doesn't await it. The first version did some store reads before its handled path, so a store fault could reject that promise and crash the Bun sidecar.

## Symptoms

- In PR #64, commit `855a9b5`, `apps/simulation/src/index.ts` called `turns?.dispatch()` after each live tick and didn't await the result.
- `dispatch()` stored `running = turn(...).finally(...)`. So `running` cleared when the promise settled, but the promise itself still rejected if `turn()` threw before its `try`.
- In `apps/simulation/src/agents.ts`, `turn()` called `listEvents(...)` before entering the `try`.
- `dispatch()` also read `deps.getState()` and chose the next god through `nextGod(state)`, which reads pending external proposals from the store.
- A store fault is supposed to produce a degraded `store-error` status with ticks halted, not a process exit.

## What Didn't Work

The first version caught failures from `runGodTurn(...)` and `conclude(...)`, but that was too narrow:

```ts
async function turn(god: EntityId, state: WorldState, signal: AbortSignal) {
  const recentEvents = listEvents(deps.store.db, {
    toSequence: state.lastSequence,
    excludeKinds: UNPLACED_EVENT_KINDS,
    newest: RECENT_EVENT_CAP,
  });
  try {
    const result = await runGodTurn(deps, { state, actorId: god, recentEvents, signal });
    if (result && !signal.aborted) conclude(result);
  } catch (error) {
    log(`god turn for ${god} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

`listEvents(...)` ran before the `try`, so a read failure escaped. `dispatch()` had the same problem: `deps.getState()` and `nextGod(state)` could throw before any promise existed to catch it.

The `.finally(...)` on `running` didn't make the promise safe. It cleared the flag but didn't consume the rejection, and because `index.ts` launches the turn from a timer path and never awaits it, any rejection went unhandled.

## Solution

Commit `a2ff5e5` moved every store read in the turn path inside a handled path. `turn()` now catches `listEvents(...)`, `runGodTurn(...)` and `conclude(...)` together:

```ts
async function turn(god: EntityId, state: WorldState, signal: AbortSignal) {
  try {
    const recentEvents = listEvents(deps.store.db, {
      toSequence: state.lastSequence,
      excludeKinds: UNPLACED_EVENT_KINDS,
      newest: RECENT_EVENT_CAP,
    });
    const result = await runGodTurn(deps, { state, actorId: god, recentEvents, signal });
    if (result && !signal.aborted) conclude(result);
  } catch (error) {
    log(`god turn for ${god} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

`dispatch()` also wraps its state and journal reads. A failed read logs and returns `false`, so no turn starts and nothing throws into the tick loop:

```ts
let state: WorldState;
let god: EntityId | undefined;
try {
  state = deps.getState();
  god = nextGod(state);
} catch (error) {
  log(`god turn not started: ${error instanceof Error ? error.message : String(error)}`);
  return false;
}
```

The tests in `apps/simulation/src/agents.test.ts` put a real store behind a proxy that throws on a chosen SQL statement, and they register a live `unhandledRejection` listener:

```ts
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});
```

- **Fault while preparing a turn:** the test injects a failure on `FROM events`, dispatches, and waits for the runner to go idle. It then asserts that nothing was rejected, no model request was sent, no proposal was journaled, and the same runner dispatches normally once the fault clears.
- **Fault while choosing a god:** the test injects a failure on `FROM external_proposals`, and separately makes `getState()` throw. `dispatch()` returns `false`, leaves no turn in flight, and works again once the reads are healthy.

## Why This Works

A promise launched from a timer callback has to be non-rejecting by construction. The caller has chosen not to await it, so nothing downstream can catch its rejection.

After the fix the runner is self-contained. Every step either completes or is caught inside the runner: the reads before the model call, the call itself, intake, journaling, and choosing the next god. `dispatch()` stays a synchronous yes-or-no call, and the tick loop keeps its contract: it asks for a turn and moves on.

This doesn't make store faults succeed; it changes how they fail. A god turn whose read fails is abandoned and logged instead of taking down the process. Store faults in the tick path still return `store-error` and halt live ticks.

## Prevention

- Any promise launched from a timer, interval, event callback or tick without being awaited must never reject.
- Put the whole async body inside `try`/`catch`, including the reads before the first `await`.
- Wrap the caller's synchronous setup too, when it reads state, the journal or the store.
- `.finally(...)` is not a catch. Use it to clear flags, not to make a promise safe.
- Test fire-and-forget paths with an injected fault and a live `unhandledRejection` listener, plus a control that clears the fault and shows the same runner working again.

## Related Issues

- [PR #64: feat(agents): god turn runner with journaled model proposals](https://github.com/marcusrbrown/panthea/pull/64)
- [Side effects inside the commit transaction](../best-practices/side-effects-inside-the-commit-transaction-2026-09-28.md): the other way the tick loop has crashed the process
- [Lifecycle state behind one lock](../best-practices/lifecycle-state-one-lock-transitions-2026-09-28.md): the shell supervisor that restarts a crashed sidecar
