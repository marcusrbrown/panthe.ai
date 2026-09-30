---
title: Build the direct version first in a greenfield, single-user codebase
date: 2026-09-27
last_updated: 2026-09-29
category: best-practices
module: workspace
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - Adding a feature, contract, or storage format that has not shipped
  - Deciding whether to add a migration, upcaster, shim, limit, or validation layer
  - Evaluating hardening suggestions from plan reviews, code reviews, or Fro Bot
  - Writing comments or tests for newly built or newly fixed code
tags: [greenfield, yagni, over-engineering, trust-model, code-comments, review-triage]
---

# Build the direct version first in a greenfield, single-user codebase

## Context

Panthea is pre-release, offline, and single-user, with no shipped data. M1 Phase A was planned with many review lenses. Each one added a reasonable-sounding safeguard, and the implementation followed the plan literally. The result was about 3,000 lines of machinery with no consumer and no threat to defend against:
- a SQLite migration ladder with pre-migration backups;
- an event upcaster registry, demonstrated with an invented v1→v2 rename;
- "hostile archive" import with byte/row/time budgets, a schema allowlist, a private copy, two integrity scans, and a directory-fsync framework;
- per-commit permission re-enforcement;
- a proposal byte limit, reserved model fields, and generic proposal constraint fields;
- six sync frame types;
- a telemetry redactor;
- trace retention pruning;
- rule and reducer registries.

Code review then asked for more hardening. The fix passes removed roughly 2,000–2,700 lines instead of adding them. The result is easier to read, test, and change.

## Guidance

- **Every safeguard has to pay rent.** Keep it only if it defends a concrete threat in the real trust model or maps to a requirement ID or an `AGENTS.md` invariant. The real trust model here: one local user, archives the owner exported, and no credential-bearing inputs in M1. Rule checks that keep a proposal from creating value, claiming authority, or forcing lifecycle transitions do pay rent; see [authoritative rule validation](authoritative-rule-validation-2026-09-27.md).
- **Build the direct version first.** No migrations, upcasters, or compatibility shims for formats that have not shipped. A schema-number mismatch is rejected, never silently reset.
- **No contracts ahead of their consumer.** Add model-request IDs, sync deltas, and proposal constraints when the code that produces or consumes them exists.
- **Enforce data rules where data enters.** The credential rule is "no credential-bearing data is passed into content, saves, prompts, telemetry, or logs". It is not enforced by pattern-scanning stored strings.
- **Measure before optimizing.** For example, measure the JSON projection commit against the 1 Hz budget before redesigning storage.
- **Reviewer suggestions get the same rent test.** Decline the ones that fail, and reply with the plan's superseded decision as the rationale.
- **Record superseded plan decisions in place** with a dated `Superseded YYYY-MM-DD:` note. Do not erase their context.
- **Comments and test names describe behavior only.** They carry no plan, unit, or phase references, no review or finding references, no decision history, no narration, and no process jargon such as "tombstone". Findings and rationale belong in `docs/solutions/`, the plan, ADRs, or traceability.
- **Tests assert the correct behavior.** A test that pins a known-broken value (for example "tick is 0 after reopen" plus an explanatory comment) is deleted and replaced by one that fails until the bug is fixed.

## Why This Matters

Each layer — plan review, implementation, code review, fixes — added safeguards without asking whether they paid rent for this app. The cost compounded. Every speculative layer is code to read, test, keep consistent, and later delete, and it hides the few checks that actually protect the world. A reviewer, human or bot, will keep proposing hardening. Without a written rent test, each suggestion looks locally justified.

## When to Apply

- Before adding any limit, version gate, migration, redactor, registry, or reserved field.
- When triaging review findings: fix the real defects, and decline ceremony with a rationale.
- When writing plans: prefer "measure, then decide" over pre-committing to an optimization.
- When writing comments and tests for any change.

## Examples

KEEP versus CUT, from the Phase A archive import:

| Safeguard | Verdict | Reason |
|---|---|---|
| Manifest covered by the checksum; manifest checked against the tables | KEEP | An inconsistent archive would publish unreplayable history |
| Contiguous event sequence and parsed event rows on import | KEEP | Later commits and rebuilds depend on them |
| Staged slot plus atomic rename; never overwrite a world | KEEP | Protects the user's existing worlds |
| Byte/row/time budgets, schema allowlist, private copy | CUT | Archives are files the owner exported; no upload boundary exists in M1 |
| Migration ladder and upcasters | CUT | No format has shipped |
| Trace redactor | CUT | No credential-bearing producer exists; the rule is enforced at the source |

