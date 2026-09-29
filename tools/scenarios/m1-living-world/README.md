# m1-living-world: headless causal scenario

## Question

Does the compiled sidecar keep a persistent living world causally honest end to end: routines act unattended, a strike becomes fire, lost service, and repair, legends stay attributed records, bad proposals are rejected without effect, pause and a mid-catch-up kill never apply time twice, archives survive corruption and restore into a branch, and a headless client's receipts trace back to the observation that started the chain?

## How to run

```sh
bun run --cwd tools/scenarios scenario:m1                                  # build the sidecar, run the story
bun run --cwd tools/scenarios scenario:m1 --skip-build                     # reuse the built sidecar
bun run --cwd tools/scenarios scenario:m1 --positive-control=archive       # must exit non-zero
bun run --cwd tools/scenarios scenario:m1 --positive-control=catch-up      # must exit non-zero
bun run --cwd tools/scenarios scenario:m1 --write-readme                   # story + both controls, rewrites this file
```

The scenario builds the sidecar with `apps/simulation/scripts/build-sidecar.sh`
and runs the compiled binary directly, with no Tauri. Each run uses a fresh
temporary app-data directory (`PANTHEA_APP_DATA_DIR`), so the authored Greek
world is the seed. The harness writes a launch token to the binary's stdin,
keeps stdin open, reads `PANTHEA_PORT` from stdout, and calls the sidecar
over authenticated loopback HTTP. It stops at the first violated invariant,
exits 1, kills every child, and removes its temporary directory. It is not
part of `bun run check`; only the pure helpers in `src/helpers.test.ts` and
`src/report.test.ts` are.

Assertions are about committed world state: the events table and clock row
(read from the store read-only), the decoded frame, and the trace queries.
Waits are bounded polls that name the invariant they wait for, never fixed
sleeps that decide a result. The harness does manipulate wall time and
processes; that is the fault injection, described per step below.

Fault injections, one per negative claim:

- **Machine slept for 50 minutes:** with the sidecar stopped, the harness
  moves the persisted wall cursor back by 3,000,000 ms. The next start sees
  a 50-minute gap and runs startup catch-up.
- **Killed during catch-up:** `SIGKILL` once catch-up has committed at
  least two 60-second chunks.
- **Corrupted archive:** one byte inside stored event data is changed in a
  copy of an export.
- **Malformed, false, and stale proposals:** posted from JSON files in
  `src/fixtures/`.

## Caveat

Not covered:

- **Worship and favor.** Not driven. A fixture proposal from the woodcutter or
  the farmer is rejected as `busy-actor`: their routines commit an action every
  tick and run ahead of fixtures, and an actor may commit one action per tick.
  Zeus is the only actor without a routine, and a deity cannot worship itself.
  The S7 note measures one such rejection. The same starvation means no fixture
  repair that spends planks can commit; the run asserts the owner's unattended
  repair instead.
- **A strike's presentation receipt through the trace query.** The strike's
  chain is asserted through its projection change; the receipt hop is asserted
  on a routine trade (see the S13 note).
- **The packaged desktop app and the view.** No Tauri, no rendering. The client
  modules run headlessly against a polling transport; the Unit 8 view gate is
  separate.
- **The shell's exact forwarding.** The harness polls `GET /frame` every 250 ms
  and forwards a frame when its sequence, status, or session id changes. The
  shell polls once a second.
- **Real sleep, real clock jumps.** The 50-minute gap is a rewritten cursor,
  not a slept machine. Backward clock jumps and gaps over the one-hour cap are
  not driven here.
- **Power loss.** `SIGKILL` stops the process; it does not drop unsynced pages.
- **Disk-full and store errors.** No degraded status is provoked.
- **Reject-before-commit for import staging crashes.** Only a corrupted
  archive is injected, not a crash during import.
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
| S5 tavern income events while destroyed | count | 1 | 0 | 0 |
| S6 planks spent on repair | planks | 1 | 3 | 3 |
| S6 ticks from destruction to repair | ticks | 1 | 5 | 5 |
| S7 legends held | count | 1 | 2 | 2 |
| S8 bad proposals posted | count | 1 | 5 | 5 |
| S9 ticks advanced after resume | ticks | 1 | 2 | 2 |
| S10 chunks committed before kill | chunks | 1 | 2 | 2 |
| S10 ticks applied by second catch-up | ticks | 1 | 2879 | 2879 |
| S10 ticks over cursor seconds (must be 0) | ticks | 1 | 0 | 0 |
| S11 exported event sequence | events | 1 | 12103 | 12103 |
| S11 slots after import, corrupt import, and restore | slots | 1 | 2 | 2 |
| S12 receipts stored | count | 1 | 29 | 29 |
| S12 receipt relay errors (restarts) | count | 1 | 0 | 0 |
| S13 strike chain hops | hops | 1 | 5 | 5 |
| S13 trade chain hops | hops | 1 | 6 | 6 |

## Findings

