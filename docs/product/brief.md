# Panthea product brief

Status: Ready for implementation planning after nine interview rounds.
The owner accepted the MVP boundary and delegated tunable defaults in round nine.
Technical feasibility remains subject to explicit probes, not assumed performance.

## Purpose and audience

Panthea is a local-first mythological world that its owner can observe, inhabit, influence, and study.
Autonomous gods and ordinary inhabitants create relationships, conflict, legends, and lasting changes.
The central experience is a living microcosm with interesting characters, including direct conversation with gods.

The owner is the primary audience.
An open-source audience is second, with opportunities to extend the world and explore new stories between traditions.
This is a personal portfolio project with no commercial intent.
The project uses MIT licensing.

## Experience

A live simulation runs beneath the title screen.
The first ten minutes introduce gods, offer observation or mortal entry, and teach movement, conversation, and realm travel.
An observer can follow a god, inspect its history and imperatives, and switch between places.
A player creates a mortal, travels, speaks, trades, seeks favor, and experiences consequences.

Gods act on personal motives within authoritative game rules.
Zeus can strike a tree, ignite a building, disrupt trade, and create grievances that outlast the visual effect.
Other characters can respond, recover, exploit the damage, or memorialize it.
Conversation does not freeze the world.

Universe is a separate operator role with full local authority.
It combines visual controls, commands, and natural language for interventions and scheduled events.
All interventions enter the world history.

## Accepted MVP

The desktop MVP includes these capabilities:

- Seven Greek gods: Zeus, Hera, Athena, Hermes, Hephaestus, Poseidon, and Hades.
- A mortal town with nearby wilderness, compact Olympus, and a playable Underworld.
- Autonomous motives, memory, relationships, deception, and limited character knowledge.
- NPC production and trade, money, worship, legends, shortages, destruction, and resource-based recovery.
- Mortal creation, free-form dialogue, contextual actions, artifacts, patronage, and asynchronous turn-based conflict.
- Death, playable afterlife, return to living realms, and absent-player vulnerability.
- Universe intervention, history, scheduling, and recovery tools.
- Validated generated behaviors and realm-adapted creations that activate autonomously.
- Offline visual creation through procedural combinations and local image generation, plus optional hosted image generation.
- Autosave, snapshots, portable backups, and recorded-event playback.
- Local inspection and configurable export to Langfuse or OpenTelemetry tooling.

## Visual and content direction

Use polished original pixel art with an isometric world, expressive JRPG portraits, and full-screen divine effects.
AI-generated assets are acceptable.
Cutscenes are skippable while simulation continues.
Sound effects and selective ambient music support the world.

Research myths and document variants for an educational dimension.
Characters retain recognizable core drives while remaining free to invent and evolve.
The intended tone includes humor, violence, tragedy, and mature themes despite the approachable graphics.
The project makes no political statement or position for or against modern religion.

## Local-first delivery

Use a Bun-managed workspace and a Tauri desktop shell.
The requested renderer is WebGPU with Three.js and Three Flatland.
The backend, UI framework, database, exact models, and optional Lua runtime remain research choices.

The baseline is an M1 Pro MacBook Pro with 16 GB of memory.
The larger target is an M4 Pro MacBook Pro with 48 GB.
Linux and Windows are targets when the selected stack supports them.
First-run downloads are acceptable, followed by fully offline operation without accounts or hosted dependencies.

Models are assigned by character or agent role and can mix local and hosted providers.
Requested hosted options include OpenCode Go, OpenAI, and Anthropic, subject to supported authentication and capability probes.
Fallback is mandatory and stays within configured providers.

2026-09-29 clarification (owner): providers are any OpenAI-compatible endpoint; the named hosted options are examples, all peers of local models, usable for any role and in any configured fallback order ([ADR-0005](../decisions/0005-model-providers.md)).
Continuous character activity takes priority over new artwork.

## Success and exclusions

The MVP succeeds when watching is entertaining, participation matters, consequences persist, and behavior can be inspected for experiments.
Relationships, story variety, and responses to fortune or misfortune are the research priorities.
A clunky, nearly motionless, or uneventful experience fails even if its components technically work.

Post-MVP work includes browser delivery, hosted multiplayer at panthe.ai, other pantheons, in-app content editors, voices, spending limits, video export, YouTube publishing, and batch experiments.
Norse, Yoruba, Roman, and tentatively Akan content remain part of the longer-term direction.
Zeus versus Thor and Odin versus Mars are desired future encounters.

## Planning authority

The owner selected OpenCode with Systematic workflows for implementation.
Budget and deadline are unspecified.
[Requirements](requirements.md) define release obligations, and [defaults](defaults.md) distinguish delegated choices from fixed product direction.
[The roadmap](mvp-roadmap.md) sequences delivery and the required feasibility probes.
