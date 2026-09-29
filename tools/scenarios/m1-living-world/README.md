# m1-living-world: headless causal scenario

## Question

Does the compiled sidecar keep a persistent living world causally honest end to end: routines act unattended, a strike becomes fire, lost service, and repair, worship grants a favor that expires, legends stay attributed records, bad proposals are rejected without effect, pause and a kill mid catch-up past the cap never applies time twice, an accepted proposal survives a kill, archives survive corruption and restore into a branch, and the strike's ignition traces from its observation through the headless client's presentation receipt?

## How to run

```sh
bun run --cwd tools/scenarios scenario:m1                                  # build the sidecar, run the story
bun run --cwd tools/scenarios scenario:m1 --skip-build                     # reuse the built sidecar
bun run --cwd tools/scenarios scenario:m1 --positive-control=archive       # must exit non-zero
bun run --cwd tools/scenarios scenario:m1 --positive-control=catch-up      # must exit non-zero
bun run --cwd tools/scenarios scenario:m1 --positive-control=journal       # must exit non-zero
bun run --cwd tools/scenarios scenario:m1 --write-readme                   # story + every control, rewrites this file
```

The scenario builds the sidecar with `apps/simulation/scripts/build-sidecar.sh`
and runs the compiled binary directly, with no Tauri. Each run uses a fresh
temporary app-data directory (`PANTHEA_APP_DATA_DIR`), so the authored Greek
world is the seed. The harness writes a launch token to the binary's stdin,
keeps stdin open, reads `PANTHEA_PORT` from stdout, and calls the sidecar
over authenticated loopback HTTP. Every `POST /proposals` carries a
producer-generated `proposalId`; outcomes are read through
`/trace/proposal?id=` and `/trace/event?id=`. The run stops at the first
violated invariant, exits 1, kills every child, and removes its temporary
directory. It is not part of `bun run check`; only the pure helpers in
`src/helpers.test.ts` and `src/report.test.ts` are.

Assertions are about committed world state: the events table, clock row,
proposal journal, and catch-up progress (read from the schema version 3 store
read-only), the decoded frame, and the trace queries. Waits are bounded polls
that name the invariant they wait for, never fixed sleeps that decide a
result. The harness does manipulate wall time and processes; that is the fault
injection, described per step below.

Fault injections, one per negative claim:

- **Machine slept for three hours:** with the sidecar stopped, the harness
  moves the persisted wall cursor back by 10,800,000 ms. The next start sees a
  gap of three times the one-hour cap and runs startup catch-up.
- **Killed during catch-up:** `SIGKILL` once catch-up has committed at least
  two 60-second chunks of the capped backlog.
- **Killed with a proposal accepted and no tick run:** `SIGKILL` right after a
  `202`, then the cursor is moved back two minutes so the restart's catch-up
  is what runs the proposal.
- **Corrupted archive:** one byte inside stored event data is changed in a
  copy of an export.
- **Paused world:** an operator `/pause` holds the world still while a fixture
  repair is chosen and accepted.
- **Malformed, false, and stale proposals:** posted from JSON files in
  `src/fixtures/`.

## Caveat

Not covered:

- **The packaged desktop app and the view.** No Tauri, no rendering. The client
  modules run headlessly against a polling transport. The packaged app is
  covered by [m1-packaged-shell](../m1-packaged-shell/README.md) and the Unit 8
  view gate.
- **The shell's exact forwarding.** The harness polls `GET /frame` every 250 ms
  and forwards a frame when its sequence, status, or session id changes. The
  shell polls once a second.
- **Real OS sleep and wake, and clock jumps.** Both sleeps are a rewritten
  cursor in a stopped store, not a slept machine. Backward clock jumps are not
  driven.
- **Power loss.** `SIGKILL` stops the process; it does not drop unsynced pages.
- **Disk-full and store errors.** No degraded status is provoked.
- **Import staging crashes.** Only a corrupted archive is injected, not a crash
  during import.
- **Trace records in archives.** Archives carry world state and the proposal
  journal with each entry's outcome, but not trace records. The run compares
  journals and event histories across export, import, and restore; it does not
  (and cannot) compare causal trace, so a restored branch has none for history
  before the restore.
- **The three W03 catch-up summary limits.** Major outcomes from before a
  restart are not carried into a backlog's summary; archives do not carry
  in-flight catch-up progress; a kill between the final catch-up commit and the
  next frame loses that summary. None is provoked here.
- **Time between a kill and its restart.** The cap bounds the remaining
  backlog, so seconds that pass while the service is down are new gap, applied
  once on top of the capped total. S12 measures that extra (0 s in the recorded
  run) and bounds it by the measured downtime; it does not assert an exact total
  of one cap.
- **M2 and later.** No model proposals, memory, or generated behaviors; the
  causal chain is the M1 part of O04 only.
