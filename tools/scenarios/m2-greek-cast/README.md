# m2-greek-cast: the M2 causal story against the compiled sidecar

## Question

Does the compiled sidecar carry the M2 causal story end to end with the gods taking turns through the production routing path: Zeus strikes and the witnesses remember, an uninformed god's context has no trace of it, Zeus tells Hera an exaggerated account with a claim, her belief changes how she feels about him with the belief as cause, her next proposal shows it, the destruction traces to the strike, a stale god proposal is rejected, no model is asked during catch-up or replay, memory and relationships survive a restart and a restore, and a SIGKILL after a turn journaled or during inference costs no more than one turn?

## How to run

```sh
bun run --cwd tools/scenarios scenario:m2                                    # build the sidecar, run the scripted story
bun run --cwd tools/scenarios scenario:m2 --skip-build                       # reuse the built sidecar
bun run --cwd tools/scenarios scenario:m2 --positive-control=<name>          # must exit non-zero; names below
bun run --cwd tools/scenarios scenario:m2 --real [--seconds=180]             # both gods through local Ollama; asserts properties, writes real-run.json
bun run --cwd tools/scenarios scenario:m2 --episodes=3 --reasoning-effort=none   # the experience gate on the local baseline, qwen3-8b-4k (set up once: ollama create qwen3-8b-4k -f tools/probes/inference-baseline/Modelfile.qwen3-8b-4k)
bun run --cwd tools/scenarios scenario:m2 --episodes=3 --model=<model> --base-url=https://<host>/v1 [--key-ref=<keyRef>]   # the gate against a hosted endpoint; the key is read once from the Keychain
bun run --cwd tools/scenarios scenario:m2 --write-readme                     # story + every control, rewrites this file from a fresh run and real-run.json
```

Controls: `kill-journal`, `kill-inference`, `chain`, `isolation`, `trace`,
`stale`, `catch-up-inference`, `restore-memory`, `petition-privacy`, and, for the
practice steps and the practice properties of the real run, `thread-reopened`,
`no-progress-advances`, `thread-no-ending`, `obligated-turn-unrecorded`,
`ending-no-consequence`, `practices-missing`, `consequence-no-effect`.

Practice steps (settlement and supplication, scripted gods, the world's real
rules; each reply is a function of the prompt its god was shown, so it names
only what that god could name):

- **S13** A refused demand closes its thread; both remember who refused; the
  repeated demand is rejected no-progress, the world records the refusal, and
  Hera's next prompt says why.
- **S14** A newer account opens a linked successor; Zeus's report naming the
  thread's subject makes no progress while one naming another agent is told;
  he accepts, performs, and the world sees it (standing won, Hera warms).
- **S15** A sworn term is broken and costs the oath penalty; counteroffers run
  out, and a counter restating an earlier offer makes no progress; Hera's
  refusal is remembered.
- **S16** Supplication: terms kept are fulfilled; terms broken cost the wolf
  stake, and the mortal keeps its memory, feelings, and identity.
- **S17** The real run's practice properties (`src/practice-analysis.ts`) hold
  over the whole scripted run. A practice control breaks the data first and the
  property it targets must fail; `src/practice-analysis.test.ts` holds the same
  controls as unit tests.

The transcript (`src/transcript.ts`) shows each thread's cause, participants,
moves, ending, and recorded changes, the threads open at the end with their age
and what each waits on, every move judged no progress, and a classification of
each turn an obligated god takes while its obligation is open (R12; an
acceptance binds, so there is no renegotiation class, and bargaining is for a
thread still open): the action the term calls for, committed, is *performed*; a
turn that did something else is *waited for a named event* when its prompt names
what stops it (the digest's UNPERFORMABLE obstacle, or no mortal at the place a
legend is to be told); every other turn, an attempt to bargain over the accepted
thread included, is *knowingly risked breach*, since the obligation led the
prompt.

