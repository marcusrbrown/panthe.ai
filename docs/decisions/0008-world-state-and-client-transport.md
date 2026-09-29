# 0008: World state and client transport

## Status

Accepted (2026-09-28). The state model, external proposal intake, and import/restore semantics are delegated decisions under D23. The frame transport shape and its schema-version handling are owner decisions (2026-09-27 polling transport, 2026-09-28 recent-event window). Confirmed by the M1 persistence, simulation, and client test suites and by the packaged shell view gate ([tools/scenarios/m1-packaged-shell/README.md](../../tools/scenarios/m1-packaged-shell/README.md#view-gate)).

## Context

M1 needs a persistent world that survives restarts and crashes (O03), evolves while the window is closed (W03), exports and restores (O01), replays without fresh inference (O02), and can be inspected causally (O04), all offline (P01). D11 requires operator changes to be recorded apart from character actions, and D14 requires presentation to follow committed world events. The simulation service is authoritative ([ADR-0003](0003-simulation-service.md)) and the webview only presents.

Four questions had to be settled together, because each constrains the others: what is the source of truth for world state, how outside input (fixtures, operators, later models) reaches the world, how a world enters the system from an archive, and how committed state reaches the renderer without giving the webview authority or the sidecar token.

## Decision

### State model

The append-only event log, with periodic snapshots, is the source of truth. Everything else is derived, except the external proposal journal, which is recorded input.

- One SQLite database per world slot. Its STRICT tables are `world`, `clock`, `prng_state`, `genesis`, `projections`, `events`, `external_proposals`, and `catch_up_progress` ([packages/persistence/src/store.ts](../../packages/persistence/src/store.ts), `createSchema`). The trace tables ([packages/telemetry/src/trace.ts](../../packages/telemetry/src/trace.ts)) live in the same file but are not part of the world state.
- One tick is one `IMMEDIATE` transaction that appends the tick's events, updates the projection row, advances the clock cursor, and persists the PRNG state together (`commitTick`). The same transaction writes the tick's trace rows and marks the journal entries it ran as consumed ([apps/simulation/src/tick.ts](../../apps/simulation/src/tick.ts), `commitWorldTick`, `traceWorldTick`). A crash rolls back to the last committed tick; an elapsed interval is applied once.
- The `projections` row is a read model. `rebuildProjections` replays the log from the persisted `genesis` row through the world reducers and must equal the live projections (rebuild-equals-live, [packages/persistence/src/store.test.ts](../../packages/persistence/src/store.test.ts)).
- A snapshot is a consistent read pinned to one committed event sequence. It is a restore and speed artifact, never authority ([packages/persistence/src/snapshot.ts](../../packages/persistence/src/snapshot.ts)).
- Ownership: `packages/world` owns event reducers and projection definitions and never depends on SQLite. `packages/persistence` owns transactions, storage, snapshot, export, import, the proposal journal, and projection application and rebuild by calling injected reducers; it never imports `packages/world`.
- Determinism boundary: only persisted world state, the persisted PRNG state, versioned content, recorded operator events, and recorded external inputs from the proposal journal influence outcomes. The wall clock enters only as the clock cursor's elapsed interval, which is stored in the `clock` row and committed with the tick's events; it never reaches world logic directly. Filesystem metadata, host ordering, and transport timing are never inputs. The journal keeps each external input, its arrival order (`input_order`), and the tick that consumed it (`consumed_tick`), so the tick an input landed in is recorded, not inferred.
- One schema initializer stamps `user_version` (`CURRENT_SCHEMA_VERSION`, currently 4). A store file carrying any other version is rejected, never reset or migrated (`needsSchema`). Event, proposal, snapshot, and archive payloads must be their exact current version.

### Time and catch-up

Context for the frame's `catchUpSummary`. Catch-up applies missed wall time in chunks, each committed as one transaction with the cursor advanced inside it ([apps/simulation/src/catchup.ts](../../apps/simulation/src/catchup.ts), `runCatchUp`). The cap bounds the remaining backlog, not a single run: the excess over the cap is discarded in one commit before any chunk, and the applied and discarded totals are committed with each discard and chunk in `catch_up_progress`. A restart continues the backlog without a fresh cap, and the summary it reports covers the whole backlog. That summary is derived, not held in memory: applied and discarded time come from `catch_up_progress`, and the major outcomes from the events committed after the `start_sequence` the progress row records, so a backlog worked on by several runs, with restarts, a crash, or a restore in between, reports the same summary as an uninterrupted one. The progress row stays open after the last commit, or after a mid-catch-up pause ends the backlog, until the service has published the summary and then closes it (`refreshStatusAfterCatchUp`); a process that died before then finds the same summary waiting on its next start. A remainder shorter than one tick is neither applied nor reported, so a sub-tick gap on launch publishes no summary (`apps/simulation/src/index.ts`). Paused wall time never becomes catch-up; resume discards it.

### External proposal intake

`POST /proposals` is the intake for fixtures and operators, and later model output. Nothing in it reads a clock.

- Contract: the body is `{ proposalId, observation, proposal }`. The producer supplies `proposalId`, and `proposal.observationId` must equal `observation.id`; a malformed body, an unparseable proposal, or a legend linked to an event that is not committed is a 400. Intake journals the entry in one transaction (next `input_order`, `target_tick` = the persisted tick + 1) before it answers ([packages/persistence/src/journal.ts](../../packages/persistence/src/journal.ts), `insertExternalProposal`; [apps/simulation/src/server.ts](../../apps/simulation/src/server.ts), `handleProposal`). A pending entry answers 202 with `status: "pending"`. If journaling fails the proposal is not accepted (500).
- Retry: the same `proposalId` with the same content returns the existing entry: 202 while pending, and the terminal `committed` or `rejected` status (with the rejection reason) once consumed. The same id with different content is a 409, and so is an id the trace already holds for a proposal the journal never accepted.
- Consumption: an entry runs on the next simulated tick, live or the first tick of a catch-up chunk, at most once. The tick that runs it marks it consumed and stores its outcome and rejection reason on the journal row in the same transaction as its own commit. Over-limit proposals are consumed too, with `over-limit` as the reason.
- Ordering: entries run in input order, ahead of routine proposals (`mergeTickQueue`, tick.ts). An external non-claim proposal for an actor takes that actor's slot for the tick, and the actor's routine proposal yields; it is dropped before the tick and nothing about it is recorded. Claims never commit, so they never displace a routine. Under `maxProposalsPerTick`, actions and claims are counted separately (`admitWithinCap`), so a flood of claims cannot cost a routine its slot.
- Paused: the endpoint accepts while the world is paused. The entry stays pending until a simulated tick runs. The paused interval is discarded on resume, and the entry runs on the next tick after that.

### Import and restore

- Import and restore always materialize a new slot under the slots directory. Nothing overwrites an existing world, including the active one ([apps/simulation/src/worlds.ts](../../apps/simulation/src/worlds.ts)). Slot IDs are service-generated; no path component comes from an archive or a request. `POST /import` and `POST /restore` share one handler (server.ts).
- An export archive is a single self-describing SQLite file captured at a committed sequence, carrying a manifest table (format version, SQLite and payload schema versions, world ID, event sequence, content hash). The hash covers a canonical dump with a fixed table order and rows ordered by primary key ([packages/persistence/src/archive.ts](../../packages/persistence/src/archive.ts)). The dump covers the world tables, the events, and the whole `external_proposals` journal, pending and consumed, with ids and order preserved. A restored branch runs its pending entries once, and a retry of a consumed proposal reports its original outcome.
- Archives are untrusted bytes. `importArchive` opens the archive read-only, runs `integrity_check`, requires the exact current format and schema versions, checks the manifest against the archive's own tables (world ID, last event sequence), and verifies the content hash. It then reads rows with fixed, named `SELECT`s and parses events and clock, PRNG, genesis, and projection rows. Each journal entry must parse as the versioned proposal and observation it claims to be, cite its own observation, follow the previous entry's input order, have been consumed by a tick the archive's clock has reached, and carry an outcome that matches its consumption and a reason code the world can give. The validated rows are written into a freshly initialized staging database created by our own schema. The archive is never used as a live database and its own schema objects are never executed. The staging directory is published by atomic rename; any failure removes it.
- Archives carry no trace records, but they do carry an open catch-up backlog's progress (`catch_up_progress`, hashed and validated like the journal), so a restore taken mid-backlog resumes it and reports the same summary as an uninterrupted run. The trace tables are not exported, and the imported schema starts them empty.
- Old-schema stores and archives are rejected outright. There is no migration ladder, upcaster, or pre-migration backup until a shipped format has to survive a change.

### Client transport

- The sidecar binds `127.0.0.1` only and requires the launch token on every request; it rejects requests with an `Origin` or `Sec-Fetch-*` header or a foreign `Host` (`checkRequestGuards`, server.ts).
- The sidecar serves one committed-state frame, `SyncFrame` ([packages/contracts/src/snapshot.ts](../../packages/contracts/src/snapshot.ts)): `sequence`, `worldId`, `sessionId`, `status` (running, paused, or degraded, with a reason), an optional `catchUpSummary`, `recentEvents`, and the projection `state`. `GET /frame` returns it. The WebSocket at `/stream` accepts the same authenticated upgrade, sends the current frame on open, and publishes each new frame to its subscribers; the shell does not use it.
- `catchUpSummary` is level state: the sidecar holds the latest summary on every frame until a later catch-up replaces it, and the summary carries its own identity (`atSequence`). See [the catch-up learning](../solutions/integration-issues/catch-up-summary-lost-between-polls-2026-09-28.md).
- `recentEvents` is a bounded window of committed events (the last 10 ticks, at most 200 events, ascending by sequence), each with its id, sequence, tick, kind, and the entity IDs it touches, so the client can receipt what it renders. The window matches the sequence the same frame reports (`readRecentEvents`, server.ts).
- The Rust shell owns the token. It polls `GET /frame` once a second and forwards the body verbatim to the webview over a Tauri `Channel` only when the frame's sequence, status, or session ID changed; a new or reloaded subscriber is replayed the cached frame at once ([apps/desktop/src-tauri/src/proxy.rs](../../apps/desktop/src-tauri/src/proxy.rs)). Pause, resume, and receipts are token-bearing POSTs from the shell.
- The webview is an untrusted consumer. It parses every frame through `parseSyncFrame` ([apps/client/src/connection.ts](../../apps/client/src/connection.ts)), holds no token, and has one capability set: subscribing to the frame stream and relaying a presentation receipt through the shell ([apps/desktop/src-tauri/capabilities/proxy.json](../../apps/desktop/src-tauri/capabilities/proxy.json), [apps/desktop/src-tauri/src/commands.rs](../../apps/desktop/src-tauri/src/commands.rs)). A receipt records event ID, session ID, and presentation time in a trace-only table; a receipt for an unknown event is rejected, and it cannot mutate world state. The sidecar rate-limits `POST /receipts` to 50 per one-second window (`RECEIPT_LIMIT_PER_WINDOW`, server.ts).
- The transport is full committed state per frame, not a snapshot plus sequenced deltas. A reconnect requests a fresh frame; there is no resync marker, generation counter, or session-change marker.
- `SyncFrame` stays at schema version 1 while no reader has shipped. The sidecar and client ship in one bundle, so a frame-shape change (such as required `recentEvents`) carries no compatibility shim (owner decision). Revisit when a reader can outlive the sidecar it was built with.

## Consequences

- Replay, restore, causal inspection, and crash recovery share one mechanism. A projection bug is repairable by rebuilding from the log, and a rebuild-equals-live test catches projection drift.
- The log and the proposal journal grow without bound in M1; retention belongs to the requirement that owns it (O05).
- An accepted external proposal survives a crash or restart because it is journaled before the 202. A crash before its tick commits leaves it pending, and it runs once on the next tick.
- Every world entering the system passes through one staging path, so a corrupt or tampered archive can neither corrupt nor replace an existing slot.
- Known limit: a restored or imported branch has no causal trace for history before the restore. Archives carry world state and the journal with each entry's outcome, not trace records, so following an event or proposal from before the restore has no observation or proposal hop. Following what happens after it works as usual. Carrying the trace in archives would need its own format decision.
- Incompatible stores and archives are unusable, not upgraded. This is acceptable only while nothing has shipped; the first shipped format that must survive a schema change needs a migration decision and a superseding note here.
- The archive path treats owner-exported files as if they could be hostile without a separate hostile-bytes framework (a pre-validation copy, schema allowlist, and import budgets). If archives begin moving between users or through a less-trusted producer, revisit that.
- Sending full state at 1 Hz is simple and stateless per subscriber. Add deltas only after frame transport cost is measured against the 1 Hz budget and found wanting.
- One second of poll latency is the floor for the webview to see a committed change, and a change shorter than the poll interval is only visible if the frame holds it. That is why the catch-up summary is level state and the recent-event window spans ten ticks.
- The webview cannot decide outcomes, reach the sidecar, or read the token. A compromised webview can only receipt event IDs the sidecar already knows, and receipts are rate limited.

## Alternatives considered

- **In-memory proposal queue.** Rejected: a 202 followed by a crash lost the proposal with no outcome, and which tick an input landed in was not recorded.
- **Mutable tables as source of truth, with an audit log.** Rejected: two records of history can disagree, and replay and causal inspection need the log to be authoritative.
- **Snapshots as authority.** Rejected: a snapshot cannot explain how state came to be, so it cannot serve O02 or O04.
- **Forward migration in place with a pre-migration snapshot.** Deferred until a format has shipped. Greenfield with a single local user has no data to protect.
- **Hostile-archive framework** (private read-only copy, schema allowlist rejecting triggers, views, and virtual tables, duplicate integrity scan, byte/row/time budgets). Deferred: the copy step runs only fixed `SELECT`s into tables we created.
- **Webview subscribes to the sidecar directly (WebSocket).** Rejected: it puts the token in the webview and widens `connect-src` beyond IPC.
- **Shell holds a WebSocket subscription and forwards deltas.** Rejected for M1: it needs resync and session-change machinery for one subscriber with no measured cost problem.
- **Per-caller role matrix for sidecar endpoints.** Rejected: every caller holds the same single token, so the matrix would gate nothing real.

## Evidence/links

[docs/plans/2026-09-27-001-feat-m1-persistent-living-world-plan.md](../plans/2026-09-27-001-feat-m1-persistent-living-world-plan.md) Key Technical Decisions; [tools/scenarios/m1-packaged-shell/README.md](../../tools/scenarios/m1-packaged-shell/README.md); [catch-up-summary-lost-between-polls-2026-09-28.md](../solutions/integration-issues/catch-up-summary-lost-between-polls-2026-09-28.md); [world-persistence-composition-broken-after-reopen-2026-09-27.md](../solutions/integration-issues/world-persistence-composition-broken-after-reopen-2026-09-27.md); [ADR-0003](0003-simulation-service.md); [ADR-0006](0006-telemetry-export.md).

M1 living-world scenario: [tools/scenarios/m1-living-world/README.md](../../tools/scenarios/m1-living-world/README.md). It drives the compiled sidecar headlessly through the state-model, intake, catch-up, import/restore, and receipt paths above (S11–S16), with a positive control for every negative claim (seven: `archive`, `catch-up`, `journal`, `bad-proposals`, `claim-owner`, `pause`, `underworld`).

## Requirement IDs

P01, W03, W05, W07, O01, O02, O03, O04, D11, D14.
