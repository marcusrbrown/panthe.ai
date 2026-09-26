# Panthea product package

Status: Ready for implementation planning after nine interview rounds.
The owner accepted the desktop-first MVP and delegated tunable defaults.

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
| [Architecture](product/architecture-options.md) | Backend candidates, boundaries, and workspace outline |
| [MVP roadmap](product/mvp-roadmap.md) | Milestones, dependencies, and future scope |
| [Acceptance](product/acceptance.md) | End-to-end tests, performance hypotheses, and unattended trials |
| [Open decisions](product/open-decisions.md) | Delegated engineering research and known risks |
| [Decisions index](decisions/README.md) | ADR index: architecture decisions with status, context, and evidence |
| [Stack research](research/stack-2026-09-26.md) | Rendering, desktop, backend, and sandbox documentation review |
| [Inference research](research/inference-2026-09-26.md) | Local/hosted model, image generation, and telemetry research |
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
