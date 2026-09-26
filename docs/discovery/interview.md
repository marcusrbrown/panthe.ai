# Product interview

Status: All nine rounds recorded. Product discovery is complete for implementation planning.
Each round records owner answers, resulting decisions, and remaining questions.
An unanswered question is not consent to a proposed default.

## Round one: Purpose and constraints

The assistant asked these questions on 2026-09-25:

1. Who is Panthea for first: you personally, a public open-source audience, players, creators, or simulation researchers? Rank the top two audiences. Describe what makes them return. Is this a hobby, portfolio project, research tool, or eventual commercial product?
2. Describe your ideal first 10 minutes and one remarkable event after an unattended hour. What do you see? What do the gods do beyond talking? How can you intervene? Which single experience must the MVP prove? What makes it a failure?
3. What hardware and delivery format must the first version support? Include your primary machine, RAM, GPU, and operating systems. Specify browser or desktop delivery, acceptable one-time downloads, and any deadline or development budget.

The product brief incorporates the resulting direction.

Confirmed decisions and requirements:

- Prioritize the owner, then a public open-source audience.
- Treat Panthea as a personal portfolio project without commercial intent.
- Open with a live simulation beneath the title screen, character introductions, realm selection, and a short tutorial.
- Support player entry, human NPC additions, god observation, and interactions initiated by gods or rules.
- Give gods recognizable abilities that affect other characters and the environment.
- Include humans, animals, and non-human humanoids in the intended world population.
- Provide the Universe console for authorized operator intervention.
- Prove entertainment during unattended operation and meaningful human participation.
- Provide metrics for tuning and simulation experiments.
- Target the M1 Pro with 16 GB as the baseline and scale to an M4 Pro with 48 GB.
- Support browser and desktop delivery, configurable local models, and hosted provider access with user credentials.
- Distribute through the website or GitHub Releases.

Unresolved follow-ups from round one:

- Define measurable activity, responsiveness, and entertainment criteria.
- Specify an unattended-hour event and its lasting consequences.
- Select MVP counts, roster, realms, and delivery sequence.
- Clarify provider choices and the meaning of retail-provider OAuth access.
- Determine permissions for Universe and the ordinary player's authority.
- Define required metrics, experiment controls, and data retention.
- Resolve one-time download limits, supported operating systems, budget, and deadline.

## Round two: Cast, consequences, and player authority

The assistant asked these questions after recording round one:

1. Which gods and realms are essential to the smallest version worth showing? How many gods and ordinary inhabitants must be active together? Must all four requested traditions appear in the MVP? Does Anansi add Akan traditions to the roster? Name a desired cross-pantheon encounter.
2. What motivates Zeus to attack in the thunderstorm example? What can he destroy, how do others respond, and what remains changed? Specify MVP needs for injury, death, rebuilding, grudges, alliances, and shortages. Can an unseen story director trigger events during quiet periods?
3. Does the player enter as a vulnerable mortal, a custom being with powers, an existing god, or a choice? Define ordinary controls and actions, departure behavior, and death behavior. Is Universe a separate operator mode available to the local owner by default, or a permission granted or earned?

The product brief incorporates these answers.

Confirmed direction:

- Build toward roughly seven recognizable gods each from Greek, Norse, and Yoruba traditions.
- Permit a Greek-first MVP with varied powers and support later pantheon additions.
- Start gods in their classic environments and enable interactions across traditions.
- Prioritize death, transformation, grudges, alliances, and shortages, with injury and rebuilding also requested.
- Allow an unseen director to initiate world events.
- Expose character motives in their own voice with deeper game-state inspection available.
- Vary divine power with the current realm.
- Let the player create a mortal, travel, converse, buy, sell, and use artifacts.
- Preserve characters and send deceased players to an afterlife.
- Keep Universe separate from characters in the world.

Open details include exact roster, active population, afterlife precedence, persistent-character behavior, and mechanic depth.
Akan inclusion is tentative.
Roman rollout remains open, with Mars explicitly named in a desired encounter.

## Round three: World continuity and local performance

The next questions cover these unresolved decisions:

1. Does the Greek MVP need distinct Olympus, mortal settlement, and Underworld maps? How does travel work, and what happens offscreen?
2. What does alignment mean, which rule wins when an alignment and killer imply different afterlives, and what can dead characters do? How do player absence, NPC death, and god death work?
3. What activity must the M1 Pro sustain? Define population, character individuality, response delays, routine behavior between model decisions, and unattended runtime.

The product brief incorporates these answers.

Confirmed direction:

- Connect maps through teleports with prepared transitions.
- Separate observer view switching from in-world player travel.
- Keep human-populated landscapes continuous for walking and faster travel.
- Apply travel limits to gods and allow gods to transport mortals.
- Continue at least minimal offscreen simulation.
- Allow optional, changeable patronage that other gods perceive.
- Give the spawn realm the largest influence on which gods decide a mortal's fate.
- Make afterlives playable with a path back to living realms.
- Apply mortal death rules equally to NPCs and player characters.
- Permit absent player characters to die.
- Preserve character capabilities for background inhabitants while allowing simpler prompts and routines.
- Continue movement asynchronously and allow interruptions during conversations.
- Combine continuous operation with catch-up simulation.

