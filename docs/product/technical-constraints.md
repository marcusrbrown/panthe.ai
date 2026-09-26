# Technical constraints

Status: Accepted direction and delegated engineering work after round nine.
Selected technologies are constraints; backend/runtime recommendations remain subject to probes.
No dependencies or application scaffolding were installed during discovery.

## Selected stack and delivery

Use a Bun-managed workspace for tools, backend, and frontend.
Use Tauri v2 or a newer suitable stable version for desktop delivery.
Render the world on a WebGPU canvas through Three.js and Three Flatland.

The backend runtime, UI framework, database, and optional Lua interpreter remain research choices.
The first backend candidate is described in [architecture-options.md](architecture-options.md).
Pin exact versions after compatibility probes.

Target the M1 Pro with 16 GB and scale to the M4 Pro with 48 GB.
Target Linux and Windows when the required stack supports them.
Desktop is the MVP focus; browser delivery and hosted multiplayer follow later.

The project license is MIT.
The implementation harness is OpenCode with the owner's Systematic compound-engineering workflows.
The implementing model will be a capable model such as Astra or Opus.
Budget and deadline are unspecified.

## Offline boundary

First-run downloads and setup are acceptable.
After setup, core play, lore, local language inference, local visual creation, persistence, replay, and inspection work without external networking.
No remote telemetry, account, CDN, font, model catalog, or license check can be required for offline play.

A local provider endpoint on the same machine is compatible with offline mode.
A remote LAN provider is a separately configured deployment and does not prove single-machine offline capability.
Core bundled assets and procedural generation remain available during image-provider delays.

## Model and image adapters

Probe candidates before selecting defaults.
The owner accepts external local servers and direct model access, with Ollama as the familiar starting point.
Configure assignments per character or role, including director/world agents and generation roles.

Support optional mixed local and hosted providers.
Requested hosted targets are OpenCode Go, OpenAI, and Anthropic.
Authenticate only through supported modes established by current provider research.

Fallback follows an explicit configured sequence.
If every allowed provider fails, continue routines and show degraded status.
Offline mode cannot silently switch to a hosted endpoint.

Provide procedural visual creation plus local and optional hosted image adapters.
Image jobs can take minutes and use coherent temporary art.
Do not block authoritative actions or degrade all conversation to prioritize artwork.

## Generated execution

Use a game-only runtime with validated world APIs.
Generated behavior has no host files, shell, credentials, or network access.
Valid behavior activates autonomously and enters Universe's versioned registry.

Lua is a candidate for more complex behavior, not a fixed dependency.
Enforce execution and object-creation budgets at the runtime boundary.
Persist exact behavior versions and resolved outcomes.

## Observability

Keep local event/trace storage and an in-game inspector available.
Export can target operator-configured hosted Langfuse/OpenTelemetry services.
The complete dashboard stack is not a baseline local dependency.

Privacy and retention are operator-configurable.
Store credentials separately and omit secrets from exports.
Spending and usage enforcement is post-MVP, while provider failure handling is required.

## Probe authority

Technical probes determine initial population profiles, exact models, generation latency, and minimum OS versions.
They can also select the backend and implementation libraries within the fixed product boundary.
Record results and consequences in architecture decisions.

A probe is not permission to silently remove accepted capabilities.
If the chosen stack or baseline cannot support a core requirement, present measured evidence and a concrete alternative.
See [open-decisions.md](open-decisions.md) for the remaining engineering decisions.
