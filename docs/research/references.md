# Reference review

Reviewed on 2026-09-25 from the linked project pages.
These observations describe documentation, not hands-on behavior tests or a source audit.
Feature candidates are proposals for the interview, not requirements.

## AI Town

[AI Town](https://github.com/a16z-infra/ai-town) documents autonomous social characters, local inference through Ollama, and configurable model providers.
Its stack includes Convex and PixiJS.
Its documentation covers character data, sprite sheets, tile maps, memory embeddings, and world controls.
The documented idle behavior pauses the simulation after five minutes without activity.

Candidate features for Panthea include character inspection, remembered interactions, customizable worlds, and explicit pause controls.
Panthea must separately define unattended operation and offline setup.
Do not assume that the reference's deployment choices satisfy Panthea's requirements.

## SimTown

[SimTown](https://github.com/simtownai/simtown) documents a multiplayer simulation with React, Phaser, Socket.IO, Supabase, and OpenAI.
Its README lists autonomous characters, mobile touch controls, persistent interaction history, and Google OAuth.
It separates server responsibilities from client rendering and documents Bun development commands.

Candidate features include player entry, touch movement, conversation history, and synchronized world views.
Multiplayer and accounts remain unresolved for Panthea.
The documented service requirements do not establish a fully offline experience.

## Impeccable

[Impeccable](https://impeccable.style) emphasizes visual hierarchy, clear interface language, deliberate typography, adaptation, and interface refinement.
The site provides design guidance and tools rather than a game specification.
The owner references it as a UX quality direction.

Proposed applications include a clear primary world view, readable conversation panels, visible system states, and layouts suited to each screen size.
The interview must establish how the pixel-art world and interface typography fit together.
No Impeccable package or skill was installed during this review.

## Three Flatland and Tauri

[Three Flatland's LLM guidance](https://tjw.dev/three-flatland/llm-prompts/) describes a Three.js sprite/effects library using WebGPU and TSL.
It provides machine-readable documentation and warns about renderer initialization and import mistakes.
The page labels the project alpha. Pin and test versions during implementation.
The linked `llms.txt` endpoint failed during this review. Resolve a working reference rather than assume its contents.

[Tauri's webview reference](https://v2.tauri.app/reference/webview-versions/) documents WebView2 on Windows and WebKit on macOS and Linux.
Inference: test packaged-app WebGPU support on each target runtime rather than infer it from ordinary browser support.
No platform compatibility or rendering benchmark was performed during this discovery session.

## Systematic

[Systematic](https://github.com/marcusrbrown/systematic) describes structured brainstorm, plan, work, and review workflows that capture engineering lessons.
The owner selects its OpenCode workflow for implementation.
Preserve requirements and decisions for that workflow without copying unverified installation commands or version-specific skill counts.
No plugin was installed or invoked here.

## Langfuse

[Langfuse's self-hosting documentation](https://langfuse.com/self-hosting) describes a multi-service ingestion and analytics architecture.
The owner accepts a hosted endpoint on another machine, with local inspection retained in Panthea.
Inference: this avoids making the complete observability stack a mandatory part of the 16 GB baseline runtime.
Endpoint compatibility, offline buffering, and retention still require implementation tests.

## Mothership

[Mothership](https://github.com/marcusrbrown/mothership) describes an agentic canvas for orchestrating autonomous agents and managing their interactions.
It is a Bun-managed workspace using Tauri v2 for desktop integration and WebView-based rendering.
Study its architecture and integration patterns to understand how autonomous agents are orchestrated and how the canvas interacts with the underlying system.
