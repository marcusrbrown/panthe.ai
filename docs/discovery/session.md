# Session record

## Original owner request

Recorded on 2026-09-25. The following text preserves the owner's request.

> I want to build an interactive AI agent "town" simulator akin to AI Town (https://github.com/a16z-infra/ai-town) and SimTown (https://github.com/simtownai/simtown), with these (loose) goals
>
> - App can run completely offline using local LLMs (e.g., Gemma 4 12B, Qwen 3.8, etc.)
> - Initial characters are modeled after the ancient Greek Pantheon, Roman, Norse, Yoruba
> - Characters have mythological-specific environments but can cross into other gods' "realms"
> - 16-bit Chrono Trigger type UI with full-screen effects and cutscenes for key interactions
> - Can run completely untouched (fish bowl) or have player characters dropped in
> - Fully autonomous characters within the environment
> - Other features to be sampled from the references
>
> The end result will be a collection of tools, backend, and frontend interface in a Bun-managed workspace. The app must be local-first and have clean, responsive UX (see https://impeccable.style).
>
> First, I need a product brief and supporting Product documentation, requirements, and an outline to MVP. I will take these to build out the full app in another agent working within a dedicated agentic coding harness. When you scaffold, ensure all session memory, notes, directions, etc. make it into durable docs within the repo (attached `panthe.ai/`, for Panthea [e.g., "of all gods"], or panthe.ai).
>
> Interview me intensely for every detail needed before handoff.

## Current state

Nine interview rounds are complete, with full owner responses preserved in the numbered response files.
The owner accepted the MVP boundary and delegated tunable defaults and technical probes in round nine.
The repository contains the product brief, 49 requirements, decisions, defaults, detailed specifications, architecture recommendation, roadmap, and acceptance plan.
Start continuation at [docs/README.md](../README.md).

The accepted MVP is desktop-first with seven Greek gods, town/wilderness, Olympus, and a playable Underworld.
It includes autonomous economy and relationships, mortal participation, Universe, generated executable behavior and art, persistence, playback, and research inspection.
Tauri, WebGPU, Three.js, Three Flatland, Bun workspace management, MIT, and OpenCode/Systematic are owner-selected directions.
The backend, models, optional Lua runtime, population profile, and supported OS minimums require technical probes.

Browser multiplayer, other pantheons, content editors, voices, spending enforcement, video export/publishing, and batch experiments are deferred.
Continuous character activity has priority over art-generation latency.
Budget and deadline are unspecified.
No application code, dependencies, generated assets, deployment, or hardware test results were produced during discovery.

## Working directions

Use accepted decisions and delegated defaults rather than repeating discovery.
Keep implementation evidence, changed decisions, session notes, and reusable lessons in the repository.
Treat opening model names as examples, not verified dependency identifiers.
Use plain English for product documentation.
Distinguish recommendations and untested performance targets from confirmed results.

The owner reports that output after the question tool hides its controls.
When further interviewing is needed, finish updates first, ask through the tool, and wait without a final reply.
Wait for every question in a round when answers arrive separately.
Round seven was reissued several times after network interruptions; only its successful answers are treated as decisions.

## Next action

Implementation proceeds from docs/product/mvp-roadmap.md M0 with evidence in docs/decisions and docs/research.
Use the original responses only when resolving ambiguity or a consequential scope change.
Keep the distinction between an internal playable slice and the full accepted MVP.

## Documentation validation

Structural validation passed for 29 Markdown documents, 60 local links, 49 unique requirement IDs, and nine owner-response records.
The stale-pending-state scan found no remaining active interview questions or obsolete handoff blockers.
Whitespace validation passed.
The existing MIT license and original copyright year were retained.
Runtime and hardware verification remain implementation work.
