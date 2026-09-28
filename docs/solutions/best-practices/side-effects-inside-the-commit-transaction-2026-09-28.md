---
title: A write that must share a tick's fate runs inside its commit transaction
date: 2026-09-28
category: best-practices
module: world-persistence
problem_type: design_pattern
component: development_workflow
severity: high
applies_when:
  - A write must be atomic with a tick's events, projections, clock, or PRNG state
  - Adding an operator action that changes the clock (pause, resume) and needs an observation recorded
  - Any write that would leave the world advanced with no record of why, if it failed alone
tags: [sqlite, transaction, commit-hook, causal-trace, rollback, side-effects, persistence]
---

# A write that must share a tick's fate runs inside its commit transaction

## Context

The live tick loop committed a tick (events, projections, clock, PRNG) and then wrote trace rows in a separate call. A trace failure after that commit crashed the loop with the world already advanced, and because the clock prevents replay, that tick's causal record was lost for good. The same shape showed up in `/pause` and `/resume`, and again in the mid-catch-up pause path: the clock transition committed, then the operator observation was written unguarded.

## Guidance

1. If a write must share fate with a tick's state change (trace rows for a tick, an operator observation for pause/resume), it runs inside that tick's own transaction, not after it.
2. Route it through `commitTick`'s `onCommitted(db)` hook, which runs after events/projections/clock/PRNG are written but before the transaction commits.
3. A thrown error inside `onCommitted` rolls the whole tick back into the degraded path, exactly like a world-state write failure.
4. Persistence takes the hook as a callback and never imports what it writes — the caller supplies the callback; persistence just runs it against the open `db` handle it already has.
5. Apply this to every write that must be atomic with a tick or a clock transition.

## Why This Matters

A write scheduled after commit races the possibility of its own failure against a world that has already moved. If it fails, the state has advanced with nothing to show why, and the clock's forward-only nature means there's no replay to regenerate what was lost — that tick's record is gone permanently, not just delayed. Running the write inside the same transaction removes the race: either both happen, or a rollback undoes both together.

## When to Apply

- Adding a write that must be atomic with a tick's events, projections, clock, or PRNG state
- Any operator action that changes the clock and needs an observation recorded with it
- A new persistence-boundary hook where the write must never outlive a rolled-back transaction

## Examples

Before, in `applyOneTick` (`apps/simulation/src/tick.ts`): the tick commits, then trace is written in a separate, unguarded call:

```ts
const committed = commitWorldTick(deps, outcome.result.events, {
  tick: outcome.result.state.tick,
  simTimeMs: outcome.result.state.simTime,
  prngState: serializePrngState(outcome.result.prng),
  cursorWallMs: commit.cursorWallMs,
  paused: commit.paused,
});
if (!committed.ok) {
  return {
    kind: "store-error",
    reason: committed.reason,
    message: committed.message,
  };
}
traceWorldTick(deps.traceDb, outcome);
```

After: `commitTick` takes an optional hook that runs inside the transaction, after the tick's own writes and before it commits — and `persistence` stays free of any dependency on what the hook writes:

```ts
// packages/persistence/src/store.ts
export interface TickInput {
  // ...events, cursorWallMs, paused, tick, simTimeMs, prngState
  readonly onCommitted?: (db: Database) => void;
}

export function commitTick<TProjections>(
  store: Store,
  reducers: ProjectionReducers<TProjections>,
  input: TickInput,
): TickCommitResult<TProjections> {
  const run = store.db.transaction(() => {
    // ...append events, apply projections, write clock and PRNG state
    input.onCommitted?.(store.db);
    return { sequence, projections };
  });

  return run.immediate();
}
```

`commitWorldTick` passes trace writes through that hook instead of calling them after:

```ts
// apps/simulation/src/tick.ts
export function commitWorldTick(
  deps: TickDeps,
  events: readonly WorldEvent[],
  commitOptions: { /* tick, simTimeMs, prngState, cursorWallMs, paused */ },
  traceOutcomes: readonly WorldTickOutcome[] = [],
  onCommitted?: (db: Database) => void,
): CommitOutcome {
  const commit = deps.commitTick ?? persistCommitTick;
  try {
    commit(deps.store, deps.reducers, {
      events,
      ...commitOptions,
      onCommitted: (db) => {
        for (const outcome of traceOutcomes) {
          traceWorldTick(db, outcome);
        }
        onCommitted?.(db);
      },
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: classifyStoreError(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
```

`recordOperatorEvent` is the same shape applied to pause/resume — returned as a callback so `commitWorldTick`'s `onCommitted` hook writes it inside the same transaction as the clock transition:

```ts
export function recordOperatorEvent(kind: string): (db: Database) => void {
  return (db) => {
    recordObservation(db, {
      schemaVersion: 1,
      id: createObservationId(),
      observer: OPERATOR_ENTITY_ID,
      stateRevision: 0,
      factsRead: [`operator:${kind}`],
      source: "operator",
    });
  };
}
```

## Related

- [World and persistence composed incorrectly despite green package tests](../integration-issues/world-persistence-composition-broken-after-reopen-2026-09-27.md)
- [0003: Simulation service](../../decisions/0003-simulation-service.md)
