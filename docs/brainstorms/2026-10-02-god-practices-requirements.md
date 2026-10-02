---
date: 2026-10-02
topic: god-practices
---

# Gods Who Bargain, Commit, and Live With It

## Summary

Gods act through three Greek social practices: supplication, demand and settlement, and a contest for mortals' favour. The world records what each practice asks, offers, and answers, and ends it in an outcome drawn from sourced myth motifs. The outcome changes the world, and the topic stays closed until something new happens. The five remaining gods arrive with stakes in these practices. Twenty routine-driven inhabitants supply the needs, losses, and worship the gods contend over. A fair scheduler shares one model among all seven gods.

---

## Problem Frame

The gate 3 rerun on qwen3 8B passed its automated checks, and the owner rated it continue. The episodes still repeat. Zeus and Hera argued over his affairs, his secrecy, and her response. Each set a goal such as "resolve this" or "understand her", then never acted on it, and the next exchange returned to the same topic (`tools/scenarios/m2-greek-cast/episodes/2026-10-02T14-29-04/`).

Nothing the gods say binds them:

- A goal is a private declaration the world never judges (`packages/world/src/goals.ts`).
- No offer, refusal, or promise between gods is recorded, so no exchange can conclude.
- Affinity, grudge, and alliance move with remembered claims, not with agreements kept or broken.

The god-goals brainstorm decided that "conversations end through goals, not rules", with scene mechanics to follow only if loops persisted (`docs/brainstorms/2026-10-01-god-goals-requirements.md`). They persisted.

The world is also thin. It has two mortals, four buildings, and five resources, so there is little for a god to contend over. No sourced material exists for Athena, Hermes, Hephaestus, Poseidon, or Hades.

The owner's discovery record asks for fully autonomous characters and names repetitive conversations as a failure (`docs/discovery/session.md`, `docs/discovery/interview.md`). M05 requires conflict with valid resolution paths, and W04 requires remembered outcomes to change later behavior.