Comment hygiene:

```ts
// Before
// Unit 4 adds the evaluators that check preconditions against state,
// until then reject... (Design decision, see review finding)

// After: state what the code does, or say nothing
// Rejects proposals whose actor is not at the edge's origin.
```

## Triage with evidence (2026-09-28)

A finding is real when it comes with a concrete failing sequence of supported calls. These suggestions for the durable proposal journal had none, and each was declined on what the code already does:

- **A race on `input_order`:** `insertExternalProposal` reads the maximum and inserts inside one synchronous `bun:sqlite` `IMMEDIATE` transaction with no `await`, so two requests cannot interleave (`packages/persistence/src/journal.ts:141-174`).
- **An archive format version bump for the journal:** the schema version already gates imports, and a mismatch is rejected before any table is read (`packages/persistence/src/archive.ts:490-494`).
- **Quarantine for an unparseable journal row:** intake and import both parse the proposal and observation before inserting, so no supported path writes a bad row (`apps/simulation/src/server.ts:624`, `packages/persistence/src/archive.ts:803-820`).
- **Migrating the trace tables of old stores:** a store with another schema version is refused before the trace schema is touched, and import builds a fresh database instead of copying trace tables (`packages/persistence/src/store.ts:112-125`).
- **Unicode normalization of retries:** strings that differ in normalization form are different bytes, so the same `proposalId` with them is different content and a 409 is correct (`journal.ts:92-119`).

The findings that were fixed each had a sequence: with a cap of 1, an external claim took the tick's only slot and its actor's routine went `over-limit` ([tick admission](../logic-errors/tick-admission-starved-external-proposals-2026-09-28.md)); after an archive restore, retrying a consumed proposal returned 500 ([durable journal](../integration-issues/proposal-accepted-then-lost-before-durable-2026-09-28.md)).

## Gate review findings on requirements or live failures (2026-09-29)

A review finding becomes work only if it passes one of two gates:

1. It breaks a named requirement ID, and the requirement's text is what makes it a violation.
2. It fails reproducibly through code that runs today.

Everything else is dropped outright. "Confirmed" only means the code does what the finding says. It doesn't prove the behavior matters, breaks a requirement, or has a producer.

M2 Unit 6 made the difference concrete. It added memory, reports, relationships and fire cause. W04 reads: "A character cannot use an unseen private event without a perception/power/report path; remembered outcomes influence later behavior" (`docs/product/requirements.md`). That gates the use of unseen *events*. A report claim that names someone the teller never met cites no event and is allowed to be false, so it isn't a W04 violation. Several other findings failed both gates:

- a refactor presented as a bug;
- a prediction about full-cast scale;
- guards against a producer, model-written reports, that didn't exist yet.

Don't keep a speculative finding alive as deferred work. On a pre-release project with no shipped data or archives, deferring just moves the speculation into the backlog. If a finding is real, fix it now. If it depends on a producer that doesn't exist yet, or on a predicted scale problem without a failing sequence, drop it. The future producer or measurement can raise it again.

Unit 7 applied the same rule:

- **Dropped:** a request for a real process kill during inference. A killed process can't journal anything, and an in-process abort already proves an aborted turn journals nothing.
- **Kept:** a failure that could happen in the running service. A store read outside the handled path turned an unawaited god-turn promise into an unhandled rejection that crashed the sidecar ([unawaited god-turn promise](../runtime-errors/unawaited-god-turn-store-fault-2026-09-29.md)).

| Finding shape | Outcome |
|---|---|
| Names a requirement and shows the code breaks it | Fix |
| Shows a failing sequence through supported calls today | Fix |
| Predicts a future scale or producer problem | Drop |
| Proposes a cleaner shape without a failing behavior | Drop |
| Is justified only by "might be useful later" | Drop |

Severity labels and "is it real in the code" checks are not the gate.

## Related

- [World and persistence composed incorrectly despite green package tests](../integration-issues/world-persistence-composition-broken-after-reopen-2026-09-27.md)
- `docs/plans/2026-09-27-001-feat-m1-persistent-living-world-plan.md`: the `Superseded 2026-09-27` notes
- `AGENTS.md`: the credential invariant
