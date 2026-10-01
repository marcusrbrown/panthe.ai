---
date: 2026-10-01
topic: god-petitions
---

# Petitions, Answers, and Goals That Stick

## Summary

Mortals pray at the altar to a named god about something that really happened to them, asking for help or for an offender's punishment. The god hears the prayer wherever it is. The world judges whether the god answered, either by striking the offender or with a new bless action, and the petitioner's worship rises or falls to match. When the world goes quiet, a director causes real trouble among mortals. Gods learn of it through petitions or by seeing it themselves. A god's goal now persists: re-setting an identical goal does nothing, and a goal gives way only after time passes, after something new involves its target, or when the god declares it achieved or failed.

---

## Problem Frame

Gate 2 of the M2 experience gate failed on both models (`tools/scenarios/m2-greek-cast/episodes/2026-10-01T15-37-30/` for llama3.2 3B, `2026-10-01T15-52-36/` for Gemma 4). Goals and self-knowledge (docs/brainstorms/2026-10-01-god-goals-requirements.md) did not break the Zeus↔Hera report loop. Repetition failed in 5 of 6 god-episodes on llama and in 6 of 6 on Gemma, with runs of up to 25. Every goal on both models targeted the other god.

The world gives the gods nothing else to react to:

- Zeus and Hera start together in the Hall of the Gods, which has no buildings and no mortals.
- Strike has no target at the start.
- Mortal routines never move a mortal toward the gods.
- On Gemma, both gods spent every one of 203 turns alone with each other. On llama, about two thirds of turns were spent that way.
- Nothing a god can perceive changes except the other god's words.

Goals are also brittle:

- A goal lasted a median of 1 own action on llama and 2 on Gemma.
- 31% of llama goal sets and 100% of Gemma goal sets repeated the previous goal.
- Only 2 of llama's 10 "achieved" goals had a visible outcome.

External research found no evidence that models of 8B or smaller can hold open-ended goals unaided. Systems that work at that size have the world track progress for them.

---

## Requirements

**Petitions**
- R1. A mortal prays at the altar when something real has happened to it. That means one of its buildings burned or was damaged, it was robbed, its stock spoiled, a trade it sought failed, it ran out of a resource its routine needs, or it holds a grudge against someone.
- R2. Each cause is a recorded world event. When a routine finds a need it can't meet (a resource it lacks, a trade no one accepts), the world records that unmet need as an event, so a prayer about it can cite it. A mortal has at most one open unmet need per resource or trade, until the need is met.
- R3. A prayer names one god and makes one request. The request is help for the petitioner, or punishment of a named offender. A mortal asks for punishment only when the offender owns a building; otherwise it asks for help. The prayer records the event that prompted it, and each cause leads to at most one petition.
- R4. A mortal prays to the god it favours most. When favour is tied, it prays to the god that has received fewer petitions so far.
- R5. A mortal's routine takes it to the altar to pray and back again afterward.
- R6. The named god hears a prayer addressed to it wherever it is. This is a divine sense. Anyone at the altar sees the mortal pray.
- R7. A god's prompt lists the petitions it has heard and not yet answered or let lapse. Each entry shows who asked, what they asked for, why, where the petitioner is, and for a punish petition the offender and the buildings it owns. The god may move toward these places and act on these ids. It may strike a building only once it can see it.
- R8. The prompt shows which exit leads toward each place a petition names. This is knowledge of the map, not of events.

**Answers and worship**
- R9. The world records a petition as answered when the named god acts on it within the answer window. A punish petition is answered by a strike on a building the offender owns. A help petition is answered by blessing the petitioner.
- R10. A god may bless a mortal at the god's own location. A blessing gives the mortal the materials to repair its damaged building, or the resource it lacks. The mortal rebuilds through its own routine, and the damage stays on record. A blessing costs the god divinity.
- R11. Answering a petition sends the petitioner a sign from the god, a recorded divine act. When the sign arrives, the petitioner's favor toward the god rises and it worships that god, which credits the god's divinity. When the answer window closes unanswered, the petition lapses and the petitioner's favor toward that god falls.
- R12. A petition never commits a god to anything. The god may answer, refuse, or ignore it.

**Director**
- R13. When nothing consequential has happened for the quiet window, the director causes one real trouble among the mortals: a theft between two mortals, a fire in a storehouse, or a spoiled stock. The trouble is attributed to the director. It is never undone automatically.
- R14. Director trouble reaches a god only through petitions or through what the god itself perceives.

**Goals that stick**
- R15. Setting a goal with the same target and the same normalized words as the active goal does nothing and records nothing.
- R16. A god may replace or abandon its active goal only in four cases: N world ticks have passed since the goal was set, something new involving the goal's target has reached the god since then, the god has heard a new petition since then, or the god ends the goal as achieved or failed.
- R17. A refused goal change is recorded as a private event with its reason, and the god's next prompt says the change was refused and why.

**Evidence**
- R18. Transcripts show each prayer with the petitioner, the god, the request, and the cause. They also show each answer, sign, or lapse, each worship change, each director event and its attribution, each unmet-need event, and each refused goal change.
- R19. The experience gate adds two checks for each god in each episode: the god heard at least one petition, and answered at least one. All existing checks stay, including the repetition cap of 3. Goal lifetime and refused goal changes are reported, not checked.
- R20. The gate runs 3 fresh 5-minute episodes on llama3.2 3B at 4K, and 3 on Gemma 4 E4B at 4K with reasoning off.

---

## Acceptance Examples

