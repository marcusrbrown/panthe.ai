---
title: The catch-up cap bounds the remaining backlog, not a single run
date: 2026-09-28
category: best-practices
module: simulation-core
problem_type: design_pattern
component: service_object
severity: medium
applies_when:
  - A limit on work must hold across a process kill and restart
  - Work is applied in committed chunks and a run can die partway through
  - A summary or count must cover everything a restarted run continued
tags: [catch-up, backlog, cap, sqlite, restart, w03, catch-up-progress]
---

# The catch-up cap bounds the remaining backlog, not a single run

## Context

Catch-up applies the wall time a stopped or asleep service missed, up to a cap (`rules.catchUpCapMs`, one hour in the authored world). It computed the cap from the persisted cursor on every run, and each chunk advanced the cursor. A kill partway through left the cursor behind by the unapplied rest of the sleep, so the restart saw a gap larger than the cap and applied a full cap again. A three-hour sleep with a one-hour cap could apply more than an hour.

## Guidance

1. **Discard the excess in one commit before any chunk.** The time over the cap moves the cursor forward in its own transaction, together with its operator observation, so a run that dies later never hands its restart the same excess (`apps/simulation/src/catchup.ts:187-225`).
2. **Persist the backlog's progress with each step.** `catch_up_progress` holds `applied_ms`, `discarded_ms`, and `start_sequence` (the last event sequence before the backlog). The discard, every chunk, and a mid-catch-up pause write it inside their own commit. The backlog stays open until the service has published the summary, and only then closes it, so a process that dies after the last commit finds the summary waiting (`apps/simulation/src/catchup.ts`; `refreshStatusAfterCatchUp` in `index.ts`; `packages/persistence/src/store.ts`).
3. **Let the cap bound what remains.** With cap C, `a` already applied, and `d` of new downtime since, the next run applies `min(C, C - a + d)` (documented at `catchup.ts:104-109`). Seconds that pass while the service is down are new gap, applied once on top of what is left.
4. **Report the whole backlog, derived from what committed.** The summary is built from the progress row (`appliedMs`, `skippedMs`) and from the notable events committed after `start_sequence` (`majorOutcomes`), never from an in-memory list, so one run or several, a restart, a crash before publication, or a restore from an archive that carries the row all report the same summary (`summaryOf` in `catchup.ts`). Deriving the outcomes from the event log means no second copy of them can drift.

## Why This Matters

The cap is a promise about how much simulated time one sleep can add. A per-run cap makes that promise depend on how many times the process died, and a kill during catch-up is the case where the service is already under stress. Committing the discard and progress with the state they describe means a restart continues from exactly what committed, whether it stopped after the discard, between chunks, after the last chunk, or after the last commit but before the summary was published.

Known limit of the summary, not affecting world state and recorded on W03 in [traceability](../../product/traceability.md): the backlog closes when its summary is published, not when a client has fetched it, so a kill after publication and before the next frame loses that summary ([the summary is level state once it is published](../integration-issues/catch-up-summary-lost-between-polls-2026-09-28.md)).

## When to Apply

- Any bounded catch-up, replay, or drain that commits in chunks.
- Any limit that must hold across restarts: put the counter in the same transaction as the work it counts.
- New downtime between a kill and its restart counts as new work, so the bound is on the remainder, not on the run.

## Examples

Before, the cap came from the cursor alone on every call, with no record of what an earlier run had applied:

```ts
// apps/simulation/src/catchup.ts, runCatchUp (before)
const {
  appliedMs: totalAppliedMs,
  skippedMs: capSkippedMs,
  newCursor: sampledNowCursor,
} = computeTick(clock, options.nowWallMs, clockConfig);
```

After, the excess is discarded first and progress is written with it:

```ts
// apps/simulation/src/catchup.ts:203-209
(db) => {
  recordOperatorEvent(`catch-up-discard:${excessMs}`)(db);
  writeCatchUpProgress(db, {
    appliedMs: priorAppliedMs,
    discardedMs: discardedMs + excessMs,
  });
},
```

Tests: `apps/simulation/src/catchup.test.ts:463` (a five-hour gap, a commit that throws after two chunks, a reopen: exactly the cap in total, exactly the excess skipped, nothing applied twice), `:491` (the discard commits before any chunk), `:532` and `:549` (the cap bounds the remaining backlog with downtime), `:571` (a backlog that fully applied before the final cursor commit is finished by the next start). The compiled-sidecar scenario kills after two chunks of a three-hour sleep and asserts the restarted summary covers the whole backlog (m1-living-world S13), with a `catch-up` positive control ([tools/scenarios/m1-living-world/README.md](../../../tools/scenarios/m1-living-world/README.md)).

## Related

- [A proposal acknowledged before it was durable was lost on a crash, and its retry answer did not survive a restore](../integration-issues/proposal-accepted-then-lost-before-durable-2026-09-28.md) — the same rule for the proposal journal: state that must survive a restart commits with the work it describes
- [A write that must share a tick's fate runs inside its commit transaction](side-effects-inside-the-commit-transaction-2026-09-28.md)
- [A catch-up summary set for one tick never reaches a client that polls once a second](../integration-issues/catch-up-summary-lost-between-polls-2026-09-28.md)
- [A headless scenario against the compiled binary needs a positive control per negative claim](end-to-end-scenario-with-positive-controls-2026-09-28.md)