- **S1 Seed** (0.0 s). Asserts: A fresh data directory loads the authored Greek world across three realms with nothing committed yet. Measured: 15 locations (mortal 10, underworld 3, olympus 2), 3 actors, 3 buildings, sequence 0.
- **S2 Unattended routines** (8.0 s). Asserts: With no external input, routines commit events every tick, and every observation on record is a routine's. Measured: 8 ticks, 30 events, kinds income-earned, resource-consumed, resource-gathered, resource-produced, resource-traded; observations by source {"routine":16}.
- **S3 Strike** (1.1 s). Asserts: A deity's fixture strike commits through the validator: divinity is spent and the combustible tavern ignites, both caused by the strike's observation. Measured: strike committed at sequences 33-34; divinity 10 -> 7; tavern burning at intensity 1.
- **S4 Fire** (2.0 s). Asserts: Fire burns on its own after ignition for the authored number of ticks, destroys the tavern, and disposes its goods through a declared sink; a non-combustible building never ignites. Measured: 2 burn ticks then destroyed at sequence 45 (3 ticks after ignition); disposed [{"resource":"wine","amount":4}]; shop operational; old oak burning.
- **S5 Lost service** (3.0 s). Asserts: A destroyed tavern offers no services and earns no income while the untouched shop keeps earning. Measured: services [] of authored ["drink"]; tavern income events 0, shop 3 over the next ticks.
- **S6 Repair** (2.0 s). Asserts: The tavern's owner repairs it unattended, spending exactly the authored cost in planks; service and income return and the goods lost in the fire stay lost. A fixture repair by an actor with no planks is rejected and adds no progress. Measured: 3 repair steps spent 3 planks (cost 3); tavern operational again 5 ticks after destruction; fixture repair by zeus rejected (insufficient-resources).
- **S7 Legends** (5.1 s). Asserts: A legend linked to a committed event is verified, an unlinked one is a rumor, both are attributed records rather than facts, and a legend linking an unknown event is refused at intake. Measured: verified legend at sequence 68 links evt-9-34; rumor at sequence 73 has no link; unknown link refused (400) with no record; legends in world state: 2.
- **S8 Malformed, false, and stale proposals** (3.0 s). Asserts: Malformed input is refused at intake with no record; a false claim and a stale proposal are recorded as rejections with a reason code; none of them changes the world. Measured: refused at intake (400): invalid JSON, missing observation, self-declared costs; recorded rejections: claim unauthorized-claim, stale strike stale-target; events caused by all five: 0; old oak owner unchanged.
- **S9 Pause across restart** (10.7 s). Asserts: A paused world commits nothing, stays paused through a clean restart, and the paused wall time never becomes catch-up when it resumes. Measured: paused at tick 24, sequence 99; unchanged through 2.5 s, a clean restart with 4 s down, and 2.5 s after; resumed: +2 ticks; operator observations 2.
- **S10 Kill mid catch-up** (0.6 s). Asserts: After a long sleep and a SIGKILL partway through catch-up, restarting applies the rest of the interval once: ticks since the sleep began equal whole seconds of cursor advance, at the kill and after the second catch-up. Measured: gap 3000 s; killed after 2 of 50 chunks (120 ticks); second catch-up applied 2879 ticks; total 2999 ticks = 2999 cursor seconds; 11996 approximate events.
- **S11 Export, corrupt copy, import, restore** (2.9 s). Asserts: An export imports into a new slot; a copy with one changed byte is rejected and creates no slot; restoring the snapshot makes a branch slot holding the same history up to the snapshot while the active world is untouched. Measured: export at sequence 12103; import made 1 slot; corrupted copy rejected (422) with no slot and no staging directory; restore made a second slot; both slots hold 12103 events matching the active history; the active world was at sequence 12115 before the restore and 12115 after.
- **S12 Headless client receipts** (3.8 s). Asserts: The client receipts only events it placed in the viewed realm: every stored receipt was sent by the client, none is for an undrawn kind, the strike, the fire, and a routine trade were receipted in the session they happened in, and a client viewing another realm sends none. Measured: 29 receipts stored by the mortal-realm client ({"resource-traded":23,"building-ignited":2,"building-destroyed":2,"building-repaired":2}); ignition, destruction, and trades receipted; underworld client received frames and sent 0; relay errors during restarts 0.
- **S13 Trace** (0.1 s). Asserts: The strike's chain walks observation, proposal, validation, event, and projection change with the identifiers the fixture posted; a routine trade's chain continues to the presentation receipt the client sent; a rejected proposal's chain ends at its rejection. Measured: strike chain observation -> proposal -> validation -> event -> projection-change (event 33); trade chain observation -> proposal -> validation -> event -> projection-change -> receipt; stale chain observation -> proposal -> validation (stale-target).
- **S1 note.** The fresh world's first frame already carries a catch-up summary (applied 0 ms, skipped 4 ms), which the view would show as a catch-up panel on first launch.
- **S7 note.** A rumor posted for the farmer, whose routine acts every tick, was rejected as busy-actor. Routines are queued ahead of fixtures and an actor commits one action per tick, so fixtures for routine-driven actors lose to the routine. Only zeus has no routine.
- **S13 note.** The strike's chain stops at its projection change. The trace links a proposal to its first committed event only, and a strike's first event is the divinity spend, which the client never draws. The strike's ignition, which the client did receipt (S12), is tied to the strike only by its correlation id in the event log; following that event through the trace query returned found=true with 0 steps. The presentation hop is demonstrated on a routine trade, whose only event is drawn.
- **Positive control `archive`.** The harness skips the byte change, so the "corrupted" copy is a clean export and importing it must be refused. The run exited 1 with: FAIL invariant violated: importing the corrupted copy is rejected -- status 200: the copy was imported into a new slot
- **Positive control `catch-up`.** After the kill, the harness rewinds the persisted cursor to the start of the sleep, so the restart replays time the committed chunks already applied. The run exited 1 with: FAIL invariant violated: after the second catch-up, ticks equal whole seconds of cursor advance (the interval was applied once) -- {"ok":false,"ticksAdvanced":3119,"ticksForCursorAdvance":2999}

## Bottom line

All 13 steps held, on a tree built on commit 01129af. The story ran in 42 s; the whole evidence run, with both controls, took 114 s. Both positive controls exited non-zero, so the assertions they target are live. The compiled sidecar binary was 60 MiB.