Unresolved: Divine death, fate precedence, absent-character control, specific map scope, catch-up limits, population, and response latency.
The proposed seven gods and 15–25 inhabitants are provisional, not a committed capacity target.

## Round four: Agent rules, time, and deployment

The next questions cover these unresolved decisions:

1. What do characters know and remember, and can dialogue invent powers or alter world facts? Can stable game rules enforce actions while model decisions choose intent and speech?
2. What happens when the interface closes, the machine sleeps, or the player returns after days? What time controls and limits constrain catch-up and unattended catastrophe?
3. Which local runtimes and hosted providers matter first? Where does a hosted user's simulation run, is multiplayer required, and what setup burden is acceptable?

The product brief incorporates these answers.

Confirmed direction:

- Limit character knowledge to observations and explicit divine abilities.
- Allow deception, errors, forgetting, lasting relationships, and unrestricted creative goals.
- Make the game authoritative over executable actions and world facts.
- Allow a local background process to continue running.
- Preserve destructive outcomes and allow Universe to recover or terraform areas.
- Offer voluntary permanent death for a stuck player character.
- Accept external local model servers or direct model access, with Ollama as the owner's familiar runtime.
- Configure models by agent role and permit mixtures of local and hosted models.
- Investigate OpenCode Go, OpenAI, and Anthropic as requested hosted options.
- Focus the MVP on desktop and defer browser delivery and hosted multiplayer.

Unresolved: Catch-up limits, time controls, novel-action execution, permanent-death behavior, provider authorization support, and packaging.
The owner did not select exact models or confirm any provider's subscription compatibility.

## Round five: Mythology and presentation

The next questions cover these unresolved decisions:

1. Which Greek gods form the starter cast, what anchors their personalities, and what tone or content boundaries apply?
2. What visual quality, asset sources, music, voices, and cutscene behavior belong in the MVP?
3. How do movement, dialogue, observation, character inspection, and accessibility controls work?

The brief, content direction, and UX direction incorporate these answers.

Confirmed direction:

- Use Zeus, Hera, Athena, Hermes, Hephaestus, Poseidon, and Hades as the starter cast.
- Ground characters in researched myths with documented variants and an educational aspect.
- Preserve violent, tragic, funny, and mature themes despite the approachable visual style.
- Make no political statement or position for or against modern religion.
- Use polished original pixel art, with AI generation acceptable.
- Combine an isometric world with expressive JRPG portraits and simpler sprites.
- Show persistent environmental consequences after divine effects.
- Keep cutscenes skippable while simulation continues.
- Include sound effects and selective ambient music.
- Support keyboard, joypad, and contextual pointer controls.
- Expose speech, past activity, and current imperatives to observers.
- Respect accessibility preferences such as reduced motion.

Open details include asset budget, exact input mapping, dialogue input, source selection, and accessibility acceptance criteria.
Spoken voices remain undecided. Inspection detection is a tentative divine ability.

## Round six: Universe, experiments, and saved worlds

The next questions cover these unresolved decisions:

1. How does Universe expose edits, permission, commands, and event scheduling?
2. Which questions must experiments answer, and which metrics and export controls support them?
3. How do saves, world copies, history, import/export, and content authoring work?

The brief and operations document incorporate these answers.

Confirmed direction:

- Combine visual controls, commands, and natural-language interaction in Universe.
- Give the local owner full authority and record operator changes in history.
- Support character relocation, base-prompt edits, and scheduled regional disasters or beast appearances.
- Include telemetry across the experience, simulation, and asset generation.
- Provide Langfuse and OpenTelemetry integration and MVP inspection tools.
- Focus research on relationships, story variety, and responses to fortune or misfortune.
- Support autosave, snapshots, and world backup/restore through import/export.
- Treat replay as playback of recorded events.
- Accept documented files and code for MVP content authoring, with in-app tools later.

Video export and direct YouTube delivery are desired, but their MVP status remains unresolved.
Preview, undo, exact metrics, retention, simultaneous worlds, experiment batches, and deployment of telemetry tools remain open.

## Round seven: Executable mechanics

The next questions cover these unresolved decisions:

1. How do combat, powers, player survival, and divine defeat work?
2. Which needs, resources, commerce, destruction, and rebuilding mechanics establish the MVP economy?
3. How do novel intentions become executable actions, what can transform, and which character traits persist through change?

The brief and simulation direction incorporate these answers.
The question tool was reissued after network interruptions at the owner's request.

Confirmed direction:

- Use asynchronous turn-based conflict with timing influenced by ability and input.
- Let mortals fight, flee, persuade, and call or summon help, with hiding enabled by items or powers.
- Give gods power costs and cooldowns, with banishment or recovery after defeat.
- Build an economy around money, worship, legends, and autonomous character activity.
- Make building damage affect use, income, customers, and inventory.
- Allow resource-based recovery through gods, players, or NPCs.
- Support generated executable behaviors absorbed by Universe and adapted across realms.
- Permit transformative effects on appearance, species, perception, minds, and relationships.
- Preserve recognizable divine core drives.

