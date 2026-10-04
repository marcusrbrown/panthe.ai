# Panthea product package

Status: Ready for implementation planning after nine interview rounds.
The owner accepted the desktop-first MVP and delegated tunable defaults.

## Current authority

For what is decided and built now, read in this order: owner choices in [Decisions](product/decisions.md), then the accepted [ADRs](decisions/README.md) (they supersede parts of the original [Architecture recommendation](product/architecture-options.md), which stays as the proposal), then the [MVP roadmap](product/mvp-roadmap.md) milestone outcomes for what has been verified and what remains open, and [Traceability](product/traceability.md) for per-requirement status and evidence. Research and review documents inform decisions but do not change them.

## Reading order

| Document | Purpose |
| --- | --- |
| [Brief](product/brief.md) | Audience, experience, accepted scope, and exclusions |
| [Decisions](product/decisions.md) | Owner choices and superseded directions |
| [Defaults](product/defaults.md) | Explicit, tunable rules for unresolved detail |
| [Requirements](product/requirements.md) | 49 traceable MVP obligations with acceptance evidence |
| [Traceability](product/traceability.md) | Milestone, status, implementation, and evidence for every requirement ID |
| [Simulation](product/simulation-direction.md) | Authority, characters, economy, combat, creation, and time |
| [Content](product/content-direction.md) | Roster, lore, tone, art, and source records |
| [UX](product/ux-direction.md) | User journeys, controls, observation, accessibility, and recovery |
| [Operations](product/operations-and-research.md) | Universe, saves, replay, telemetry, and experiments |
| [Technical constraints](product/technical-constraints.md) | Selected stack and required probes |
| [Art guide](product/art-guide.md) | Draft visual standards: scale, palette, line, tiles, effects, conformance checks |
| [Architecture](product/architecture-options.md) | Original architecture recommendation (proposal; accepted decisions are in the ADRs) |
| [MVP roadmap](product/mvp-roadmap.md) | Milestones, dependencies, and future scope |
| [Acceptance](product/acceptance.md) | End-to-end tests, performance hypotheses, and unattended trials |
| [Open decisions](product/open-decisions.md) | Delegated engineering research and known risks |
| [Decisions index](decisions/README.md) | ADR index: architecture decisions with status, context, and evidence |
| [Stack research](research/stack-2026-09-26.md) | Rendering, desktop, backend, and sandbox documentation review |
| [Inference research](research/inference-2026-09-26.md) | Local/hosted model, image generation, and telemetry research |
| [Asset generation research](research/asset-generation-2026-10-03.md) | Local sprite, tile, sound, and editor tooling survey with licences |
| [References](research/references.md) | Source observations and limits |
| [Solutions](solutions/README.md) | Reusable engineering lessons from probes and implementation work |

## Durable discovery record

[The interview](discovery/interview.md) records each question round and links to the owner's full responses.
[The session record](discovery/session.md) preserves the original request and current continuation instructions.
Later accepted decisions supersede earlier open questions.

## Selected implementation direction

Use a Bun-managed workspace, Tauri, Three.js, and Three Flatland, rendering through WebGPU where the webview supports it and WebGL2 otherwise (D25).
The MVP targets local single-person desktop use with optional hosted model adapters.
The owner implements through OpenCode and Systematic.

## Brainstorms and handoffs

- [Asset studio requirements (2026-10-03)](brainstorms/2026-10-03-asset-studio-requirements.md) and its [handoff prompt](brainstorms/2026-10-03-asset-studio-handoff.md): authoring tooling for sprites, tiles, effects, and sound, built in a separate worktree alongside M2.

## Implementation reviews

- [M0/M1 review and OpenCode prompt (2026-09-28)](research/m0-m1-review-2026-09-28.md): architecture assessment, reproduced correctness gaps, and focused M2 follow-up. Review recommendations do not supersede owner decisions or ADRs.
