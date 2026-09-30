# Tunable implementation defaults

Status: Delegated product defaults under D23.
Rows marked Accepted summarize the explicit round-nine choices.
Rows marked Default make remaining details concrete for implementation and can be tuned with recorded evidence.

| Area | Initial rule | Authority |
| --- | --- | --- |
| Conversation | Free-form typed dialogue plus contextual actions | Accepted |
| Player absence | Routine AI controls the same mortal, with full vulnerability | Accepted |
| Fate | Spawn realm determines the default afterlife; patron and killer influence are recorded | Accepted |
| Identity | Preserve identity and memory unless an explicit effect changes them | Accepted |
| Time controls | Pause and normal-speed play; no fast-forward UI in MVP | Accepted |
| Catch-up | Cap missed-time advancement and show a consequence summary | Accepted |
| Failure | Configured provider sequence, then routine-only behavior | Accepted |
| Undo | Restore a snapshot rather than reverse isolated committed events | Accepted |
| Art | Coherent temporary appearance while generation runs; simulation has priority | Accepted |
| World slots | One active simulation at a time; multiple saved worlds and copied snapshots | Default |
| Time scale | One wall-clock second advances one simulation second initially | Default |
| Catch-up cap | Advance at most one hour of missed wall time per return; no permanent backlog of discarded time | Default |
| Catch-up execution | Bounded coarse steps use normal action validation; mark approximation and preserve causal history | Default |
| Catch-up responsiveness | Run catch-up in cancellable chunks; stop at last committed boundary if operator skips remainder | Default |
| Paused world | Persist pause across restart; paused elapsed time does not create catch-up | Default |
| Background mode | Continue after window close by default, with visible status and an explicit stop command | Default |
| Autosave | Commit world events continuously and checkpoint at most every 60 seconds, plus clean shutdown | Default |
| Snapshots | Name and retain manual snapshots until explicit deletion; restore into a new branch by default | Default |
| History | Retain world events and required playback assets for the active world until operator archival/pruning | Default |
| Trace retention | Keep detailed model payloads for seven days initially; operator can change limits | Default |
| Export | Local-only by default; endpoint and payload categories require operator configuration | Default |
| Credentials | Keep secrets outside content, saves, prompts, and telemetry; use platform credential storage when available | Default |
| Natural-language operator edits | Show the interpreted change, targets, and timing before applying it | Default |
| Direct operator actions | Apply explicit controls immediately and record them; destructive world restore gets a concrete preview | Default |
| New behaviors | Validate, trial in bounded execution, register, and activate automatically; quarantine invalid versions | Default |
| World generation | Start from authored maps and population templates, then evolve through simulation | Default |
| Combat clock | Readiness-based turns with cast/recovery times; world time continues while actions resolve | Default |
| Idle combat input | Defend or use configured routine after a visible timeout; global pause remains available | Default |
| Cutscene urgency | Surface danger and offer immediate skip when the player requires input | Default |
| Afterlife return | Start with one authored Underworld release condition; the same rule applies to mortals and NPCs | Default |
| Permanent death | Retire the playable identity irreversibly in the current branch; keep historical records and permit a new mortal | Default |
| Transformation | Version identity-affecting effects; preserve possessions unless the effect explicitly moves, destroys, or suppresses them | Default |
| Worship | Track observable worship acts and allegiance; influence divine capacity through configurable rules | Default |
| Legends | Record narratives and belief separately from verified events; legends are not spendable currency initially | Default |
| Memory | Each actor keeps at most 24 memories (`memoryBalance.capacity`); a full memory forgets the least salient entry first and the oldest among equals, so live play and a rebuild from the log forget the same things. Witnessing is judged by the perception rule, at the moment of the event. Salience per event kind (`salience_<kind>`): building damaged 5, ignited 8, destroyed 9, repaired 4, worship 4, legend 3, and a belief formed from a report 4; every other kind is not remembered (routine gathering, trade, income, and movement stay out so the log and each memory hold what mattered). Set from the M2 unattended run | Default |
| Relationships | Harm one remembers lowers affinity toward whoever did it by 2 and adds a grudge when the rememberer was the one wronged; a kindness raises the served party's affinity by 1; a belief moves affinity by half as much as witnessing (`toldShare`, at least 1). Affinity stays within plus or minus 10 (`affinityLimit`) and two actors count as allied at 5 (`allianceAffinity`). All in `memoryBalance` | Default |
| Rumors | One hop: only an actor that witnessed an event may cite it in a report. Someone who was only told may retell the story, uncited, as their own account. The teller's words are stored as told and never rewritten; distortion is whatever the teller says, and the world never resolves a belief to the truth | Default |
| Sources | Bundle a lore/source index; distinguish documented variant, authored interpretation, and emergent event | Default |
| Local generation | Provide procedural generation immediately; schedule local image jobs without blocking world actions | Default |
| Model outage | Continue existing routines, surface degraded status, and retry with backoff; do not fabricate successful model responses | Default |
| Input layout | Keyboard, controller, and pointer parity for core actions; text entry can use the platform keyboard | Default |

## Numerical parameters

The one-hour catch-up cap, seven-day trace retention, checkpoint interval, and combat timeout are starting parameters.
Put them in documented configuration rather than bury them in prompts.
Probes and usability evidence can change them without altering the accepted product boundary.

Population, exact models, image-job latency, and minimum OS versions remain probe outputs.
Start the population experiment at seven gods and twenty ordinary inhabitants, then publish measured limits.
Do not reduce the seven-god content roster to hide an inference bottleneck.

## Experiments and event history

A snapshot copy supports a manual comparison between two model or prompt configurations.
It does not promise identical model outputs.
World playback uses recorded outcomes, assets, and behavior versions without new inference.
Changing retention must explain which playback intervals or diagnostic details will become unavailable.
