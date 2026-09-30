---
title: The catch-up cap bounds the remaining backlog, not a single run
date: 2026-09-28
last_updated: 2026-09-29
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
2. **Persist the backlog's progress with each step.** `catch_up_progress` holds `applied_ms`, `discarded_ms`, and `start_sequence` (the last event sequence before the backlog). The discard, every chunk, and a mid-catch-up pause write it inside their own commit. The backlog ends in one commit (the final cursor jump, the pause, or, on a restart with nothing left to apply, a commit of its own) that also persists the summary and clears the progress, so a process that dies at any point leaves either the whole ending or none of it (`apps/simulation/src/catchup.ts`, `apps/simulation/src/catchup-summary.ts`, `packages/persistence/src/store.ts`).
3. **Let the cap bound what remains.** With cap C, `a` already applied, and `d` of new downtime since, the next run applies `min(C, C - a + d)` (documented at `catchup.ts:104-109`). Seconds that pass while the service is down are new gap, applied once on top of what is left.
4. **Report the whole backlog, derived once from what committed, then keep it.** The summary is built from the progress row (`appliedMs`, `skippedMs`) and from the notable events committed after `start_sequence` up to the committed ending sequence (`majorOutcomes`), never from an in-memory list, so one run or several, a restart, a crash, or a restore from an archive that carries the row all report the same summary (`accountOf` in `catchup-summary.ts`). Deriving the outcomes from the event log means no second copy of them can drift. At the ending commit the derived summary is stored as its own row, `catch_up_summary`, with a service-minted id, and is never re-derived: bounding the outcomes at the ending sequence, and keeping the row apart from `catch_up_progress`, is what stops a later live event or a later backlog from changing a summary already delivered.
5. **Persist before exposing, and read back what you expose.** The summary and the progress delete share the ending commit, and a frame only ever carries a summary read from the store, so an unpersisted summary cannot reach a client. If the ending commit fails the backlog stays open and nothing is persisted or published. A degraded run persists what it committed as a partial summary and keeps the backlog; a retry that commits nothing new reuses the summary's id, and one that changes it mints a new id, so a client that acknowledged the summary is not shown it again and one that has not is shown the newer. Bind the id to the backlog, not to the account's content: the progress row records the id of the partial summary its backlog persisted (`summary_id`), and only that still-open backlog may reuse it. Comparing content alone lets a later, different backlog with identical amounts and the same ending sequence (easy with eventless backlogs) inherit a dismissed id, and the client never shows it. The partial summary and its binding are two rows written together: `persistAccount` writes both inside one `db.transaction` (a savepoint when it runs inside the ending commit), because a kill between them leaves a summary under a new id while the backlog still names the old one, and an export of that state is refused on import (`catchup-summary.ts`, PR #57, `43c09ca`). `/resume` closes a backlog a degraded run left open by the same rules.

## Why This Matters

The cap is a promise about how much simulated time one sleep can add. A per-run cap makes that promise depend on how many times the process died, and a kill during catch-up is the case where the service is already under stress. Committing the discard and progress with the state they describe means a restart continues from exactly what committed, whether it stopped after the discard, between chunks, or after the last chunk. Committing the summary with the ending means a kill after the ending, even before any client has fetched the frame, loses nothing.

The summary once had a known limit here: the backlog closed when the summary was *published*, not when a client had *fetched* it, so a kill in that window lost it ([the summary is level state once it is published](../integration-issues/catch-up-summary-lost-between-polls-2026-09-28.md)). Persisting the summary with the ending closes it (2026-09-29, W03): the frame is hydrated from the stored row on start, and the client acknowledges the summary by its id.

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

Tests, all in `apps/simulation/src/catchup.test.ts` unless noted: a five-hour gap with a commit that throws after two chunks and a reopen (exactly the cap in total, exactly the excess skipped, nothing applied twice); the discard commits before any chunk; the cap bounds the remaining backlog with downtime; a backlog that fully applied before the ending commit failed is finished by the next start. For the persisted summary: atomic rollback (a failed ending, including one that fails after the summary was written, leaves the backlog open with no summary and nothing published, and a trigger that aborts the progress delete proves the summary write and the clear are one step); outcomes stay fixed while live ticks continue; an empty catch-up keeps the old summary and a non-empty one, even an eventless one at the same sequence, replaces it with a new id (in `catchup-summary.test.ts`, even one whose account is identical to the closed previous backlog's, in both the close and the partial-then-close paths); a degraded partial run reuses or replaces the id as its progress did or did not change. `apps/simulation/src/catchup-summary.test.ts` covers the id rules directly, `apps/simulation/src/server.test.ts` the `/resume` close, and the subprocess tests in `apps/simulation/src/index.test.ts` SIGKILL a service after it published a summary, with and without a client having fetched it, and assert the restarted frame carries the identical summary, id included. The client side is `apps/client/src/summary.test.ts`. The compiled-sidecar scenario kills after two chunks of a three-hour sleep and asserts the restarted summary covers the whole backlog (m1-living-world S13), with a `catch-up` positive control ([tools/scenarios/m1-living-world/README.md](../../../tools/scenarios/m1-living-world/README.md)).

## Related

- [A proposal acknowledged before it was durable was lost on a crash, and its retry answer did not survive a restore](../integration-issues/proposal-accepted-then-lost-before-durable-2026-09-28.md) — the same rule for the proposal journal: state that must survive a restart commits with the work it describes
- [A write that must share a tick's fate runs inside its commit transaction](side-effects-inside-the-commit-transaction-2026-09-28.md)
- [A catch-up summary set for one tick never reaches a client that polls once a second](../integration-issues/catch-up-summary-lost-between-polls-2026-09-28.md)
- [A headless scenario against the compiled binary needs a positive control per negative claim](end-to-end-scenario-with-positive-controls-2026-09-28.md)