- AE1. **Covers R1, R3, R6.** The farmer's tavern burns after Zeus strikes it. On a later tick, the farmer prays at the altar to Hera to punish Zeus, and the prayer records the burning. Hera hears it on Olympus. Zeus does not.
- AE2. **Covers R7, R8, R9, R11.** The woodcutter robbed the farmer, and the farmer has a punish petition against him with Zeus. Zeus's prompt names the woodcutter, its woodshed, and the exit toward town. Zeus travels there and strikes the woodshed within the window. The world records the petition as answered and sends the farmer a sign. The farmer's favor toward Zeus rises, and it worships Zeus.
- AE3. **Covers R10, R9.** The farmer has a help petition with Hera because its storehouse burned. Hera travels to the farmer and blesses it. The farmer receives repair materials, Hera loses divinity, and the petition is recorded as answered. The farmer's routine rebuilds the storehouse, and the burning stays on record.
- AE8. **Covers R2, R1.** The farmer's routine needs grain it can't get. The world records the unmet need, and the farmer later prays to Hera for help, citing it.
- AE4. **Covers R11.** A petition's answer window closes with no answer. The petition lapses, and the petitioner's favor toward that god falls.
- AE5. **Covers R13, R14.** The world has been quiet. The director makes the woodcutter rob the farmer, and the theft is attributed to the director. The gods learn of it only when the farmer prays.
- AE6. **Covers R15.** Hera's active goal is "Make Zeus admit his deceit," targeting Zeus. She sets the same goal again. Nothing changes and no event is recorded.
- AE7. **Covers R16, R17.** Zeus set a goal targeting Hera two ticks ago, and nothing new involving Hera has reached him since. He tries to replace it. The world refuses and records the refusal, and his next prompt says why. After he hears the farmer's petition, he may replace it.

---

## Success Criteria

- On both models, every god in every episode passes all automated checks. These include the repetition cap of 3 and at least one petition heard and one answered.
- The owner rates the gate with the rubric, gives no dimension a 0 in any episode, and decides to continue.
- A planner can build this without inventing petition causes, answer rules, the bless action's effect, director behavior, or the goal-change rule.

---

## Scope Boundaries

- No structured choice menus or separate planning call. Those are the fallback if this gate fails.
- No restaging of the starting cast.
- No gods-first scheduler (M2 Unit 10).
- The remaining five gods (M2 Unit 9) wait until this gate passes.
- No free-text prayers. Mortals have no model, and their petitions are built from their state.
- No omens or director events that gods simply know about.

---

## Key Decisions

- **Petitions come from each mortal's real situation, not from a table.** Every petition has a recorded cause, so the owner can trace a god's action back to a mortal's loss.
- **The world judges whether a petition was answered, and worship follows.** A god's divinity comes to depend on mortals (D10). Answering takes real actions, so moves gain a motive.
- **A new bless action that grants materials instead of repairing.** Without it, help petitions could only be answered with words. Because it grants materials, the mortal still has to rebuild, so destruction keeps its consequences and recovery still costs resources (D08, W08).
- **Petitions say where things are, and the prompt shows the way.** A god on Olympus can then answer a mortal in town. This is map knowledge, not event knowledge, so W04 holds. The god must still travel and see the building before it can strike.
- **A petitioner learns of an answer through a sign.** The sign is a recorded divine act, so worship never changes on news the mortal has no way to know (W04).
- **Unmet needs become events.** A prayer about a failed trade or an empty larder can then cite a real cause. The cost is a new event that routines emit.
- **The director never tells the gods anything.** Gods learn of director trouble through petitions or through what they themselves perceive. This keeps W04: a god never learns about the world except by perception, telling, or its divine sense of prayers addressed to it.
- **The world enforces goal persistence and adds no model calls.** This targets the two measured failures: goals reset unchanged, and goals dropped after one action. The world still never judges whether a goal succeeded. The gate counts world ticks and records refusals, so replay reproduces it. A new petition unlocks a goal change, so a god committed to the other god can still turn to a prayer.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R9, R10, R11][Technical] The answer window, the worship and favor amounts, the sign's timing, and the bless cost and the material amounts. All are strictly parsed tunables in `content/greek/world/rules.json`.
- [Affects R13][Technical] How long the quiet window is, and what counts as consequential.
- [Affects R16][Technical] The value of N, and what counts as "something new involving the target".
- [Affects R5][Technical] How praying fits into routine selection without starving production, and how often a mortal may pray.
- [Affects R1, R2][Technical] How long a cause stays prayable.
- [Affects R8][Technical] How the route toward a place is computed and shown, given that the god only ever sees its current exits.

---

## Sources / Research

- Gate 2 evidence and goal-pursuit measurements: `tools/scenarios/m2-greek-cast/episodes/2026-10-01T15-37-30/`, `tools/scenarios/m2-greek-cast/episodes/2026-10-01T15-52-36/`
- Previous replan: docs/brainstorms/2026-10-01-god-goals-requirements.md, docs/plans/2026-10-01-001-feat-god-goals-plan.md
- Content change: the woodcutter gets a woodshed in `content/greek/world/buildings.json`, so a theft by the woodcutter can be punished.
- Starting world: `content/greek/world/inhabitants.json`, `content/greek/world/locations.json` (Hall of the Gods, altar), `content/greek/world/buildings.json`, `content/greek/world/rules.json` (worship and favor tunables)
- Mortal routines: `packages/world/src/routines.ts`; worship: `packages/world/src/worship.ts`; perception: `packages/world/src/perception.ts`
- Quiet-world director: M2 plan Unit 12 in docs/plans/2026-09-29-001-feat-m2-autonomous-greek-cast-plan.md
- Requirements touched: W04, W05, W07, W10, O04, O08 in docs/product/requirements.md; D08 and D10 in docs/product/decisions.md
- External research: Odyssey (8B planner–actor–critic, arxiv 2407.15325), goal drift (arxiv 2505.02709), and the action contracts in NVIDIA ACE and Convai