The exact generated-behavior execution boundary requires another question.
Lesser deity creation and character reset events remain tentative.

## Round eight: Execution and technical boundaries

The next questions cover these unresolved decisions:

1. What execution authority do generated behaviors receive, and how does Universe admit or reject them?
2. Where do telemetry tools run, and what collection, export, retention, and provider-cost policies apply?
3. What technical, packaging, license, budget, and coding-harness constraints govern the handoff?

The technical constraints and other product documents incorporate these answers.

Confirmed direction:

- Restrict generated execution to validated game APIs without host filesystem, shell, credential, or network access.
- Activate valid generated behaviors autonomously under Universe management.
- Consider Lua for complex behaviors and support local-only visual asset generation.
- Keep local inspection available and export telemetry to a configured hosted endpoint.
- Make privacy and retention operator-configurable.
- Require provider fallback and defer spending enforcement.
- Use Tauri, WebGPU, Three.js, and Three Flatland.
- Research the backend and probe models before selecting defaults.
- Target macOS, plus Linux and Windows when supported.
- Allow first-run model downloads and setup.
- Use MIT licensing and hand off to OpenCode with Systematic workflows.

The assistant explained why budget and deadline were asked. Neither has a supplied constraint.
Lua remains a candidate, not a fixed implementation choice.
The assistant confirmed that local-only asset generation means generation without a hosted service during play.

## Round nine: Scope and implementation defaults

The next questions cover these unresolved decisions:

1. Which maps and release gates define the first complete desktop MVP, and which features can follow later?
2. What generation delays and visual fallback are acceptable on the baseline machine?
3. Can the handoff set explicit defaults for time, absent characters, dialogue, fate, preservation, and fallback, subject to later tuning?

The owner accepted the proposed MVP boundary, deferred local video export, accepted asynchronous visual creation, and authorized tunable defaults and technical probes.

Final scope includes seven Greek gods, town/wilderness, Olympus, Underworld, autonomous economy, mortal play, Universe, generated behavior/art, persistence, playback, and inspection.
Browser multiplayer, additional pantheons, editors, voices, spending limits, video publishing/export, and batch runners are post-MVP.

The implementing agent can resolve numerical parameters and engineering choices through the documented defaults and probes.
No additional owner interview is required to start implementation planning.
Consequential scope changes still require an explicit decision.

## Interview interaction preference

The owner reports that later assistant output hides the question controls.
Ask each round through the question tool after completing document updates and commentary.
Wait for the owner's tool response before sending more output or a final reply.
Do not replace the pending question with a final message that refers to questions above.

## Topic inventory used during discovery

This inventory guided the completed interview.
Later answers and accepted defaults resolve the implementation scope.
Post-MVP design and technical probes remain in the open-decisions document.

| Topic | Questions to resolve |
| --- | --- |
| Product identity | Naming, audience priority, tone, commercial intent, license, desired scope |
| Simulation | Goals, needs, routines, actions, consequences, resources, conflict, world changes, death and recovery |
| Agent knowledge | Perception, private knowledge, memory, forgetting, beliefs, relationships, personality drift, lore accuracy |
| Autonomy | Agent initiative, scripted rules, narrative direction, safety limits, stalled behavior, repetitive conversations |
| Player role | Avatar origin, control, dialogue, powers, possessions, joining, leaving, intervention, win or loss conditions |
| Mythology | MVP roster, all four traditions versus staged delivery, sources, variants, Greek/Roman identity, Yoruba portrayal, content boundaries |
| Realms | Geography, portals, access rules, travel, simultaneous simulation, realm ownership, persistent environmental changes |
| Time | Pause, speed, background operation, closed-window operation, machine sleep, catch-up, unattended duration |
| Local models | Runtime, endpoints, exact models, context limits, concurrent agents, latency, failure behavior, optional cloud use |
| Data | Save slots, autosave, export, import, history, replay, branching, migrations, retention, disk limits |
| Presentation | Camera, movement, pixel scale, screen layout, effects, cutscene triggers, interruption, skipping, sound, music, voice |
| Accessibility | Readable text, keyboard, touch, controller, motion reduction, flashes, color, screen reader scope |
| Responsive UX | Desktop and phone roles, supported screen sizes, busy states, offline setup, errors, recovery, discoverability |
| Tools | Content authoring, character editor, map editor, lore packs, debugging, evaluation, command-line use, mod support |
| Networking | Single user, local network, multiplayer, accounts, connectivity boundaries, telemetry |
| Assets | Original art, generated art, placeholders, licensed packs, consistency, ownership, production budget |
| Technical boundaries | Required libraries, prohibited services, Bun runtime versus package management, packaging, installation, upgrades |
| Release scope | Must-have features, explicit exclusions, milestones, measurable acceptance, performance targets, test hardware |
| Handoff | Target coding harness, instruction format, work item format, execution autonomy, review expectations |