- **Balance.** Fire spread, economy, and repair numbers are observed, not
  tuned or asserted beyond the rules in the content files.

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
| S1 seed locations | count | 1 | 15 | 15 |
| S1 seed actors | count | 1 | 3 | 3 |
| S1 seed buildings | count | 1 | 3 | 3 |
| S2 unattended events | count | 1 | 30 | 30 |
| S3 divinity spent | divinity | 1 | 3 | 3 |
| S4 ticks from ignition to destruction | ticks | 1 | 3 | 3 |
| S5 tavern income events during the fire | count | 1 | 0 | 0 |
| S5 shop income events during the fire | count | 1 | 3 | 3 |
| S6 planks spent on repair | planks | 1 | 3 | 3 |
| S6 ticks from destruction to repair | ticks | 1 | 5 | 5 |
| S7 divinity gained from worship | divinity | 1 | 1 | 1 |
| S7 favor duration | ticks | 1 | 10 | 10 |
| S7 favored gather yield over base | resource | 1 | 1 | 1 |
| S8 legends held | count | 1 | 2 | 2 |
| S9 bad proposals posted | count | 1 | 5 | 5 |
| S10 ticks advanced after resume | ticks | 1 | 2 | 2 |
| S11 target tick of the killed proposal | tick | 1 | 36 | 36 |
| S12 chunks committed before kill | chunks | 1 | 2 | 2 |
| S12 ticks applied by the whole backlog | ticks | 1 | 3600 | 3600 |
| S12 seconds discarded beyond the cap | s | 1 | 7200 | 7200 |
| S12 ticks over cursor seconds (must be 0) | ticks | 1 | 0 | 0 |
| S13 exported event sequence | events | 1 | 15025 | 15025 |
| S13 slots after import, corrupt import, and restore | slots | 1 | 2 | 2 |
| S14 receipts stored | count | 1 | 36 | 36 |
| S14 receipt relay errors (restarts) | count | 1 | 0 | 0 |
| S15 strike ignition chain hops | hops | 1 | 6 | 6 |
| S15 worship chain hops | hops | 1 | 6 | 6 |
| S15 trade chain hops | hops | 1 | 6 | 6 |

## Findings

