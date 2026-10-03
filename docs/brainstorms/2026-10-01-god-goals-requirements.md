---
date: 2026-10-01
topic: god-goals
---

# Gods That Pursue Goals

## Summary

Each god pursues one goal it chooses for itself: a short aim in its own words, naming one target it knows. The goal persists across turns until the god declares it achieved, failed, or abandoned. A god also sees its own recent words and actions. A legend becomes a public telling that changes what its listeners believe and feel. The replan passes when the same experience gate, rerun on llama and Gemma with goal checks added, earns a continue from the owner.

---

## Problem Frame

The owner rated all three M2 experience-gate episodes replan (llama3.2 3B, 5 minutes each, `tools/scenarios/m2-greek-cast/episodes/2026-09-30T15-22-36/`). The rubric notes describe one pattern. Conversations repeat without resolution. Moves and realm transitions have no visible motive. Few relationship changes land. It is unclear whether a legend is a thought or a telling with an audience.

The automated checks show the same pattern. Repetition failed in 5 of 6 god-episodes, every time as a run of reports between Zeus and Hera. Gemma 4 on the same gate (`tools/scenarios/m2-greek-cast/episodes/2026-10-01T04-17-25/`) followed instructions better but spent every action on that loop, with runs of 28 to 34. The loop therefore comes from how a turn is built, not from the model.

Three gaps in the current turn explain it:

- Nothing persists a god's intent between turns. Each turn asks "What do you do?" from the scene, memories, and feelings, with static drive weights.
- A teller never sees its own report. Reports are private to the listener, and the teller keeps no memory of what it said. The listener answers each report, and the teller speaks again with no record that it already spoke.
- The god profiles say other inhabitants can hear and repeat a legend. The rules only record it, and no one hearing it changes what they believe or feel.

The M2 plan's risk table already names own-action memory as the mitigation for repetition. It was never built.

---

## Requirements

**Goals**
- R1. On any turn, a god may set a goal in its own words, naming exactly one target entity the god knows from its perception or memories.
- R2. A god has at most one active goal. Setting a new goal ends the active one as abandoned.
- R3. A god may end its active goal as achieved, failed, or abandoned, on any turn, alongside its action.
- R4. The world records every goal set and every goal ended as events with the god as their source. Replaying the log reproduces each god's goal history.
- R5. A goal is private to its god. No other character perceives it unless the god tells them through a report.
- R6. While a goal is active, the god's prompt shows the goal, its target, and what the god has perceived, been told, or done involving that target since setting it.

**Self-knowledge**
- R7. A god's prompt shows its own most recent actions, including the words it spoke and the claims it made, in order.
- R8. A god learns how others responded only through what it perceives or is told. Its own past words never reveal a listener's private memories or feelings.

**Voice**
- R9. Report words and legend words are spoken in the god's own voice. They don't prefix the god's name or narrate the god in the third person.

**Legends**
- R10. A legend is told aloud to every character present at the narrator's place when it commits. The prompt names who is present now, and the world records who actually heard it.
- R11. Each listener remembers a legend as told by its narrator. A legend may carry a claim of who harmed or did a kindness to whom, which shifts listeners' feelings the same way a report's claim does.
- R12. A legend spreads further only when a listener retells it by report. It does not change divinity or favor.

**Inspection and evidence**
- R13. Experience-gate transcripts show each goal when it is set and when it ends, and list each action under the goal active when the god chose it. A legend's entry shows who heard it and what each listener came to believe or feel.
- R14. The experience gate adds two per-god, per-episode checks: the god set at least one goal, and at least one of its goals ended. The existing checks stay: profile trace, at least 5 actions, influence (at least one caused belief or relationship change), and the repetition cap of 3.
- R15. The gate runs 3 fresh 5-minute episodes on llama3.2 3B at 4K, and the same on Gemma 4 E4B at 4K with reasoning off.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R4.** Given Hera holds the goal "make Zeus admit his deceit" targeting Zeus, when she sets the goal "win the farmer's devotion" targeting the farmer, the first goal ends as abandoned, the second becomes active, and both changes are in the event log.
- AE2. **Covers R3, R6.** Given Zeus's active goal targets Hera, when Zeus declares it achieved, his next prompt shows no active goal and the ended goal appears in the transcript with its outcome.
- AE3. **Covers R5.** Given Hera holds a goal targeting Zeus, Zeus's prompt never contains it unless Hera told him through a report.
- AE4. **Covers R7, R8.** Given Zeus told Hera "You will answer for this" last turn, his next prompt shows that he said it to Hera, and nothing about Hera's resulting memory or feeling.
- AE5. **Covers R10, R11.** Given Hera tells a legend at the great hall claiming harm by Zeus on her, with the farmer and Zeus present, the farmer and Zeus each remember it as told by Hera, and the farmer's feelings toward Zeus shift by the claim.
- AE6. **Covers R12.** Given the farmer heard Hera's legend, inhabitants elsewhere learn of it only if the farmer or another listener reports it to them.

