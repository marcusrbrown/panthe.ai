# Operations, persistence, and research

Status: Accepted direction and delegated defaults after round nine.
Requirements O01–O08 and U01–U03 define the operational release scope.
Research priorities are relationships, story variety, and responses to fortune or misfortune.

## Universe authority and history

The local owner has full operator authority.
Universe combines direct controls, commands, and a natural-language assistant.
It can relocate characters, edit prompts/imperatives, supply resources, change scenarios, recover areas, and schedule events.

Store operator intent, interpreted command, targets, preconditions, time, and outcome.
Natural-language commands get a concrete preview.
Direct explicit commands execute and record their result.

Scheduled earthquakes and destructive beast appearances are acceptance examples.
Use simulation time for schedules by default.
Pause delays scheduled events, and catch-up must resolve due events only once.

## Local source of truth

Keep authoritative world state, committed events, snapshots, content versions, generated behaviors, and asset references in local storage.
Maintain one writer or an equivalent concurrency control.
Persist world mutations and their event records atomically.

A snapshot identifies the content/runtime schema, world revision, random state, entity state, and relevant asset/behavior versions.
Do not snapshot live provider connections or resumable network requests.
On restoration, mark pending inference for safe retry with current-state validation.

Backup/export includes the world, snapshots, event intervals, required generated assets, content manifests, and behavior definitions.
Exclude credentials and local endpoint secrets.
Use checksums, a format version, and an import preview.

Reject unsupported future versions and corrupt archives with a useful error.
Make a backup before migration.
An import must never silently overwrite the only copy of a world.

## Replay

Playback uses committed events and stored presentation data without fresh model calls.
Record resolved movement/action timing, dialogue, effects, and asset versions needed for the retained interval.
Snapshots accelerate seeking.

Replay does not execute newly generated behavior again against the live world.
It reconstructs recorded outcomes in an isolated playback state.
Approximate catch-up intervals are labeled and cannot masquerade as recorded full-detail scenes.

Video-file export and direct YouTube delivery are post-MVP.
Retaining compatible event and asset data prepares for those features without implementing publication now.
World history and privacy settings must remain distinct from eventual public sharing settings.

## Telemetry contract

Every significant operation carries world ID, run/branch ID, simulation time, event ID, correlation ID, component, and version.
Link observations, decisions, requests, validated actions, outcomes, and rendering events.
Store fictional motive summaries separately from raw provider response fields.

Instrument these categories:

- Character and director model requests, prompts, selected context, latency, retries, fallback, and token usage when available.
- Perception, memory retrieval, action proposals, validation failures, resource changes, and relationship updates.
- Travel, combat, death, transformation, production, trade, damage, and recovery.
- Generated behavior validation, execution limits, activation, and quarantine.
- Asset requests, source parts, generation jobs, results, failures, and provenance.
- Universe edits, schedules, pause, catch-up, snapshots, imports, and restoration.
- Frame timing, simulation queue depth, memory, storage growth, and exporter state.

Full telemetry means category coverage and causal traceability.
It does not require writing every rendered frame or sampling audio continuously.
Use aggregates for high-frequency operations and retain detailed failure records.

## Privacy, retention, and exports

The operator controls payload collection, export categories, endpoint configuration, and retention.
Start with local-only collection.
Secrets are never model context, saved-world content, or telemetry payloads.

Maintain independent retention for diagnostic payloads and world playback records.
Detailed prompts default to seven days, while world history remains until archival or explicit pruning.
Explain when pruning breaks replay coverage or removes diagnostic context.

Export asynchronously to a configured Langfuse/OpenTelemetry-compatible endpoint.
Bound the disk queue and report queue saturation.
An unavailable endpoint cannot block simulation or cause unbounded memory growth.

Trace the exporter without recursively exporting its own failures forever.
Record dropped/coalesced diagnostic counts.
Authoritative world events cannot be silently dropped to satisfy a telemetry quota.

## Experiment workflow

Create a named snapshot and copy it into comparison branches.
Change one model, prompt, resource condition, or director setting.
Run each branch and compare resulting records.

MVP comparisons are manual.
Do not promise identical generative outcomes even with matching starting state and random seeds.
Batch runners and statistical research automation are deferred.

Provide local filtered event lists, a relationship graph/table, a legend/story timeline, and a small set of trend charts.
Export structured JSON and CSV for external analysis.
Model/prompt inspection links directly to its world consequences.

## Initial metrics

| Metric | Definition and purpose |
| --- | --- |
| Relationship change | Recorded edge changes by kind, magnitude, actors, and causal event |
| Story episodes | Connected event groups with actors, conflict/opportunity, consequences, and provenance |
| Repetition | Repeated action/dialogue patterns over a stated window; label heuristic results |
| Agency/activity | Committed meaningful actions and time spent idle, blocked, reasoning, or in routine |
| Fortune/misfortune | Resource, status, relationship, and location changes around selected events |
| Economy | Balances, transfers, production, inventory loss, service uptime, and repair progress |
| Mortality | Death, afterlife entry, return, retirement, and divine banishment counts |
| Inference | Queue wait, first-response/full-response latency, failures, retries, and fallback |
| Runtime | Frame time, tick time, memory, disk growth, and background continuity |
| Generation | Job duration, memory use, cancellations, validation failures, and asset adoption |

Story variety is not a single objective score.
Keep the underlying events inspectable and allow the owner to annotate memorable or repetitive episodes.
Evaluate entertainment through actual observation as well as metrics.
