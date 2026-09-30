---
title: Knowledge leaks through perception timing and cited reports
date: 2026-09-29
category: logic-errors
module: simulation-core
problem_type: logic_error
component: service_object
symptoms:
  - A god who arrived after a private event could see and cite it
  - A report could smuggle the cited event's true consequence into the listener's belief
  - A harmless report citing a strike could turn the listener against the striker
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [perception, witness-memory, reports, provenance, belief, w04, perceives-event]
---

# Knowledge leaks through perception timing and cited reports

## Problem

Knowledge crossed its boundaries in two places.
- **Perception** judged an event by where the observer stood when the snapshot was taken, not where the observer stood when the event happened.
- **Reported memory** treated a cited event id as a source of authoritative facts instead of as provenance.

Both broke the same rule, W04: a character knows an event only if it perceived it or was told about it, and what it was told is only the teller's account.

## Symptoms

- In PR #56, Zeus could stand outside the tavern while the farmer gathered, walk in later, and then see and cite that gather. The review flagged it as W04: "past private events become visible on arrival."
- The prompt and the allowed `linkedEventId` values were built from the same snapshot, so the leaked event became evidence the model could use.
- In PR #58, a report could say "nice weather" while citing Zeus's strike. The listener's told memory copied the cited memory's subjects and consequence anyway, so Hera turned against Zeus because of facts the teller never claimed.

## What Didn't Work

Filtering events only by where they happened wasn't enough. That rule asks "did this event happen somewhere the observer can perceive now?", which leaks history the moment the observer arrives.

Using `linkedEventId` as evidence for a report was also wrong. A citation proves only that the teller is allowed to cite the event. It doesn't make the teller's words true, and it must not copy the event's real subjects or consequence into the listener's belief.

## Solution

**Perception judges presence at the time of the event.** `perceivesEvent` in `packages/world/src/perception.ts` works out where the observer was when the event happened, using the observer's own moves in the recent event window. If the window can't place the observer, the event is dropped.

```ts
export function perceivesEvent(
  state: WorldState,
  observer: ActorState,
  event: WorldEvent,
  window: readonly WorldEvent[],
): boolean {
  const at = eventLocation(state, event, window);
  if (at === undefined || !perceivedLocations(state, observer).has(at)) {
    return false;
  }
  return wasPresent(state, observer.id, event, at, window);
}
```

**Witness memory uses the same rule** (`packages/world/src/memory.ts`), so what a character remembers and what it perceives can't drift apart.

**A report's claim is the only source of belief.**
- A report carries an optional structured `claim` (`{ effect, agent, target? }`), and the claim may be false.
- The listener's told memory takes its subjects and consequence only from that claim.
- `linkedEventId` is provenance only. `packages/world/src/validate.ts` accepts it only when the teller has a first-hand witnessed memory of that event.

```ts
const claim = report.claim;
// ...
subjects: unique([
  report.entityId,
  ...(claim === undefined
    ? []
    : [claim.agent, ...(claim.target === undefined ? [] : [claim.target])]),
]),
...(claim === undefined ? {} : { consequence: claim }),
```

A cited report without a claim teaches the listener nothing beyond who spoke, and it creates no consequence and no relationship change. A false claim can still move a relationship, but only because the teller made that claim, never because the citation carried the truth along.

## Why This Works

Presence is a fact about time. The right question is "was the observer there when it happened?", not "is the observer there now?"

A citation is provenance. It can show that the teller had a legitimate path to the event, but it isn't a channel through which the listener learns what really happened. The listener learns the teller's account, which may be wrong, incomplete or harmless.

Keeping these two boundaries separate keeps W04 intact:
- unseen private events stay unseen;
- witnesses can cite what they saw;
- listeners believe what they were told;
- a rumor never quietly becomes a verified fact.

## Prevention

- Judge presence at the time of the event, never at commit or snapshot time.
- Treat any id a producer attaches as provenance unless the code explicitly makes it an authority.
- Derive a listener's belief from what was claimed, not from the record that was cited.
- Use one perception rule for both live snapshots and witnessed memory.
- Test each boundary with a positive control:
  - present when it happened → sees it; arrived later → doesn't;
  - cited without a claim → no consequence;
  - false claim → belief follows the claim, not the cited event.

## Related Issues

- PR #56: presence at the time of the event (`c48413b`)
- PR #58: report claims and citation as provenance
- `docs/product/requirements.md`: W04
- [Authoritative rule validation](../best-practices/authoritative-rule-validation-2026-09-27.md): the world, not a value's origin, decides what is true
