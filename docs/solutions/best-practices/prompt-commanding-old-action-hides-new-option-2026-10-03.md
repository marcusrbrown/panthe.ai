---
title: A prompt that commands the old action hides a new option from the model
date: 2026-10-03
category: best-practices
module: simulation-core
problem_type: best_practice
component: assistant
severity: high
applies_when:
  - Adding a new action or option to what a god (or any model-driven actor) can propose
  - The prompt still tells the model to take an older action for the same trigger
  - The new option needs more fields, or more invented content, than the old one
  - The new option has no prompt section until the model first creates the state it lives in
tags: [prompt-affordance, practices, petitions, bless, validated-openings, small-models, o08]
---

# A prompt that commands the old action hides a new option from the model

## Context

Phase A added practices: a god can answer a prayer on terms, or demand something of another god, through threads the world holds and judges. In the first gate on qwen3-8b-4k (`tools/scenarios/m2-greek-cast/episodes/2026-10-02T21-45-43/`), the gods made **0 practice moves in 115 requests**. They were not incapable: they answered 9 of 10 prayers per episode, 54 blesses in all.

Three things in the prompt steered them away from the new option:

1. **The old action was a command.** Prayer guidance said `bless them now (action "bless", petition "…")`.
2. **The new option had no surface.** The practices digest listed open threads only, so it was empty until a god opened one.
3. **The new option cost more.** A bless names one petition id. Opening a thread needs a move, a cause or prayer, and a whole term the model had to invent.

Parsing was not the cause: only 5 of 115 requests ran out of retries, all on movement or legend length, and no practice move was ever proposed. The model did what the prompt made easiest.

## Guidance

When a new option competes with an old one for the same trigger:

- **List choices; don't command one.** Each prayer now says `Your choices:` and gives help freely, set terms, or let it be, each as a peer.
- **Make the new option copyable.** Show a complete, legal object the model can send as written, not a description of the fields it would need.
- **Give the new option a surface before its state exists.** When no thread needs the god, the digest shows up to two openings: a demand over a known grievance and an offer on the newest prayer that can take one.
- **Build every shown object through the world's own validator.** An example the world would refuse teaches the model to fail.
- **Don't write out a default that invites churn.** A copyable counter that only extended the deadline was copied back and forth until the counter budget ran out. A counter example now appears only when the term has a real obstacle.

## Why This Matters

A small model copies the path of least resistance. Adding schema support and a sentence of explanation does not make an option usable when the prompt still commands the old action and the new one needs invented content. The gate measured it: 0 practice moves before, then 12 threads after the openings landed, and 28 threads once the parser and schema agreed.

The rule cuts both ways. The petition-pins doc records a case where prompt tuning changed nothing because the world was refusing the answers. Check the world first: if the action never commits, the prompt is not the lever. If it is never even proposed, look at the prompt.

## When to Apply

- A new proposal kind, move, or term joins an existing action space.
- A gate shows a capable model never proposes the new option.
- Guidance anywhere in the prompt uses an imperative for the older action.
- An example object in the prompt is hand-written rather than built and validated by the world.

## Examples

Before (`packages/agents/src/context.ts`):

```ts
`  ${petition.petitioner} is here: bless them now (action "bless", petition "${petition.id}").`
```

After: the prayer lists its choices, and the offer is a full object.

```ts
const terms =
  petition.offer === undefined
    ? []
    : [
        `  - set terms (your boon for an offering, to be judged by the world): ${send(petition.offer)}`,
      ];
const letBe = "  - or let it be: waiting is always allowed.";
```

Openings are shown only if the world accepts them (`packages/agents/src/practices.ts`):

```ts
const verdict = validatePractice(state, {
  ...proposalBase(actorId),
  kind: "practice",
  move: "offer",
  petition: prayer.id,
  term,
} satisfies PracticeProposal);
if (verdict.ok) {
  found[prayer.id] = { action: "practice", move: "offer", prayer: prayer.id, term };
}
```

A counter example appears only for a real obstacle:

```ts
if (termObstacle(state, thread.term, remaining) === undefined) {
  return undefined;
}
```

Regression checks:

- A prompt test for a prayer with an offerable term asserts `Your choices:` and a copyable `"move":"offer"` object, and that no line commands `bless … now`.
- Each opening shown in a test world passes `validatePractice`.
- In a gate run, practice moves greater than 0 is a property to watch, not a pass condition by itself.

## Related

- [move-realm-transition-destination-pairing-2026-10-02.md](../logic-errors/move-realm-transition-destination-pairing-2026-10-02.md): name the exact action and target in guidance, and let the world filter what is offered.
- [whole-entity-revision-pins-refused-petition-answers-2026-10-02.md](../logic-errors/whole-entity-revision-pins-refused-petition-answers-2026-10-02.md): the opposite case, where prompt tuning could not help because the world refused every answer.
- PR #97; gate evidence in `tools/scenarios/m2-greek-cast/episodes/2026-10-02T21-45-43/`, `2026-10-02T22-50-35/`, `2026-10-03T00-38-55/`.
