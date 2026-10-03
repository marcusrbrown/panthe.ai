---
title: A world-judged promise counted evidence outside its window and promised what could not be done
date: 2026-10-03
category: logic-errors
module: simulation-core
problem_type: logic_error
component: assistant
symptoms:
  - "A 1,000,000-unit offering due in 25 ticks was accepted, breached, and the mortal turned into a wolf"
  - "A `be-at` term was fulfilled in the same tick it was accepted, because the god already stood there"
  - "A bless one tick after the deadline still fulfilled or breached the bargain"
  - "A `bless-mortal` term was accepted on a punish petition, which a bless can never answer"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [practices, obligations, deadlines, feasibility, petitions, blessability, w05, r6, r7]
---

# A world-judged promise counted evidence outside its window and promised what could not be done

## Problem

Practices let gods and mortals make promises the world judges: a term has a party, a deadline, and a performance the world watches for. Four defects in `packages/world/src/practices.ts` broke the same contract. The world accepted promises it could never see performed, and counted evidence from before acceptance or after the deadline. Each one produced a wrong, persistent consequence (W05, practice R6 and R7).

## Symptoms

- **Amount ignored.** `canHave` passed whenever the party gathers the resource, so a god could offer terms no mortal could meet. The mortal's routine accepted, missed the deadline, and the wolf stake applied.
- **Standing there counted as arriving.** A god already at the altar who accepted "be at the altar" was fulfilled that tick.
- **A late boon counted.** For a deadline-8 supplication, a bless on tick 9 made the thread *breached* (with the wolf) when no offering had been made, and *fulfilled* when one had. It should have expired with nothing owed.
- **A promise the action can't keep.** The feasibility check took any open prayer as enough for `bless-mortal`. `handleBless` refuses a punish petition, so the god was bound to an act the world would reject, and the thread breached.

All four reproduce through `submitProposal` and `runTick`.

## What Didn't Work

Each check judged whether the term looked plausible now, not whether the world could later observe its performance inside the window:

```ts
// canHave, before: possession or the right trade, never the amount
return (
  getResourceAmount(actor.inventory, resource) >= amount ||
  actor.gathers === resource
);
```

```ts
// be-at, before: judged a state, not a performance
after.actors.get(term.party)?.locationId === term.place
```

```ts
// boon, before: bounded below by acceptance, never above by the deadline
answered.answeredBy.sequence > acceptance.sequence
```

The bless check had its own copy of "an open prayer to this god" that had drifted from the action's rule.

## Solution

Make every check match the evidence the judge will later accept.

Feasibility is quantitative over the time left:

```ts
function canHave(
  state: WorldState,
  holder: EntityId,
  resource: string,
  amount: number,
  remaining: number,
): boolean {
  const actor = getActor(state, holder);
  if (actor === undefined) return false;
  const gathered =
    actor.gathers === resource
      ? gatherAmountOf(state.rules) * Math.max(0, remaining)
      : 0;
  return getResourceAmount(actor.inventory, resource) + gathered >= amount;
}
```

`be-at` counts only an arrival after acceptance and by the deadline. A term the party already satisfies is refused as `no-progress`:

```ts
const arrival = primary.find(
  (event) =>
    (event.kind === "entity-moved" || event.kind === "realm-transitioned") &&
    event.entityId === term.party &&
    event.to === term.place &&
    event.tick <= term.deadline &&
    event.sequence > (thread.acceptance?.sequence ?? Infinity),
);
```

A boon counts toward the bargain only inside the window. The late bless still commits and answers the prayer:

```ts
answered.answeredBy.sequence > acceptance.sequence &&
answered.answeredBy.tick <= thread.term.deadline
```

Blessing feasibility and the bless action share one predicate, `blessability()` in `packages/world/src/petitions.ts`. It requires the prayer to be addressed to this god, open, inside its window, and a request a blessing can answer. `handleBless` and `termObstacle` both call it.

## Why This Works

An obligation has two predicates that must agree: what may be promised, and what counts as keeping it. The world now accepts a term only if the party could perform it with the time it has. It counts only performances that fall after acceptance and by the deadline. Sharing `blessability` removes a duplicate rule that had already diverged from the action it promised.

## Prevention

For every obligation edge, write one boundary test with a positive control:

- **Acceptance sequence:** the event before acceptance does not count, and the same event after acceptance fulfils.
- **Deadline:** an event on the deadline counts.
- **Deadline + 1:** one tick late does not count, and the thread expires or breaches as the rules say.
- **Amount:** `held + gatherAmount × remaining` opens, and one unit more is refused.
- **Kind the action can't serve:** a punish-only prayer refuses `bless-mortal` at demand, counter and accept, and a help prayer opens, is accepted and is fulfilled.

When a term promises an action, check feasibility with the action's own validator predicate, never a copy.

The tests are in `packages/world/src/practices.test.ts` (`be-at`, bless terms), `supplications.test.ts` (amount, boon deadline, catch-up equal to live) and `petitions.test.ts` (`blessability`).

## Related Issues

- PR #97 (squash `c7b0f39`).
- [whole-entity-revision-pins-refused-petition-answers-2026-10-02.md](whole-entity-revision-pins-refused-petition-answers-2026-10-02.md): the opposite error on the same surface, where a stale pin refused answers the world should have accepted.
- [authoritative-rule-validation-2026-09-27.md](../best-practices/authoritative-rule-validation-2026-09-27.md): the world decides, from its own rules, what is true.
