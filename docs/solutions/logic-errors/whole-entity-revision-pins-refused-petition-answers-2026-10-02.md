---
title: Whole-entity revision pins refused every petition answer, and the gate blamed the model
date: 2026-10-02
category: logic-errors
module: simulation-core
problem_type: logic_error
component: assistant
symptoms:
  - "No god answered a petition in any of 42 god-episodes across seven models, from llama3.2 3B to a strong hosted model"
  - "A hosted model's run journaled 198 proposals, but only about 25 showed up as committed actions; the transcripts gave no reason for the rest"
  - "Once outcomes were recorded, 73 of 81 proposals in one episode were blesses refused as `stale-target`"
  - "A goal was marked achieved even though the bless sent with it had been refused"
root_cause: logic_error
resolution_type: code_fix
severity: critical
tags: [optimistic-concurrency, expected-revisions, stale-target, bless, petitions, gate-harness, o08, observability, model-evaluation]
---

# Whole-entity revision pins refused every petition answer, and the gate blamed the model

## Problem

When a god answered a prayer with a bless, the proposal pinned the whole revision of the petitioner and of the god's location. Revisions go up on any change: a routine gather raises the petitioner's, and any mortal walking through the square raises the location's. During the two to three seconds a model spends thinking, one of those almost always changed, so validation refused the bless as `stale-target` before it ever checked whether the bless itself was allowed. The gate harness recorded only committed actions, so for a whole day of runs this looked like models that would not act (O08).

## Symptoms

- 0 petitions answered across 36 local god-episodes on six models (3B to 8B), then 0 of 12 heard on `gpt-6-luna` through a hosted endpoint.
- In the hosted run each successful request journaled a proposal (61, 69 and 68 per episode), but the transcripts showed only 8 to 10 committed actions per episode and said nothing about the rest.
- A goal could be marked achieved even when its accompanying action failed (`packages/world/src/actions.ts`), so "achieved" was no evidence of a bless.
- After the harness recorded outcomes, one 300-second episode showed `bless 73 × stale-target, move 4 × committed, realm-transition 2 × committed, report 1 × committed, report 1 × stale-target`.

## What Didn't Work

Each of these targeted the model, not the world:

- Prompt tuning: prayers first, answer guidance, collapsed repeated reports. Repetition improved and answers stayed at 0.
- The move/realm-transition fix (see Related). It fixed a real refusal, but answers stayed at 0.
- A comparison of six local models, then a strong hosted model as a ceiling test. All failed the same way. That sameness was the clue: when a strong model fails exactly like a 3B one, suspect the harness or the world.
- Fixing only the petitioner pin. A world test went green for the gather case, but a second test, another mortal walking through the god's location, still failed with `expected altar at revision 0, found 2`. The location pin had the same flaw.

## Solution

Two changes, in this order.

**1. Record what the world did with every proposal** (`tools/scenarios/m2-greek-cast/src/dispositions.ts`). The proposal journal already held each proposal's outcome and rejection reason. The transcripts just never showed it. Each episode transcript now lists every proposal with its outcome: committed with the events it caused, rejected with the reason code, or `committed, no event`. The summary adds one count line by action kind and outcome. No new world events were needed.

**2. A bless pins nothing; a report no longer pins its listener** (`packages/agents/src/observation.ts`):

```ts
// A bless pins no revision. Everything it depends on is judged again when
// it is validated: the god's power and divinity, the petitioner alive and
// at the god's location, the petition open, addressed to this god, of a
// kind a bless answers, and inside its window.
proposal = { ...base, expectedRevisions: [], targets: [petitioner.id], kind: "bless", petition: petition.id };
```

`handleBless` in `packages/world/src/validate.ts` already rechecks each of those conditions, so a genuinely stale bless is now refused for its real reason: `not-adjacent` if the petitioner walked away, `dead-actor`, `insufficient-power`, or `malformed` if the petition was answered or lapsed. `strike` was not affected: it pins the god, its location and the building, not the offender or the owner, and a test shows an owner's inventory change doesn't stale it.

## Why This Works

Optimistic concurrency answers one question: has anything changed since you looked? A whole-entity revision answers it for every field at once. That is right only when the action depends on all of that entity's state. A bless depends on a few specific facts, and the validator checks each of them at commit time. Pinning the whole entity added refusals for changes the action doesn't care about, and the generic `stale-target` hid the specific reason when a real one applied.

Results on the fix, 3 × 300 s each:

| Model | God-episodes passing every check | Petitions answered | Notes |
| --- | --- | --- | --- |
| `gpt-6-luna`, hosted (`episodes/2026-10-02T03-46-02`) | 5 of 6 | 9 of 10 heard in each god-episode | Zeus in episode 1: goal never ended |
| qwen3 8B, local (`episodes/2026-10-02T04-19-56`) | 6 of 6 | 9 of 10 heard in each god-episode | every answer native; `bless 54 × committed`, `report 19 × stale-target` |
| llama3.1 8B, local (`episodes/2026-10-02T04-04-50`) | 2 of 6 | 17 blesses committed; four god-episodes heard 1 or 2 petitions and answered none | two repetition failures in episode 1 |

Before the fix, the same models answered 0 petitions.

## Prevention

- Pin only what the action depends on. If the validator rechecks a condition at commit time, don't also pin the entity it reads. Where a pin is still needed, prefer the specific fact over the whole entity.
- A harness that evaluates agents must record what happened to every proposal, rejections and their reasons included, before anyone draws a conclusion about the model. "Committed actions" alone can't tell "won't act" from "acted and was refused."
- Treat "every model fails the same way" as evidence against the harness or the world, and run a strong model early as a control.
- Don't use a goal's "achieved" status as evidence of the action that came with it.
- Test concurrency the way the world runs: one test where a routine changes the target, another where unrelated traffic changes the location, each run between observing and validating. Pair them with controls showing a genuinely stale proposal is still refused for its real reason.

Still open: the god and location pins remain on move, strike, report and legend, and reports are the largest remaining refusal (26 × `stale-target` on `gpt-6-luna`, 19 on qwen3).

## Related Issues

- [A god's travel choices broke when the action word and the destination had to match](move-realm-transition-destination-pairing-2026-10-02.md): the earlier gate fix
- [Check a hosted endpoint's usage policy and smoke-test it](../best-practices/hosted-endpoint-policy-and-smoke-test-2026-10-02.md): the ceiling-test setup
- [Rule validation in the authoritative world](../best-practices/authoritative-rule-validation-2026-09-27.md): where proposals are validated
- [End-to-end scenario with positive controls](../best-practices/end-to-end-scenario-with-positive-controls-2026-09-28.md): why each "never" check needs a control that can fail