---

## Success Criteria

- The owner rates the rerun gate with the existing rubric. No dimension scores 0 in any episode, and the decision is continue.
- On both models, every god in every episode passes all automated checks, including the repetition cap of 3, at least one goal set, and at least one goal ended.
- A planner can build this from this document without inventing goal lifecycle behavior, what a god may see, legend audience rules, or the pass bar.

---

## Scope Boundaries

- The gods-first scheduler (M2 Unit 10) and the quiet-world director (M2 Unit 12).
- Explicit scene objects, and penalties or refusals for repeated actions. These are added only if the rerun gate still shows loops.
- Authored goal templates per drive.
- Legends that spread on their own through inhabitant routines.
- Legends affecting divinity, favor, or worship.
- More than one active goal per god.
- The remaining five gods (M2 Unit 9). They wait until this replan passes the gate.

---

## Key Decisions

- **Goals declared by the god, not authored:** keeps judgment with the model and needs no per-god goal content. Goal quality depends on the model, and the gate measures it.
- **A goal names one target and the god ends it:** the target lets the prompt show progress and lets the transcript tie actions to the goal, without a rule engine judging success.
- **Conversations end through goals, not rules:** goals plus self-knowledge should end exchanges on their own. The repetition cap stays as the check, and a scene mechanism comes only if the rerun still loops.
  - **Superseded 2026-10-02:** the rerun still looped (`tools/scenarios/m2-greek-cast/episodes/2026-10-02T14-29-04/`), so conversations now end through practices: threads the world holds and judges (`docs/brainstorms/2026-10-02-god-practices-requirements.md`, plan `docs/plans/2026-10-02-001-feat-god-practices-plan.md`). Goals stay as private motives that never open, certify, or close a thread. The text above is kept for its context.
- **No stated reason per action:** if the design holds, the reason for an action should be clear from what the god does. The owner's causality score judges it.
- **Legends become public tellings:** answers the owner's inspectability question with one rule that reuses the report claim, without a spreading mechanic.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R7][Technical] How many recent own actions the prompt shows, recorded as a tunable alongside the existing memory and feeling caps.
- [Affects R6][Technical] How much target-related history the prompt shows under the 4K context budget.
- [Affects R1, R6][Technical] What happens to an active goal whose target the god can no longer perceive or remember.
- [Affects R11][Technical] Whether the memory caps need adjusting when a legend gives many listeners a memory at once.

---

## Sources / Research

- Rated transcripts and owner rubric notes: `tools/scenarios/m2-greek-cast/episodes/2026-09-30T15-22-36/`
- Gemma 4 comparison run: `tools/scenarios/m2-greek-cast/episodes/2026-10-01T04-17-25/`
- Current turn and prompt: `packages/agents/src/turn.ts`, `packages/agents/src/context.ts`
- Report privacy and teller memory: `packages/world/src/perception.ts`, `packages/world/src/memory.ts`
- Legend recording: `packages/world/src/validate.ts`, `packages/world/src/state.ts`
- M2 plan risk table (own-action memory as mitigation), Units 9–13, and the experience-gate result: `docs/plans/2026-09-29-001-feat-m2-autonomous-greek-cast-plan.md`
- Requirements touched: W04 (knowledge and memory), W05 (authoritative rules), W07 (legends), X04 (inspection), O04 (causal history), O08 (lively unattended world): `docs/product/requirements.md`
- Acceptance rubric: `docs/product/acceptance.md`
