# MVP roadmap

Status: Accepted scope with an implementation sequence proposed under D23.
There is no calendar deadline or budget commitment.
Each milestone produces a reviewable result and evidence before the next dependent stage.

## Delivery sequence

| Stage | Outcome | Main requirements | Exit evidence |
| --- | --- | --- | --- |
| M0: Feasibility | Validate packaged rendering, local models/art, service lifecycle, and restricted execution | P02–P07, U05–U06 | Probe reports and architecture decisions on baseline hardware |
| M1: Persistent living world | Authoritative rules, movement, time, economy skeleton, events, storage, and local traces | P03, W02–W03, W05–W08, O01, O03–O04 | Headless scenario continues, survives restart, and records inspectable consequences |
| M2: Autonomous Greek cast | Seven sourced character profiles, memory, relationships, models, director, and fallback | W01, W04, W09–W10, P06–P07 | Unattended social/economic interactions with knowledge isolation and model-failure recovery |
| M3: Playable consequences | Mortal entry, dialogue, combat, artifacts, patronage, death/return, repair, and travel | M01–M08, W08–W11 | Play through strike, response, loss, afterlife, return, and recovery |
| M4: Universe and creation | Operator UI/API, schedules, validated generated behavior, procedural/local/hosted art | U01–U08 | Generate and replicate a new behavior/object with provenance while the world continues |
| M5: Complete experience | Polished maps/art, live title, tutorial, inspection, effects, audio, accessibility | X01–X06 | First-ten-minute and Zeus-scene reviews on the baseline device |
| M6: Research and replay | Portable worlds, retained-event playback, metrics, comparison branches, endpoint export | O01–O07 | Restore and replay offline; compare scenarios; view correlated external traces |
| M7: Release hardening | Baseline endurance, recovery, packaging, documentation, and supported platform builds | P01–P08, O08 | Acceptance report, release artifacts, known limits, install and recovery instructions |

Telemetry and persistence begin in M1 and accompany every later stage.
Do not postpone model and generation traces until M6.
Likewise, implement basic input and rendering early enough to expose interaction problems.

### M0 outcome (2026-09-27)

M0 is complete. Eight probes under `tools/probes/` measured packaged-app rendering, service
lifecycle, generated-code isolation, local inference, hosted-provider fallback and offline
behavior, local image generation, and three-way memory coexistence on the M1 Pro 16 GB baseline;
the full probe-to-ADR disposition is indexed in [m0-exit.md](m0-exit.md). The renderer holds at
~59 fps / 28 ms p50 click latency on the WebGL2 fallback (ADR-0002); the Bun sidecar survives
every required lifecycle transition (ADR-0003); QuickJS terminates every adversarial fixture with
zero escapes (ADR-0004); the local-inference baseline (`llama3.2:3b` @ 4K) and the OpenCode Go
hosted fallback chain are both measured, and offline mode is proven silent on the wire against a
positive control (ADR-0005); local image generation on stable-diffusion.cpp settles a base arm,
quantization profile, and cancellation behavior (ADR-0007); and the three-way coexistence probe
settles the shared heavy-work memory policy (an admission-controlled queue at 3 GiB free+inactive
memory) used by ADR-0003/0005/0007. Four independent re-checks remain open — tracked as their own
follow-up probes, not blockers to M1: packaged Flatland feature completeness on a second
WebGL2 GPU/driver, a signed (not ad-hoc) macOS 15 WebGPU re-check, a macOS 26 WKWebView WebGPU
re-check, and a packaged Windows/Linux renderer run. M1 work may begin without waiting on these.

## First playable slice

An early slice contains a small town scene, Zeus, one mortal, one damaging power, and a persistent event history.
It proves observation, conversation, a visible strike, one consequence, and save/reload.
This is an internal milestone, not permission to reduce the accepted seven-god MVP.

Develop the full roster and maps incrementally using the same contracts.
Each new system needs one concrete causal scenario rather than a disconnected feature demo.
Reuse those scenarios for later regression and performance checks.

## Suggested initial work items

The implementation agent can translate these into its Systematic task format:

1. Resolve current Three Flatland references and pin compatible versions.
2. Build a packaged Tauri/WebGPU scene and record platform results.
3. Benchmark local language and image providers with the scene running.
4. Compare service lifecycle and storage candidates, then record the backend decision.
5. Define command, event, entity, content, behavior, and save schemas.
6. Build transaction validation, simulation time, event history, and local tracing.
7. Prove isolated generated execution with adversarial fixtures.
8. Implement the first playable consequence slice.
9. Add the roster, memory, relationships, economy, and director.
10. Add mortal combat, patronage, artifacts, afterlife, and return.
11. Build Universe controls and generated creation workflows.
12. Complete art, orientation, accessible input, replay, research views, and release checks.

## MVP completion

All 49 requirements must have evidence or a documented conditional-platform outcome.
A successful rendering demo or lively conversation demo alone does not complete the MVP.
Use [acceptance.md](acceptance.md) for end-to-end and unattended trials.

A failed technical probe can change a delegated parameter.
A failure that removes offline play, generated creation, persistent consequences, or the chosen stack requires a scope decision.
Record the evidence and proposed change rather than silently omit the feature.

## Post-MVP sequence

Future work remains a direction rather than a committed order:

- Expand pantheons and realms, including Norse, Yoruba, Roman, and tentatively Akan content.
- Add browser access and a separately designed hosted multiplayer experience at panthe.ai.
- Add video-file export, direct YouTube publishing, and sharing controls.
- Add in-app map, character, lore, artifact, and behavior authoring.
- Add experiment batches, richer comparison reports, and spending/usage enforcement.
- Consider spoken voices, inspection-detecting powers, permanent divine death, lesser deities, and character-reset events.

Future multiplayer must revisit identity, permissions, privacy, persistence, time controls, and operator authority.
Do not assume the single-person desktop defaults are appropriate for a shared world.
