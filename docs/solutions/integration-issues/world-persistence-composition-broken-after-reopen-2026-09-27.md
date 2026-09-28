---
title: World and persistence composed incorrectly despite green package tests
date: 2026-09-27
category: integration-issues
module: world-persistence
problem_type: integration_issue
component: testing_framework
symptoms:
  - The second committed tick failed with NonContiguousSequenceError
  - Actors and locations disappeared after reopening a world
  - A fresh process could not rebuild seeded actors from the event log
  - Tick and simulation time reset to 0 on reopen
  - An archive with a malformed actor entry and a recomputed checksum imported successfully
root_cause: test_isolation
resolution_type: code_fix
severity: high
tags: [composition-root, integration-test, serialization, event-sourcing, rebuild, bun-sqlite]
---

# World and persistence composed incorrectly despite green package tests

## Problem

`packages/world` and `packages/persistence` each passed their own tests (438 tests green), but together they could not persist a second tick or survive a restart. Each package was tested against fakes, and nothing ran the real rules through the real store.

## Symptoms

- `runTick` numbered events from 0 on every tick, while `commitTick` requires a world-global contiguous sequence. The second tick threw `NonContiguousSequenceError`.
- `WorldState` keeps actors and locations in `Map`s, but the store serialized projections with plain `JSON.stringify`. The Maps became `{}`, so every entity was lost on reopen.
- `rebuildProjections` started from the caller's `initial` projection. A fresh process that builds its initial state from `loadGreekWorldState()` has no seeded actors, and `applyEvent` silently skipped moves for actors it didn't know about.
- `tick` and `simTime` advanced only inside `runTick`. No event or row persisted them.
- World-state `decode` was a cast, so a checksum-consistent archive containing `["wanderer", null]` imported.

## What Didn't Work

- **Package-local tests with fakes.** The store tests used a plain-object counting reducer, and the world tests never persisted anything. Neither could see the boundary.
- **Broad code review.** An 11-reviewer pass read each package and missed that they don't compose.
- **The first integration test.** It reopened the store with reducers built from the same in-memory seeded state, so rebuild looked correct.
- **Pinning the broken value.** An assertion that tick equals 0 after reopen, plus an explanatory comment, froze the bug into the suite instead of failing until it was fixed.
- **No importable package boundary.** `world`, `persistence`, and `content` had no `exports`/`types` in `package.json`, so no other package could import them by name, and a cross-package test could not exist.

## Solution

The sequence continues from the committed world:

```ts
// packages/world/src/actions.ts
let sequence = working.lastSequence; // was: let sequence = 0;
```

An explicit codec lets world state round-trip, and `decode` is a parser. It rejects bad shapes, duplicate keys, keys that differ from the entity's own id, unknown location or realm references, and invalid tick, sequence, or time values.

```ts
// packages/world/src/codec.ts
export function encode(state: WorldState): EncodedWorldState {
  return {
    tick: state.tick,
    simTime: state.simTime,
    lastSequence: state.lastSequence,
    locations: [...state.locations.entries()],
    actors: [...state.actors.entries()],
  };
}
```

The store requires a codec (there is no default identity codec). It writes the genesis projection once when the store is created, and rebuild replays from it:

```ts
// packages/persistence/src/store.ts
let projections = readGenesisProjection(store.db, reducers);
for (const event of listEvents(store.db)) {
  projections = reducers.applyEvent(projections, event);
}
```

`tick` and `sim_time_ms` live in the clock row and are committed in the same `IMMEDIATE` transaction as the tick's events. The genesis row is part of the archive checksum. Import parses every event row, requires sequences `1..N` that match the manifest, and writes event columns from the parsed event.

`apps/simulation/src/world-store.test.ts` is the one package allowed to depend on both, and it drives the real rules through the real store with the authored Greek pack:

```ts
closeStore(store);
const freshReducers = createWorldProjectionReducers(loadGreekWorldState());
const reopened = openStore(storePath, freshReducers);
expect(
  restoreWorldTime(rebuildProjections(reopened, freshReducers), readClock(reopened.db)),
).toEqual(tick2.state);
```

## Why This Works

The log plus the stored genesis state plus the clock row are now the complete source of truth. Nothing the caller holds in memory is needed to reconstruct the world. The codec makes the storage shape explicit instead of relying on what `JSON.stringify` happens to do, and parsing on decode rejects state that would make rules silently skip entities. The integration test exercises the same path a real restart takes.

## Prevention

- When data crosses a package boundary (serialization, sequence numbering, initial or genesis state, time), add one integration test at the composition root that uses the real implementations.
- Any "after restart" assertion must use a freshly constructed composition root that shares no in-memory state with the side that wrote.
- Assert full-state equality after reopen, rebuild, continued ticks, and export → import. Also cover one rejected malformed archive.
- Every workspace package declares `exports`/`types`, so cross-package tests are possible.

## Related Issues

- [Build the direct version first in a greenfield, single-user codebase](../best-practices/greenfield-anti-over-engineering-2026-09-27.md)
- `tools/probes/backend-lifecycle/README.md`: exactly-once clock evidence from a real process and direct SQLite inspection (moderate overlap; candidate for consolidation review)
- PR #27 (marcusrbrown/panthea)
