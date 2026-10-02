---
title: A god's travel choices broke when the action word and the destination had to match
date: 2026-10-02
category: logic-errors
module: simulation-core
problem_type: logic_error
component: assistant
symptoms:
  - "At Olympus Gate, models sent `move` with `to: mountain-path` and the parser refused it: `to must be one of the ids you can see: great-hall`"
  - "qwen3 8B exhausted 135 of 159 requests across three gate episodes; 132 of the refusals were this error"
  - Gods walked back and forth between Olympus Gate and the Great Hall instead of crossing toward the town square
root_cause: logic_error
resolution_type: code_fix
severity: high
tags: [god-intent, movement, realm-transition, action-schema, petitions, o08, small-models, context-budget]
---

# A god's travel choices broke when the action word and the destination had to match

## Problem

A god at Olympus Gate can see two kinds of exit: a `move` to `great-hall` and a `realm-transition` to `mountain-path`. The model's action schema offered both destinations in one flat `to` list, but the parser accepted each destination only with its own action word, and the guidance never said which word reached which place. Small models paired them wrong, the parser refused the turn, and the gods spent their requests without leaving Olympus (O08).

## Symptoms

- qwen3 8B gate before the fix (`tools/scenarios/m2-greek-cast/episodes/2026-10-01T23-47-40/`): 64/68, 48/52 and 23/39 requests exhausted. 132 of the 135 failures were `to: to must be one of the ids you can see: great-hall`.
- Transcripts show gods repeating `move → great-hall` and `move → olympus-gate`, with no arrivals at the town square.
- The refusal was correct for the old parser: `move` only accepted `offer.moves`, so `{ action: "move", to: "mountain-path" }` failed even though `mountain-path` was on offer.

## What Didn't Work

- Travel guidance in plain words ("take Mountain Path toward the town square") told the model where to go but not which action gets there.
- A strict JSON schema with one `anyOf` branch per action kind would enforce valid pairs, but by the estimate in PR #83 it roughly triples the schema inside a 4K context. It was not measured separately.

## Solution

PR #83 (commit `cf489ba`) changed two things in `packages/agents/src/context.ts`.

The parser takes any offered destination and lets the destination decide the action kind:

```ts
case "move":
case "realm-transition": {
  const to = parseMember(fields.to, "to", [...new Set([...offer.moves, ...offer.transitions])], "to");
  if (!to.ok) return to;
  const destination = to.value as EntityId;
  const crossing = offer.transitions.includes(destination);
  return { ok: true, value: { action: crossing ? "realm-transition" : "move", to: destination } };
}
```

The guidance now names the exact pair for every hop:

```ts
`  To answer it, send action "${hop.action}" with to "${hop.id}" (${hop.name}) toward ${petition.petitioner}, and keep going each turn until you are with them; then bless them.`
```

The world still validates every proposal after parsing. A destination that is on neither list is still refused.

## Why This Works

The model could already see the right ids. What failed was asking it to infer which of two action words goes with an id. At a crossing the destination determines the action kind, so the parser treats the action word as a hint and the offered destination as the authority. Naming the pair in the guidance removes most of the wrong guesses in the first place.

After the fix, qwen3 8B exhausted 0 of 153 requests (`episodes/2026-10-02T00-13-37/`), and both gods crossed to the town square. llama3.2 3B still exhausted 35 of 280 (`episodes/2026-10-02T00-28-44/`), but none for this error. The rest were destinations not offered from the town square, texts over 280 characters, and one unknown linked event.

## Prevention

- When a small model picks an `(action, target)` pair, do not offer a flat union of targets and expect it to pick the matching action from prose. Name the exact pair in the guidance, or let the target decide the action when it uniquely does.
- Keep negative controls so tolerance stays narrow:

  ```ts
  expect(schema.parse({ action: "move", to: "altar" }).ok).toBe(false);
  expect(schema.parse({ action: "realm-transition", to: "altar" }).ok).toBe(false);
  ```

- Keep a positive control for each valid pair and each tolerated swap (`move` + `mountain-path` parses as `realm-transition`), as in `packages/agents/src/petitions-context.test.ts`.
- When a gate run exhausts many requests, bucket the exhaustion reasons before changing behaviour. Here one dominant, fixable error stood out from the rest.

## Related Issues

- [PR #83: a god's travel options pair each destination with its action](https://github.com/marcusrbrown/panthea/pull/83)
- [An unawaited god-turn promise crashed the sidecar on a store fault](../runtime-errors/unawaited-god-turn-store-fault-2026-09-29.md): same god-turn pipeline, different failure
- [A headless scenario needs a positive control per negative claim](../best-practices/end-to-end-scenario-with-positive-controls-2026-09-28.md): the before/after gate evidence follows this practice
