---
title: Build the direct version first in a greenfield, single-user codebase
date: 2026-09-27
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

- **Every safeguard has to pay rent.** Keep it only if it defends a concrete threat in the real trust model or maps to a requirement ID or an `AGENTS.md` invariant. The real trust model here: one local user, archives the owner exported, and no credential-bearing inputs in M1.
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

## Related

- [World and persistence composed incorrectly despite green package tests](../integration-issues/world-persistence-composition-broken-after-reopen-2026-09-27.md)
- `docs/plans/2026-09-27-001-feat-m1-persistent-living-world-plan.md`: the `Superseded 2026-09-27` notes
- `AGENTS.md`: the credential invariant