The scenario builds the sidecar with `apps/simulation/scripts/build-sidecar.sh`
and runs the compiled binary directly, with no Tauri, extending the
[M1 harness](../m1-living-world/README.md): the same sidecar driver, store
reads, bounded waits, and positive-control pattern. Each run uses a fresh
temporary app-data directory. The only scripted piece is the model provider: a
loopback OpenAI-compatible endpoint the sidecar reaches through its production
routing path, selected by the launch config line the harness sends. It answers each god from a
queue the harness fills, or from a policy that is a pure function of the prompt
the god was shown (Hera's), and it records every request with when it arrived.
Stage-setting that is not a god's choice (moving the farmer to the tavern,
moving Hera while a turn is in flight) is posted as fixture proposals over
`/proposals`. Everything the sidecar serves is read through its API; facts no
endpoint exposes (the proposal journal, event payloads, the trace's requests,
a restored slot's state) are read from the store, read-only.

Fault injections, one per negative claim:

- **SIGKILL after a turn journaled:** the provider holds Zeus's reply, the
  world is paused, the reply is released so the turn journals, and the
  sidecar is killed with the proposal pending.
- **SIGKILL during inference:** the provider holds Hera's reply and the
  sidecar is killed while the request is in flight.
- **Half-hour gap:** with the sidecar stopped, the harness moves the persisted
  wall cursor back 1,800,000 ms; the restart's catch-up applies it.
- **Stale proposal:** Hera's turn is held while a fixture moves her.
- **Hostile archive:** the projection row of an export has Hera's memory and
  feeling dropped and its content hash recomputed.

## Caveat

Not covered:

- **Reasoning quality.** The scripted run proves the causal plumbing; it says
  nothing about whether a model chooses well. The real run asserts properties
  a valid run must have, not that the episodes are good: that is the owner's
  experience gate.
- **Causation in the real run.** "A changed next action" compares a god's
  action before and after its first belief or feeling. A model that varies
  its choices anyway satisfies it; it shows the chain is wired through to a
  real model's context, not that the belief caused the change. The scripted
  run shows causation with a policy that depends on the prompt.
- **The pending-proposal gate at process level.** The service dispatches a turn
  only after a live tick, and a tick consumes every pending proposal, so a
  pending proposal and a new turn for its god cannot coexist except across a
  pause. S2 asserts what is observable there (no request while paused, one
  commit after); the gate itself is unit-tested in
  `apps/simulation/src/agents.test.ts`.
- **The catch-up window's edge.** The harness reads the sidecar's
  catch-up-started and catch-up-finished lines through a pipe; a request within
  25 ms before the finish line is not judged. A live tick after a catch-up cannot
  land that close in practice, and the `catch-up-inference` control shows a
  request inside the window is caught.
- **Power loss.** `SIGKILL` stops the process; it does not drop unsynced pages.
- **One turn at a time, two gods.** Scheduling, fairness, and cooldowns are
  Unit 10, not measured here.
- **Model routing settings and credentials.** The routing config is a file the
  operator names; the settings view and credential storage are Unit 3.
- **The packaged desktop app and the view.** No Tauri, no rendering.

## Environment

| Field | Value |
| --- | --- |
| Hardware | Apple M1 Pro |
| Memory | 17179869184 |
| OS | macOS 15.7.9 (24G830) |
| Bun | 1.4.2 |
| Tauri | 2.12.0 |
| Three.js | 0.185.1 |
| Three Flatland | 0.1.0-alpha.10 |

## Results

| Metric | Unit | Samples | p50 | p95 |
| --- | --- | --- | --- | --- |
| S1 idle turns answered | requests | 1 | 5 | 5 |
| S2 requests while paused with the proposal pending | requests | 1 | 0 | 0 |
| S5 hera prompts checked | prompts | 1 | 3 | 3 |
| S10 catch-up gap applied | s | 1 | 1799 | 1799 |
| S11 provider requests during archive replay | requests | 1 | 0 | 0 |

## Findings

- **S1 Gods take idle turns through the production path** (5.0 s). Asserts: With the launch config line pointing at the scripted provider, the sidecar asks each god what to do; each prompt shows that god where it stands; a wait journals nothing; the trace records each request; the world is running, not model-degraded. Measured: 5 idle turns (zeus 2, hera 3) answered wait; trace holds 5 requests, none with a proposal; status running.
- **S2 SIGKILL after a god's turn journaled** (5.1 s). Asserts: A god's turn journaled and then SIGKILLed before any tick is still pending after the restart, with the trace linking it to its request; while it waits no god is asked anything; once the world runs it commits exactly once; and only then does the god take another turn. Measured: zeus's legend journaled while paused and SIGKILLed still pending (run at tick 7 after the restart); after the restart 0 requests in 2.5 s while paused; after resume it committed once (1 legend-recorded), then zeus was asked again (request 7).
- **S3 SIGKILL during inference** (7.0 s). Asserts: A god's turn SIGKILLed while the provider holds its reply journals nothing and leaves no request with a proposal; after the restart the god reasons afresh and exactly one proposal commits. Measured: hera's turn (request 8) killed in flight: no journal row, no trace row; after the restart she was asked again (request 9) and exactly 1 legend committed.
- **S4 Zeus strikes the tavern; witnesses remember** (13.0 s). Asserts: Zeus, moved by scripted turns from Olympus to the tavern, strikes the farmer's tavern through a model proposal; the ignition records the strike and Zeus; exactly the two present, Zeus and the farmer, remember it, each citing the ignition event, with the harm attributed to Zeus and the farmer as its target; Hera and the woodcutter, elsewhere, do not; the farmer now holds a grudge. Measured: zeus struck from the tavern (proposal proposal-1ed0bad6-df7a-4c94-920c-8b7997dd60bd); ignition evt-28-118 cites the strike; witnesses farmer and zeus; the farmer's feeling toward Zeus: affinity -2, grudge 1.
- **S5 Knowledge isolation** (6.1 s). Asserts: Through the strike and the tavern's destruction, none of Hera's prompts carries any trace of it: not the ignition or destruction event, not the strike's observation, not the tavern; while Zeus's own prompts after it do carry the ignition. Measured: 3 of Hera's prompts through the strike and destruction (evt-30-136) carry none of 6 traces; Zeus's prompts after the strike carry the ignition.
- **S6 Zeus tells Hera; her feeling changes, with the belief as cause** (9.9 s). Asserts: Zeus walks back to Olympus and, through a model proposal citing the ignition he witnessed, tells Hera an exaggerated account with a claim; Hera's belief is attributed to Zeus, stores his words as told (they differ from what happened), and shifts her affinity toward Zeus by exactly one relationship-changed event that cites that belief; no legend is recorded. Measured: zeus told hera "I burned the whole agora to ashes, and I would do it again." citing evt-28-118; her belief evt-44-207 is attributed to zeus; relationship-changed evt-44-208 (affinity -1) cites it; chain building-ignited > report-told > memory-recorded > relationship-changed.
- **S7 Hera's next proposal reflects it** (1.0 s). Asserts: Hera, shown her belief and her feeling toward Zeus in her prompt, answers with a proposal she did not make before: a report to Zeus whose claim names the agent her belief names; the turn before, with no belief in her prompt, she waited; the proposal commits, and its request is in the trace. Measured: hera waited (request 41) without the belief and answered request 43 with a report to zeus (claim agent zeus, no citation); zeus holds a belief attributed to hera.
- **S8 Destruction traces to the strike** (0.0 s). Asserts: Following the tavern's destruction in the trace walks back through its ignition to the strike's proposal, model request, and observation; the destruction cites the ignition event. Measured: destruction evt-30-136: observation > model-request > proposal > validation > event > projection-change > event > projection-change; ignition evt-28-118 is the strike proposal-1ed0bad6-df7a-4c94-920c-8b7997dd60bd's event.
- **S9 Stale god proposal rejected** (5.0 s). Asserts: A god's realm transition (which pins the god and its location), built from a snapshot the world has since moved past (the god itself was moved while the model thought), is rejected as stale-target and causes no event; the same proposal in an unchanged world commits. Measured: held turn in an unchanged world: committed; the same realm transition after hera was moved: rejected (stale-target), no event.
- **S10 No inference in catch-up; memory survives the restart** (1.1 s). Asserts: After a clean stop and a half-hour gap, the startup catch-up runs, and the provider receives no request between the sidecar's own catch-up-started and catch-up-finished lines; turns resume after it; every actor's memories and relationships equal what they were before the restart. Measured: 1799 s applied by a catch-up that ran 224 ms; 0 provider requests inside it; the first request after it at +793 ms; 4 actors' memories and 3 relationships unchanged.
- **S11 Export, import, restore keep memory and relationships** (3.0 s). Asserts: With the world paused, exporting, importing, and restoring an archive asks no model; the imported slot and the restored branch hold the same memories and relationships as the live world; the branch explains Hera's relationship change from its events (ignition, report, belief, change) with no trace rows; an archive with Hera's memory dropped and its hash recomputed is refused as corrupt and makes no slot. Measured: paused at 50 provider requests and still 50 after two imports and a restore (one refused); imported slot and branch hold the live memories (4 actors) and 3 relationships; the branch explains the change as building-ignited > report-told > memory-recorded > relationship-changed with 0 trace rows.
- **S2 note.** The service dispatches a turn only after a live tick, and a tick consumes every pending proposal first, so at process level a pending proposal and a new turn for its god cannot coexist except across a pause; the pending-proposal gate itself is unit-tested in apps/simulation/src/agents.test.ts.
- **S10 note.** A request within 25 ms before the finish line is not judged: the harness reads the line through a pipe, so its timestamp can trail the sidecar's print. The service only dispatches after a live tick, and the loop skips ticks during a catch-up, so requests at that distance would be the first tick after it.
- **S11 note.** Import rebuilds the world from the archive's genesis and event log and requires it to equal the archived projection, so an archive with memory dropped cannot reach the branch comparison: it is refused first. The comparison itself, which a dropped memory fails, is unit-tested in src/checks.test.ts.
- **Positive control `kill-journal`.** After the kill, the harness deletes the pending proposal from the journal, as if the service had kept a turn's proposal only in memory, so nothing runs it after the restart. The run exited 1 with: FAIL invariant violated: the killed turn's proposal ran after the restart -- not observed within 20000 ms
- **Positive control `kill-inference`.** The provider answers the re-asked turn with two legends instead of one, so two proposals commit where exactly one is required. The run exited 1 with: FAIL invariant violated: exactly one proposal committed for the killed and re-asked turn -- 2 legends
- **Positive control `chain`.** Zeus's report carries no claim, so Hera's belief has no consequence and her relationship toward Zeus does not change. The run exited 1 with: FAIL invariant violated: Hera's belief changed her relationship: a relationship-changed event cites it -- none found: the report carried no claim, so it taught her nothing to feel
- **Positive control `isolation`.** The harness adds the strike's ignition to the last prompt Hera was shown before the check, as if the event had leaked into her context. The run exited 1 with: FAIL invariant violated: no prompt Hera was shown carries a trace of the strike -- found evt-28-118, the-tavern, building-ignited
- **Positive control `trace`.** The harness follows the farmer's fixture move instead of the tavern's destruction, an event no strike caused, so the chain has no model request. The run exited 1 with: FAIL invariant violated: the trace starts with the strike's observation, model request, proposal, and validation -- observation > proposal > validation > event > projection-change
- **Positive control `stale`.** The harness skips the fixture that moves Hera while her turn is in flight, so the world is unchanged and the proposal commits instead of being rejected. The run exited 1 with: FAIL invariant violated: the proposal built before the world moved is rejected as stale-target -- committed undefined
- **Positive control `catch-up-inference`.** The harness sends the provider a request inside the restart's catch-up window, as a god's turn would. The run exited 1 with: FAIL invariant violated: no provider request during the catch-up -- 1 requests inside it
- **Positive control `restore-memory`.** The harness drops Hera's memory and feeling from the export it is about to restore and recomputes its hash. Import rebuilds the world from the archive's event log and requires it to equal the archived projection, so the archive is refused at the import step, before any comparison of the restored branch. The run exited 1 with: FAIL invariant violated: importing the export succeeds -- 422 {"ok":false,"error":"archive projections row is not what its genesis and event log produce"}
- **Real inference (llama3.2-3b-4k on Apple M1 Pro, 180 s, 180 ticks, 2026-09-30T10:13:22.819Z).** 75 requests: 64 answered (64 native, 0 repaired), 11 exhausted. Latency p50 1569 ms, p95 3590 ms. Prompt p50 3912 characters, max 4752. Proposals {"move":22,"legend":3,"realm-transition":16,"report":8}; outcomes {"committed":49}. Frames showed model-degraded in 14% of polls.
- **Real inference, exhaustion.** 5 x invalid-output: content: content must be 1 to 280 characters; 5 x invalid-output: to: to must be one of the ids you can see: great-hall; 1 x invalid-output: linkedEventId: linkedEventId must be one of the ids you can see: evt-8-28, evt-80-338.
- **Real inference, properties.** held: valid actions (49 proposals, all god actions, none rejected as malformed); held: perception compliance (every id named by 49 proposals was in the prompt behind it); held: relationship change with provenance (3 changes, 3 explained from the log alone, e.g. report-told > memory-recorded > relationship-changed); held: changed next action (hera: realm-transition:olympus-gate before its first belief, realm-transition:mountain-path after (changed); zeus: report:hera before its first belief, report:hera,zeus,hera after (changed)).
- **Real inference, limits.** One short run of a 3B model on one machine, unscripted and therefore different every time; the numbers are a record of this run, not a benchmark. It does not show that a belief caused a changed action, that the episodes are good, or how a longer run behaves.

## Bottom line

All 11 scripted steps held on the tree this README was committed with. The story ran in 56 s; the whole evidence run, with every control, took 392 s. All 8 positive controls exited non-zero, so the assertions they target are live. The compiled sidecar binary was 60 MiB.