- **S1 Seed** (0.0 s). Asserts: A fresh data directory loads the authored Greek world across three realms with nothing committed yet, and its first frame carries no catch-up summary. Measured: 15 locations (mortal 10, underworld 3, olympus 2), 3 actors, 3 buildings, sequence 0; first frame has no catch-up summary.
- **S2 Unattended routines** (8.0 s). Asserts: With no external input, routines commit events every tick, and every observation on record is a routine's. Measured: 8 ticks, 30 events, kinds income-earned, resource-consumed, resource-gathered, resource-produced, resource-traded; observations by source {"routine":16}.
- **S3 Strike** (1.0 s). Asserts: A deity's fixture strike commits through the validator: divinity is spent and the combustible tavern ignites, both caused by the strike's observation. Measured: strike committed at sequences 31-32; divinity 10 -> 7; tavern burning at intensity 1.
- **S4 Fire** (2.0 s). Asserts: Fire burns on its own after ignition for the authored number of ticks, destroys the tavern, and disposes its goods through a declared sink; a non-combustible building never ignites. Measured: 2 burn ticks then destroyed at sequence 45 (3 ticks after ignition); disposed [{"resource":"wine","amount":4}]; shop operational; old oak burning.
- **S5 Lost service** (0.0 s). Asserts: A burning and then destroyed tavern offers no services and earns no income while the untouched shop keeps earning. The operator pauses the world once the tavern is down. Measured: world paused with the tavern destroyed: services [] of authored ["drink"]; from ignition to destruction tavern income events 0, shop 3.
- **S6 Repair** (6.0 s). Asserts: A fixture repair by an actor holding planks, accepted while the world is paused, stays pending until ticking resumes and then commits, taking the actor's slot from its routine. Repair spends exactly the authored cost in planks; service and income return and the goods lost in the fire stay lost. Measured: 3 repair steps spent 3 planks (cost 3); the fixture repair by farmer was accepted while paused, stayed pending through 1.5 s with no tick (a retry reported pending), and committed once resumed; tavern operational again 5 ticks after destruction.
- **S7 Worship and favor** (11.0 s). Asserts: A fixture worship by a mortal with a routine commits (its routine yields the slot): the deity's divinity rises by the authored gain, the worshiper holds a favor with its source and duration, the favor raises the worshiper's gather yield while it lasts, and the yield returns to normal once it expires. Measured: worship at sequence 66 (tick 17): divinity 7 -> 8; favor from zeus expires at tick 27 (10 ticks); gather 3 at tick 22 inside the window, 2 at tick 27 after it.
- **S8 Legends** (3.0 s). Asserts: A legend a mortal tells about a committed event is verified, one told with no link is a rumor, both are attributed to their narrators and are records rather than facts, and a legend linking an unknown event is refused at intake. Measured: verified legend by the woodcutter at sequence 109 links evt-9-32; rumor by the farmer at sequence 110 has no link; both committed although both narrators have routines; unknown link refused (400) with no record; legends in world state: 2.
- **S9 Malformed, false, and stale proposals** (3.0 s). Asserts: Malformed input is refused at intake with no journal entry and no record; a false claim and a stale proposal are journaled and recorded as rejections with a reason code; none of them changes the world. Measured: refused at intake (400): invalid JSON, missing observation, self-declared costs; recorded rejections: claim unauthorized-claim, stale strike stale-target; events caused by all five: 0; old oak owner unchanged.
- **S10 Pause across restart** (10.6 s). Asserts: A paused world commits nothing, stays paused through a clean restart, and the paused wall time never becomes catch-up when it resumes. Measured: paused at tick 33, sequence 132; unchanged through 2.5 s, a clean restart with 4 s down, and 2.5 s after; resumed: +2 ticks; operator observations 2 -> 4.
- **S11 Durable proposal across a kill** (2.1 s). Asserts: A proposal accepted over /proposals and then SIGKILLed before any tick is still in the journal on restart, runs exactly once on a catch-up tick with a recorded outcome, and a retry of its proposalId reports that outcome without running it again. Measured: accepted at clock tick 35, SIGKILLed while pending; after restart it ran on catch-up tick 36 (one approximate legend-recorded event), outcome committed; a retry returned committed, changed content 409.
- **S12 Kill mid catch-up past the cap** (0.8 s). Asserts: After a three hour sleep, catch-up discards the excess over the one-hour cap in its own commit before any chunk. A SIGKILL partway through and a restart then apply the rest of the capped backlog once: the restarted frame's summary reports the whole backlog, and ticks since the discard equal whole seconds of cursor advance. Measured: sleep 3 h, cap 1 h: excess 2.000 h discarded before the chunks; killed after 2 chunks (120 ticks); restarted summary applied 3600 ticks (the cap plus 0 s of downtime), skipped 2.000 h; 14400 approximate events.
- **S13 Export, corrupt copy, import, restore** (2.8 s). Asserts: An export imports into a new slot; a copy with one changed byte is rejected and creates no slot; restoring the snapshot makes a branch slot holding the same history and the same proposal journal (ids, order, terminal outcomes) up to the snapshot while the active world is untouched. Measured: export at sequence 15025; import made 1 slot; corrupted copy rejected (422) with no slot and no staging directory; restore made a second slot; both slots hold 15025 events and 8 journal entries matching the active world; the active world was at sequence 15037 before the restore and 15037 after.
- **S14 Headless client receipts** (2.9 s). Asserts: The client receipts only events it placed in the viewed realm: every stored receipt was sent by the client, none is for an undrawn kind, the strike, the fire, the worship, and a routine trade were receipted in the session they happened in, and a client viewing another realm sends none. Measured: 36 receipts stored by the mortal-realm client ({"resource-traded":30,"building-ignited":2,"building-destroyed":2,"building-repaired":1,"worship-performed":1}); ignition, destruction, worship, and trades receipted; underworld client received frames and sent 0; relay errors during restarts 0.
- **S15 Trace** (0.0 s). Asserts: Every chain is walkable from the identifiers the producer used: a rejected proposal ends at its rejection, a routine trade and a worship reach the presentation receipt the client sent, and the strike's own ignition walks observation, proposal, validation, event, projection change, and the client's presentation receipt. Measured: stale chain observation -> proposal -> validation (stale-target); trade chain and worship chain each end at the client's receipt; strike from its proposal: observation -> proposal -> validation -> event -> projection-change -> event -> projection-change -> receipt; strike ignition chain observation -> proposal -> validation -> event -> projection-change -> receipt (event sequence 32, receipt session session-a5f8c510...).
- **Positive control `archive`.** The harness skips the byte change, so the "corrupted" copy is a clean export and importing it must be refused. The run exited 1 with: FAIL invariant violated: importing the corrupted copy is rejected -- status 200: the copy was imported into a new slot
- **Positive control `catch-up`.** After the kill, the harness rewinds the persisted cursor to where the chunks began, so the restart replays time the committed chunks already applied. The run exited 1 with: FAIL invariant violated: after the second catch-up, ticks since the discard equal whole seconds of cursor advance (nothing was applied twice) -- {"ok":false,"ticksAdvanced":3720,"ticksForCursorAdvance":3600}
- **Positive control `journal`.** After the kill, the harness deletes the accepted proposal from the journal, as if the service had kept it only in memory, so nothing consumes it after the restart. The run exited 1 with: FAIL invariant violated: the accepted proposal was consumed after the restart -- not observed within 5000 ms

## Bottom line

All 15 steps held, on a tree built on commit 9bfd30c. The story ran in 53 s; the whole evidence run, with every control, took 200 s. All 3 positive controls exited non-zero, so the assertions they target are live. The compiled sidecar binary was 60 MiB.
