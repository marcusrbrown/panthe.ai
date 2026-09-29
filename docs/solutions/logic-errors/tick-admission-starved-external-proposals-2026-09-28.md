---
title: Tick admission order starved external proposals, and each fix moved the starvation
date: 2026-09-28
category: logic-errors
module: simulation-core
problem_type: logic_error
component: service_object
symptoms:
  - Every external proposal for an actor that had a routine was rejected `busy-actor`, so the scenario could not drive a worship
  - Under a per-tick cap smaller than the routine queue, an external proposal queued behind unrelated routines was rejected `over-limit`
  - Under a cap of 1, a claim that can never commit took the tick's only slot and pushed its own actor's routine to `over-limit`
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [tick-admission, proposal-cap, busy-actor, over-limit, claims, routines, w07]
---

# Tick admission order starved external proposals, and each fix moved the starvation

## Problem

A tick admits proposals from two sources: the routines' proposals and the external (fixture or operator) proposals `/proposals` accepted. Two rules bind them: an actor commits one action per tick, and only the first `maxProposalsPerTick` proposals reach the world engine. Which source goes first decides who loses. The first ordering starved external proposals; the next two moved the loss to other proposals instead of removing it.

## Symptoms

- External worship, repair, or strike for an actor with a routine came back `rejected` with `busy-actor`. The routine had already committed that actor's action for the tick.
- With a cap of 1 and two routine actors, an external proposal for the second actor was recorded `over-limit`.
- With a cap of 1, an external claim by the woodcutter was recorded `unauthorized-claim` as expected, and the woodcutter's routine was recorded `over-limit`. The claim never commits, yet the actor lost its action.

## What Didn't Work

1. **Routines first, externals behind them.** The live tick queued `[...routineQueue, ...drained]`:

   ```ts
   // apps/simulation/src/server.ts, applyLiveTick (before)
   const step = applyOneTick(
     state,
     prng,
     [...routineQueue, ...drained],
     deps,
     commit,
   );
   ```

   `runTick` rejects a second non-claim proposal from an actor as `busy-actor` (`packages/world/src/actions.ts:351-354`, `:380-391`). Every actor with a routine had it committed first, so no external proposal for that actor could ever commit.
2. **Drop the actor's routine, keep routines first.** `mergeTickQueue` removed a routine whose actor had an external non-claim proposal. That fixed `busy-actor`, and only under the authored cap, which is larger than the routine queue:

   ```ts
   // mergeTickQueue, first fix
   return [
     ...routine.filter((queued) => !claimed.has(queued.proposal.actor)),
     ...external,
   ];
   ```

   `stepWorldTick` admits `queue.slice(0, cap)`. With a smaller cap, the routines used the slots and the external proposal was the overflow.
3. **Externals first, all of them.** Swapping the two spreads fixed the cap case:

   ```ts
   // mergeTickQueue, second fix
   return [
     ...external,
     ...routine.filter((queued) => !claimed.has(queued.proposal.actor)),
   ];
   ```

   Claims are external proposals, so they now sat at the head of the queue and each took a slot under `slice(0, cap)`. A claim is rejected by the world and never commits, and the routine-drop rule deliberately exempts claims, so the claimer's routine was still queued. At cap 1 the claim took the slot and the routine was `over-limit`. A burst of claims under the authored cap did the same to routines.

Fixes 1 and 2 each passed the tests written for them: the authored cap in the first case, and no claim in the second.

## Solution

Externals go first, and the cap counts claims and actions separately.

```ts
// apps/simulation/src/tick.ts:155-168
export function mergeTickQueue(
  routine: readonly QueuedProposal[],
  external: readonly QueuedProposal[],
): QueuedProposal[] {
  const claimed = new Set<EntityId>(
    external
      .filter((queued) => queued.proposal.kind !== "claim")
      .map((queued) => queued.proposal.actor),
  );
  return [
    ...external,
    ...routine.filter((queued) => !claimed.has(queued.proposal.actor)),
  ];
}
```

```ts
// apps/simulation/src/tick.ts:189-208 (abridged)
function admitWithinCap(queue, cap) {
  let actions = 0;
  let claims = 0;
  for (const queued of queue) {
    const isClaim = queued.proposal.kind === "claim";
    if ((isClaim ? claims : actions) < cap) {
      admitted.push(queued);
      if (isClaim) claims += 1;
      else actions += 1;
    } else {
      overflow.push(queued);
    }
  }
  return { admitted, overflow };
}
```

`stepWorldTick` uses it in place of the slice (`tick.ts:225-228`), and catch-up chunks share the same `mergeTickQueue` and `stepWorldTick` path (`apps/simulation/src/catchup.ts:271-279`). The resulting order and per-cap counting are the intake rules in [ADR-0008](../../decisions/0008-world-state-and-client-transport.md#external-proposal-intake) (Ordering).

## Why This Works

A claim is the one proposal kind that never holds an actor's action, so it must not spend the action budget; counting it separately keeps its recorded rejection and bounds a flood of claims by the same cap. Every other external proposal takes an actor's action, so it goes ahead of routines, and the routine it displaces is dropped before the tick so it records nothing. Admission order decides which proposals lose when capacity is short, so it is policy, not an implementation detail.

## Prevention

- Treat admission order as policy. Write down who loses when the cap is short and test that, instead of testing the order under a cap that never binds.
- Test with a cap smaller than the routine queue, and add a claim. The tests that pin this:
  - `apps/simulation/src/server.test.ts:973` — cap 1, external worship for the later routine actor commits, its routine yields, the other routine is `over-limit`.
  - `apps/simulation/src/server.test.ts:1003` — cap 1, a claim is rejected `unauthorized-claim` and the claimer's routine commits.
  - `apps/simulation/src/server.test.ts:1025` and `:1058` — a claim beside an external worship, at cap 1 and cap 2.
  - `apps/simulation/src/tick.test.ts:130` — two claims and two routines at cap 1 admit one claim and one routine.
  - `apps/simulation/src/tick.test.ts:676` — `mergeTickQueue` order.
- A proposal that can never commit must not consume a slot that something that can commit needs. Look for the same shape in any new capacity limit.
- End-to-end: the headless scenario drives a worship for an actor that has a routine and asserts it commits ([m1-living-world](../../../tools/scenarios/m1-living-world/README.md), S8).

## Related Issues

- [ADR-0008: World state and client transport](../../decisions/0008-world-state-and-client-transport.md)
- [A headless scenario against the compiled binary needs a positive control per negative claim](../best-practices/end-to-end-scenario-with-positive-controls-2026-09-28.md)
- [Authoritative rules take intent from proposals and everything else from the world](../best-practices/authoritative-rule-validation-2026-09-27.md)
