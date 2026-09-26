# Acceptance and evaluation plan

Status: Release tests and tunable targets under D23.
This document defines evidence to collect during implementation.
No runtime, hardware, art-quality, or gameplay checks were performed during product discovery.

## Test profile

Record device, OS/webview, GPU, memory, app/runtime versions, model IDs, quantization, context sizes, active population, and generation configuration.
The baseline is the owner's M1 Pro with 16 GB.
The comparison device is the M4 Pro with 48 GB.

Start population probes at seven gods and twenty ordinary inhabitants.
The seven-god roster is fixed content, while simultaneous reasoning frequency and background population are tunable.
Test with renderer, persistence, telemetry, and model queues together.

## Provisional performance targets

These are hypotheses for M0, not claims about measured hardware.
Revise them with evidence and retain the revised values in the release profile.
Do not weaken the accepted experience to make a benchmark appear successful.

| Measure | Initial target |
| --- | --- |
| Input feedback | Visible response within 100 ms at the 95th percentile |
| Rendering | 30 FPS or better during ordinary play at a 1280×720 window, with effects profiled separately |
| Model feedback | Pending state immediately; first useful reply within 10 seconds and completion within 30 seconds at the 95th percentile |
| Routine continuity | Movement and committed routine actions continue while inference or image jobs wait |
| Queue health | No unbounded growth; per-character starvation is detected and reported |
| Memory | No process termination or sustained unusable swapping at the selected baseline profile |
| Asset generation | Minutes are acceptable; no blocking of input or authoritative simulation |
| Persistence | No lost committed events after restart; checkpoints at most 60 seconds apart initially |
| Offline startup | Opens an existing prepared world without external requests or credentials |

If reply targets fail, compare smaller models, context limits, scheduling, and concurrency.
Report the resulting quality/performance tradeoff rather than imply faster hardware.
A mock model can test plumbing but cannot satisfy the live local-model acceptance gate.

## End-to-end trials

| Test | Procedure | Pass evidence |
| --- | --- | --- |
| A01: Offline first session | Complete setup, disconnect networking, launch, observe, create mortal, talk, travel, save | Core flow works with clear live/degraded state; no hosted requirement |
| A02: Divine consequence | Trigger a valid Zeus strike near a tree/tavern, then let actors react | Damage, fire, lost service/inventory, memories, reactions, and trace links agree |
| A03: Recovery | Have a motivated actor obtain materials and repair the damaged service | Resources are consumed and service resumes through valid events |
| A04: Knowledge | Create a private event, then question unaware and informed characters | No unauthorized knowledge leakage; reports/powers create attributable awareness |
| A05: Interruption | Start dialogue, then introduce danger, travel, or another actor | Pending responses revalidate; no duplicate actions or frozen world |
| A06: Combat and mortality | Fight, flee, persuade, summon, die, enter Underworld, and satisfy return condition | Costs, timing, identity, fate record, and playable return behave consistently |
| A07: Absence | Leave a mortal under routine control and close the window | World continues; mortality remains possible; return summary reflects actual events |
| A08: Catch-up | Stop/sleep, return after intervals below and above the cap, then crash/restart during catch-up | Applied/skipped time is clear; no double advancement; pause remains respected |
| A09: Universe | Relocate actor, edit imperative, preview a language command, schedule/cancel a disaster | Correct targets change, history links causes, due events execute once |
| A10: Generated behavior | Generate a new bounded behavior, register, execute, and replicate with another realm modifier | New executable result, autonomous admission, recorded version and adapted presentation |
| A11: Runtime isolation | Attempt escape, runaway recursion, massive spawning, invalid resource use, and partial failure | Execution terminates within limits without host access or corrupt state |
| A12: Generated visuals | Produce procedural art, run local image generation, and test a configured hosted image adapter | Temporary art is coherent; activity continues; final results have provenance |
| A13: Provider failure | Fail primary, fallback, and all endpoints; include malformed outputs | Configured routing only; bounded retries; routine-only mode and useful status |
| A14: Save and restore | Export world, import elsewhere, corrupt an archive, and restore a snapshot copy | IDs/state/assets/behaviors remain consistent; invalid imports preserve existing worlds |
| A15: Replay | Disable inference and play a retained event interval | Outcomes and presentation match recorded data; approximate intervals are identified |
| A16: Telemetry | Inspect a causal chain, export to endpoint, interrupt endpoint, and apply retention | Correlation works; secrets are absent; local play continues; pruning consequences are explained |
| A17: Access and presentation | Use keyboard/controller/pointer, larger text, reduced motion, mute, and cutscene skip | Core tasks remain available and consequences remain legible |
| A18: Manual experiment | Copy a snapshot, vary resources or imperative/model, compare runs | Relationship/story differences have inspectable evidence and structured exports |

## Unattended trials

Run a one-hour observation trial without operator interventions after initialization.
Include ordinary routines, conversation, economic actions, and opportunities for meaningful consequences.
Record actor participation, idle reasons, relationship changes, legends, repeated patterns, and queue health.

Run an eight-hour endurance trial on the selected baseline profile.
Keep bounded storage/queues, restart recovery, offscreen activity, and provider interruption in scope.
Director events are allowed but must be attributed rather than passed off as spontaneous character decisions.

The owner reviews selected episodes for surprise, character coherence, consequence, and desire to continue watching.
A world full of repeated greetings does not pass simply because it emits many actions.
A forced destruction loop also fails the intended experience.

Use a short rubric with scores and examples for novelty, causality, recognizable identity, pacing, and inspectability.
Retain unsuccessful episodes as tuning evidence.
Entertainment approval is a human evaluation, not a model-generated claim.

## Documentation and release checks

Make sure every requirement ID has an implementation link and evidence.
Record tested OS/model profiles and known platform limitations.
Include setup, offline operation, background shutdown, backup/restore, content authoring, and telemetry instructions.

Keep source and generated asset attribution separate from project code licensing.
Include version pins and model/runtime setup requirements.
Release builds must pass clean-install and existing-world upgrade tests before publication.