External research agrees on the cause. LLM agents with memory, reflection, and planning still loop (Generative Agents, Project Sid). The levers with evidence are state the world holds: practices with roles and endings (Versu), schemes with progress and outcomes (Crusader Kings III), and commitments judged against the event log (Concordia's game master boundary).

---

## Actors

- A1. Gods: the seven Olympians, each a model-driven character with a sourced profile, standing aims, and rivalries.
- A2. Inhabitants: twenty mortals driven by routines and drives, with no model.
- A3. Director: the world's provider-independent source of pressure.
- A4. Owner: watches episodes and rates the experience gate.

---

## Key Flows

- F1. Settlement between gods
  - **Trigger:** Hera learns of something Zeus did, by seeing it or by a report.
  - **Actors:** A1
  - **Steps:** Hera demands a concession from Zeus, drawn from the terms the world can check, with a deadline. Zeus accepts, counters within the budget, or refuses. On acceptance they may swear it as an oath. The obligation leads Zeus's prompt until he performs it or the deadline passes.
  - **Outcome:** The thread ends as fulfilled, refused, withdrawn, expired, or breached. The relationship and the world change to match. Hera's next turns do not reopen the demand without a new cause.
  - **Covered by:** R1–R13, R15
- F2. Supplication
  - **Trigger:** A mortal suffers a loss it knows of.
  - **Actors:** A2, A1
  - **Steps:** The mortal supplicates a god at the altar. The god performs help, offers terms, refuses, or lets it lapse. If the god offered terms, the mortal's routine accepts or declines them, and an accepting mortal must perform its part by the deadline.
  - **Outcome:** The mortal's need, worship, and memory of the god change. The thread is closed.
  - **Covered by:** R5–R8, R14, R21
- F3. Contest for favour
  - **Trigger:** Two gods with a standing rivalry both claim a place's people.
  - **Actors:** A1, A2
  - **Steps:** Each god performs observable services there over a window. Each mortal there weighs what it experienced. The contest closes.
  - **Outcome:** Each god's standing there changes and stays changed. The mortals' worship, and whom they supplicate, shift toward the god they favour.
  - **Covered by:** R16, R17, R20, R21
- F4. Breach
  - **Trigger:** An accepted obligation passes its deadline unperformed.
  - **Actors:** A1, A2
  - **Steps:** The world records the breach and applies the consequence the terms or the practice named.
  - **Outcome:** The breaker suffers a sourced motif consequence, such as transformation or lost standing. The wronged party may open a successor thread that cites the breach.
  - **Covered by:** R7, R9, R17, R18

---

## Requirements

**Practices**
- R1. Gods act through three practices: supplication, demand and settlement, and contest for favour. Each practice instance is a thread with participants, a cause, and a state the world holds.
- R2. A thread opens only on a cause its opener knows: an event it perceived, a report it was told, or a need or loss. A god's standing aims decide which causes it pursues, but an aim never opens a thread by itself. An allegation opens a dispute but never establishes guilt.
- R3. Each participant sees its role, the cause as it knows it, the outstanding proposal, its obligations, and its legal responses. Private motives and others' unobserved evidence stay private.
- R4. Every decision prompt carries a short digest of each thread that needs this god: its cause, the last answered move, the legal responses, the deadline, and any no-progress reason.
- R5. A move changes a thread's state: request, offer, counteroffer, accept, refuse, perform, or withdraw. Only moves bind. Words explain a move and never perform it.
- R6. Terms come from a closed set of performances the world can check, such as being at a place, blessing a mortal, giving a resource, telling a legend to an audience, or staying away from a place. Each term names the parties and a deadline. No one may promise another character's cooperation, acceptance needs the obligated party's assent, and a term its party has no way to perform by the deadline cannot be offered.
- R7. A thread ends as fulfilled, refused, withdrawn, expired, or breached. Fulfilled means the world observed the performance, so acceptance alone is not fulfilment.
- R8. Every ending records what changed, whether resources, services, worship, standing, obligations, form, access, or relationships. The change outlasts the thread.
- R9. A closed thread stays closed. Only new evidence, a materially changed offer, or a later breach opens a successor, and the successor links to it. Amended 2026-10-02 (owner): a successor needs a cause the demander learned after the closed thread opened, such as new evidence or a later breach. A changed offer alone does not reopen a closed thread, because rotating terms after each refusal would bring the loop back. Offers still change freely through counteroffers while a thread is open.
- R10. Three kinds of move make no progress: repeating an answered move with unchanged terms and no new evidence, a counteroffer that does not materially change the terms, and a report or legend between a thread's participants on its topic while it is open. The god's next prompt says so, and it chooses another tactic, an escalation, a withdrawal, or a wait for a named event or deadline.
- R11. A negotiation has a deadline and a counteroffer budget. When either runs out without acceptance, the thread ends as refused or expired.
- R12. An accepted obligation leads the obligated god's prompt until its deadline. Each turn the god performs it, renegotiates, waits for a named event, or knowingly risks breach, and the transcript records which.
- R13. Private goals remain motives. They never certify a shared commitment or close a thread.

**The three practices**
- R14. In supplication, a mortal asks a god for help or redress for a loss it knows of. The god may perform, refuse, offer terms, or let it lapse. The mortal's routine accepts or declines offered terms, and a mortal that accepts and does not perform its part by the deadline has breached. Supplication replaces today's petitions and keeps their recorded causes, divine hearing, and world-judged answers.
- R15. In demand and settlement, one god demands a concession from another, who accepts, counters, refuses, or lets it expire. An accepted settlement may be sworn as a Styx oath, which raises the cost of a breach.
- R16. In a contest for favour, gods with a rivalry claim a place's people and perform observable services there over a window. The mortals there weigh what they experienced. The contest records each god's lasting standing there and shifts the mortals' worship, and whom they supplicate, toward the god they favour. The loser's standing stays down until a new cause opens a new contest.

**Outcomes**
- R17. Endings draw on sourced Greek motifs: boon, compensation, standing won or lost, curse, transformation as punishment or mercy, and a bounded penalty for a broken oath. Each motif cites sources, notes variants, and labels late Roman versions and game inventions.
- R18. Transformation changes form and capabilities, records its cause, and keeps the target's identity and memory (W09).
- R19. Affinity and grudge stay feelings. An alliance exists only when two gods seal one through a settlement.

**Cast and world**
- R20. Athena, Hermes, Hephaestus, Poseidon, and Hades get sourced profiles with standing aims and rivalries that lead them into practices. The world gains the places and livelihoods that give each of them something at stake.
- R21. Twenty inhabitants produce, trade, own, worship, suffer losses, supplicate, and keep or break supplication terms through routines, with no model. Each remembers how each god treated it, and their choices decide contests.
- R22. The director applies attributed pressure to open threads. It never chooses a god's response, guarantees an ending, or undoes a consequence, and it behaves the same whether or not a provider is available.
- R23. Seven gods share one model fairly, one inference at a time. Inference goes to practice decisions, not to routine travel.

**Evidence**
- R24. Transcripts show each thread's cause, participants, moves, ending, and recorded changes. They also show open threads with their age and what each waits on, and every move judged no progress.
- R25. The next experience gate runs 3 fresh 5-minute Zeus and Hera episodes on qwen3 8B at 4K with reasoning off. All seven gods are judged at Unit 13.

---

## Acceptance Examples

- AE1. **Covers R2, R5, R7, R9.** Hera hears from a mortal's report that Zeus visited a nymph. She demands that Zeus tell a legend honouring her to the mortals at the altar before the deadline. Zeus refuses. The thread ends refused, her affinity toward him falls, and her next turns do not repeat the demand. When Zeus is later seen with the nymph again, Hera may open a successor that cites the new sighting.
- AE2. **Covers R6, R7, R15, R17.** Zeus accepts Hera's demand and swears it by the Styx. The deadline passes with no such legend told at the altar. The thread ends breached, and Zeus suffers the bounded oath penalty.
- AE3. **Covers R7, R12.** Zeus accepts but has not yet performed. Until the deadline, the obligation leads his prompt each turn, the thread stays open as accepted, and it never counts as fulfilled.
- AE4. **Covers R10.** Hera demands the same concession on the same terms after Zeus refused it, with nothing new learned. The move makes no progress, and her next prompt says it was already answered.
- AE5. **Covers R10, R11.** Zeus counters Hera's demand, then counters again with the same terms reworded. The second counter makes no progress. Hera counters once more, the counteroffer budget runs out without acceptance, and the thread ends refused.
- AE6. **Covers R10.** While Hera's demand is open, Zeus tells her a report about the nymph instead of answering. The report records nothing in the thread and counts as no progress.
- AE7. **Covers R2, R9.** Hera's demand ended fulfilled. Her standing aim of honour alone does not let her open a new demand about the same affair. A new sighting would.
- AE8. **Covers R14.** A fisherman's catch spoils, and he supplicates Poseidon. Poseidon offers calm seas in return for an offering. The fisherman's routine accepts and makes the offering. Poseidon grants the boon, and the thread ends fulfilled.
- AE9. **Covers R14, R18.** A mortal supplicates Hermes, accepts his terms of an offering after the boon, receives the boon, and makes no offering by the deadline. The thread ends breached. Hermes turns him into a beast. He keeps his memories and relationships, and the record shows the terms, the breach, and the transformation.
- AE10. **Covers R16, R21.** Athena and Poseidon both claim the town square's people. Over the window, Athena's blessings reach five mortals there and Poseidon's reach two. Athena's standing there rises, Poseidon's falls, and those mortals worship and supplicate Athena more often.
- AE11. **Covers R19.** Zeus and Hera reach affinity 6 through kind reports. No alliance exists until they seal one through a settlement.
- AE12. **Covers R22.** A contest has run quietly for its whole window. The director sends a storm that spoils the fishermen's catch, attributed to the director. Each god still decides for itself whether to act.

---

## Success Criteria

- In the next gate, Zeus and Hera each cause at least one thread ending with a persistent consequence in every episode.
- The run includes a supplication and a settlement, at least one of them refused or breached.
- No thread reopens without a new cause.
- No move judged no progress advances a thread.
- A recorded consequence changes a later choice.
- The owner rates the episodes on identity, surprise, intelligible causality, pacing, and whether the arguments go somewhere, and decides to continue.
- A planner can build this without inventing practice moves, endings, reopening rules, the no-progress rule, or how contests change standing. Deadlines, budgets, windows, and penalty sizes are tunables, and the exact list of terms is planning detail.

---

## Scope Boundaries

### Deferred for later

- Player participation in practices and patronage of the player: M3.
- A formal patron role that routes a place's worship and supplications to one god: with changeable patronage (M04).
- Death, judgment of the dead, and the afterlife as playable systems: M3 (M06).
- The full Hesiodic Styx penalty and divine banishment: M3 (M08).
- Oaths sworn by mortals. Mortals bind themselves only by accepting supplication terms.
- Hospitality as its own practice. Hosting appears in mortal routines only.
- Generated visual effects for outcomes: M4.

### Outside this product's identity

- A model game master that narrates or decides outcomes. The rules engine stays authoritative.
- Scripted myth plots. Motifs are possible endings, not storylines.

---

## Key Decisions

- **Practices over smarter prompting.** Planning and reflection did not stop loops in prior systems. Recorded offers, answers, and endings did.
- **Three practices cover the seven gods.** Shared practices make gods meet and collide. Quarrel, bargain, and oath fold into settlement, and hospitality stays in routines.
- **The loop is closed inside the practice too.** Terms the world can check, a counteroffer budget, aims that never open threads, promises that lead the prompt, and off-thread talk that counts for nothing each block a way the old loop could return.
- **Motifs are sourced endings, not plots.** Each motif carries citations and variants, and Ovid's versions are labeled late.
- **Inhabitants stay rule-driven.** Twenty more model agents does not fit one inference at a time. Their remembered treatment makes their worship meaningful.
- **Contests change standing, not patronage.** Standing and worship shift for good, and the formal patron role waits for M04.
- **Mortals breach supplication terms, not oaths.** Transformation as punishment needs no mortal oath machinery.
- **Alliances require a commitment.** This supersedes the rule that equates affinity at or above the alliance threshold with an alliance.
- **Practices supersede "conversations end through goals".** Goals stay as private motives. Petitions become supplication.
- **The oath penalty is bounded in M2.** It uses capabilities that already exist, such as divinity, access, and standing. Banishment waits for M08.
- **The first slice is Zeus and Hera.** Their quarrel is the failure the owner observed, and fixing it proves the mechanism before five more gods depend on it.

---

## Dependencies / Assumptions

- PR #95 (petition privacy check) and PR #96 (gate 3 evidence, qwen3 8B as baseline) land first.
- Gods still choose one structured action per turn through validated APIs. Practice moves are new action kinds, not free text.
- The superseded decisions get dated notes in the god-goals and god-petitions documents and in the M2 plan, rather than being erased.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R6][Technical] The exact list of checkable terms and the world actions that satisfy each.
- [Affects R6, R11, R16][Technical] Deadlines, the counteroffer budget, contest windows, and how mortals weigh services, as tunables in `content/greek/world/rules.json`.
- [Affects R9, R10][Technical] What counts as a materially changed offer or new evidence.
- [Affects R15, R17][Technical] The bounded oath penalty and the stake each motif carries.
- [Affects R20][Needs research] The minimal places, buildings, and livelihoods each new god needs, such as a harbor and a forge, and each god's profile sources.
- [Affects R23][Technical] How the scheduler orders practice decisions, and how a god travels without a model call.
- [Affects R4][Technical] How the thread digest fits within 4K context when several threads are open.
- [Affects R5, R14][Technical] How today's bless, report, legend, and goal actions map onto practice moves.

---

## Sources / Research

- Gate evidence: `tools/scenarios/m2-greek-cast/episodes/2026-10-02T14-29-04/` (rated continue, with repetition the owner traced to unresolved topics)
- Prior replans: docs/brainstorms/2026-10-01-god-goals-requirements.md, docs/brainstorms/2026-10-01-god-petitions-requirements.md
- Plan units absorbed: Units 9, 10, and 11 of docs/plans/2026-09-29-001-feat-m2-autonomous-greek-cast-plan.md
- Requirements touched: W01, W04, W06, W07, W09, W10, M05, O08 in docs/product/requirements.md; D04–D10 in docs/product/decisions.md; rubric in docs/product/acceptance.md
- Agent architectures: Generative Agents (arxiv 2304.03442), Project Sid (arxiv 2411.00114), Lyfe Agents (arxiv 2310.02172), Concordia (arxiv 2312.03664)
- Narrative structure: Versu (Evans and Short), Façade beats (Mateas and Stern), storylets (Emily Short), Crusader Kings III schemes, Wildermyth events
- Greek practices and motifs: Iliad 1, 14, 24; Odyssey 7, 9; Hesiod, Theogony (Styx oath); Homeric Hymns to Demeter, Hermes, Hera, and Hephaestus; Apollodorus 1.5, 1.9, 2.1, 3.5, 3.14; Pausanias 2.15.4; Ovid, Metamorphoses 6 (late); Plato, Gorgias 523a–524a
