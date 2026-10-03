# catchup-bench

## Question

One simulated hour of catch-up took about 17 s with the 20-mortal world and about 2.3 s with 2 mortals. The targets are **at most 5 s per hour (stretch 3 s)** and **every chunk under 250 ms**, so the service can run it on wake without a visible stall. Where does the time go, and which of the suspected causes are real?

## Method

- **World.** The Unit 7 pack (7 gods, 20 mortals) frozen as `fixtures/unit7-pack.json`, cut from main `d566975` by `src/snapshot-pack.ts`. The file's sha256 is checked on every load (`PACK_SHA256`), so a changed fixture is an error, not a different benchmark. Biome ignores the fixture and the results.
- **Run.** One hour is 3,600 ticks, 60 chunks of 60 ticks, which is the world's own `catchUpChunkMs`. It runs through the real `runCatchUp` on an on-disk SQLite store in the system temp directory (WAL, `synchronous=NORMAL`, as production opens it), with the trace tables in the same file. The seed is fixed (`SEED = 20261003`).
- **Configurations.** 4 mortals and 20 mortals (the first N mortals in file order, all 7 gods, the buildings of dropped mortals removed), each from a **fresh** world and from an **aged** one: aged means 6 real one-hour catch-ups first, then the measured hour on a copy of that store. Five repetitions each; every table reports the **median**.
- **Two ways of measuring, so the instrumentation cannot move the headline.**
  - `runEndToEnd` runs the real `runCatchUp` with only an `onChunkCommitted` callback that notes the time at each chunk boundary. Its total and chunk gaps are the headline numbers.
  - `runPhases` runs the same hour through `src/mirror.ts`, a copy of the chunk loop with a clock around each step, over a store, reducers, and trace database wrapped by `src/instrument.ts` (every SQL statement is timed into a category by its text; the transaction body is timed apart from the whole call; the reducers, the codec, and `JSON.parse`/`stringify` of projection-sized strings are timed). Nothing in `apps/` or `packages/` is edited to be measured, and nothing is imported by production code. `measure.test.ts` requires the mirror to produce the **same event stream and the same final projection** as the real function, so it does the same work. Its hour is a little longer than the real one (the clock reads); the table shows both.
  - `profile.ts` runs one hour of the real function in a child process under `bun --cpu-prof` and reads the profile back by function and by phase. It sees inside `stepWorldTick` and inside the native SQLite calls, which a timer around the whole call cannot.
- **Counts.** Rows and payload bytes added to the log and the trace, projection size, WAL peak (sampled at each chunk boundary), and database file growth.
- **Identity.** Three digests of what a run leaves in the store, with the ids minted fresh each run (observations, proposals) renamed in order of first appearance and wall-clock `recorded_at` left out: the whole event log, the whole trace (every observation, outcome, and link, in insert order), and the stored projection. `src/fingerprint.ts` records them for three worlds and compares later runs against the recorded ones; `results/fingerprint-baseline.json` is the baseline. Two runs of the same world agree exactly or not at all (checked), so any difference is a real change in what was written.

## How to run

```sh
cd tools/probes/catchup-bench
bun run bench                                    # the full matrix, 5 reps, writes nothing
bun run bench -- --label=after --out=results/after.json   # also writes after.json and after.md
bun run bench -- --reps=3 --mortals=20 --worlds=aged --aged-hours=6
bun run bench:profile -- --mortals=20 --world=aged --aged-hours=6 --out=results/profile-after-aged.md
bun run src/pragmas.ts --mortals=20 --aged-hours=4        # what the commit overhead is
bun run src/fingerprint.ts --compare=results/fingerprint-baseline.json   # exits 1 if anything differs
bun test                                         # the harness's own tests
```

A full matrix takes about 25 minutes. The 5 s sleep threshold is untouched.

## Environment

Apple M1 Pro, 16 GB, macOS 15.7.9, Bun 1.4.2, internal SSD, run on 2026-10-03 on branch `perf/catchup-bench` at its first commit (code identical to main `d566975`). Per-run noise: one 20-mortal aged repetition took 44 s against a 22 s median (another process was using the disk); medians are reported for that reason.

## Results: baseline (main d566975)

One hour of catch-up, median of 5. "Chunk gap" is the time between chunk-commit callbacks (compute, commit, and the event-loop yield); "held" is compute plus commit for a chunk, from the instrumented run.

| Mortals | World | Hour | Range | Median chunk gap | Worst chunk gap | Median chunk held | Worst chunk held | Events |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | fresh | 0.91 s | 0.86–1.04 | 12.8 ms | 29.6 ms | 13.6 ms | 33.1 ms | 29,896 |
| 4 | aged (6 h) | 2.88 s | 2.76–3.25 | 46 ms | 432 ms | 46.6 ms | 133 ms | 29,912 |
| 20 | fresh | **4.96 s** | 4.78–5.02 | 81 ms | 122 ms | 85.5 ms | 136 ms | 96,909 |
| 20 | aged (6 h) | **22.5 s** | 22.0–44.2 | **355 ms** | **1,466 ms** | 349 ms | 1,014 ms | 95,457 |

The 17.4 s in the problem statement is a 20-mortal world with some history; a fresh 20-mortal world is already at the 5 s line, and an aged one is four times over it. **The aged 20-mortal world is the case to fix**, and the target is judged on it. Every chunk is under 250 ms only for the fresh worlds.

### Where an hour goes: 20 mortals

Median ms per hour from the instrumented run (`results/baseline.md` has all four configurations). The first block partitions the hour; the second splits the commit.

| Phase | Fresh ms | Fresh share | Aged ms | Aged share | Entries |
| --- | --- | --- | --- | --- | --- |
| routine planning (`buildRoutineQueue`) | 1,044 | 20% | **8,315** | **36%** | 3,660 |
| `stepWorldTick` (validate, apply, needs, memory, perception, practice and petition judging) | 689 | 13% | 1,071 | 5% | 3,600 |
| event-list recopy | 9 | 0.2% | 11 | 0% | 3,600 |
| screen observations | 12 | 0.2% | 33 | 0.1% | 60 |
| read pending external proposals | 5 | 0.1% | 9 | 0% | 60 |
| **chunk commits** | 3,286 | 64% | **13,481** | **58%** | 60 |
| ending commit (cursor, summary) | 106 | 2% | 187 | 0.8% | 1 |
| event-loop yields | 2 | 0% | 75 | 0.3% | 59 |
| *instrumented hour* | 5,158 | | 23,262 | | |
| *inside the commit:* event rows | 362 | 7% | 469 | 2% | 96k |
| projection row (SQL, decode, encode, JSON, and the reducer's 96k `applyEvent` calls) | 161 | 3.1% | 407 | 1.7% | 61 |
| trace writes: the whole `onCommitted` callback | 1,097 | 21% | 4,210 | 18% | 61 |
| of which trace SQL statements (observations, outcomes, links) | 804 | 16% | 3,713 | 16% | 268k |
| **commit overhead: BEGIN, COMMIT, WAL write, checkpoints** | **1,701** | **33%** | **8,691** | **37%** | 61 |

(The rows under "inside the commit" overlap with the commit's total; shares are of the instrumented hour.)

The CPU profile agrees (`results/profile-baseline-aged.md`, `profile-baseline-fresh.md`). Aged: routine planning 36%, transaction control 31%, trace JS and SQL 24%, `runTick` 3%, event rows 2%, projection 1.3%, the summary 0.9%, practice judging 0.8%, needs 0.7%.

### What was written

| Rows added in the hour (20 mortals) | Count | Bytes |
| --- | --- | --- |
| events | 96,909 fresh, 95,457 aged | 27.3 MiB, 28.0 MiB |
| trace observations | 72,000 | 13.7 MiB |
| trace proposal outcomes | 72,000 | 17.5 MiB |
| trace outcome-event links | 50,716 fresh, 53,903 aged | |
| projection row | 1 | 221 KiB fresh, 867 KiB aged |
| WAL peak | 10.4 MiB fresh, 18.7 MiB aged | |
| database file growth | 110 MiB fresh, 112 MiB aged | |

A routine proposal is **one observation, one outcome, and usually one link**, every tick for every mortal, whether or not it changes anything.

## Findings

Each of Oracle's suspects, against the numbers (aged 20-mortal hour unless said otherwise):

| Suspect | Measured | Verdict |
| --- | --- | --- |
| **Trace SQL and event SQL** (about 72k routine proposals an hour, each with an observation, an outcome, and link rows) | event rows 2%; trace writes 18% (4.2 s, of which 3.7 s is 271k SQL statements at 14 µs each). In the CPU profile, **the per-observation `SELECT`** that `recordObservation` runs before every insert (to detect a conflicting id) is about 1.5 s of the 5.6 s it puts in `traceWorldTick`. | **Real, third in size** (after the scans and the checkpoints). Worth doing, but it is not the whole of the trace cost. |
| **Projection reduced twice** (decode, reapply, encode in `commitTick`) | `codec:decode` 100 ms, `reduce:applyEvent` 102 ms (96k calls), `codec:encode` 4 ms, large-JSON parse and stringify 162 ms, projection SQL 39 ms: **407 ms, 1.7% of the hour** | **Not worth doing.** The projection is 0.2–0.9 MiB; it is read and written 61 times an hour. |
| **Routine and need scans** | Routine planning is **36% aged against 20% fresh, and 8.3 s against 1.0 s**. The cost is `prayerStep` → `prayableCauses`, which for every mortal on every tick builds a `Set` of every petition's cause, and scans every petition twice more (`inCooldown`, the open-subject set). Petitions grow by about 325 an hour and are never pruned (1,957 after 6 h; causes and memories are capped at 160 and 480), so the work grows with the age of the world. Needs (0.7%) and practice judging (0.8%) are negligible. | **The largest single cost in an aged world, and the reason age matters.** |
| **Chunk event list recopied every tick** | 9–11 ms an hour | **Not worth doing.** |
| **Summary loads every event before filtering** | 156–202 ms an hour (1%), in the ending commit | **Not worth doing** here. |
| **Hunger churn** (claimed, unverified) | Needs 0.7% of the hour; no phase is dominated by need events | **Not supported by the numbers.** |
| *(not in Oracle's list)* **commit overhead** | **8.7 s aged, 37%.** `pragmas.ts` shows it is **checkpointing**: with `wal_autocheckpoint=0` the same aged hour falls from 17.6 s to 11.9 s and the commit overhead from 7.2 s to 2.1 s (but the WAL then reaches 1 GiB, which is no fix); `wal_autocheckpoint=16384` (64 MiB) gives 13.5 s and 3.8 s with a bounded WAL; a 64 MiB page cache alone changes little. `results/pragmas-baseline.md`. Each chunk dirties pages across the large trace tables (their primary keys are random ids), so each automatic checkpoint writes and syncs scattered pages into a database that is 110 MiB larger every hour. | **The second-largest cost, and the one that makes chunks exceed 250 ms.** `synchronous=OFF` is ruled out and is not what this is. |

So the ranking by the numbers is: **routine planning's scans** (aged, 36%), **checkpointing** (37%), **the trace's writes** (18%), and then nothing else above 2%.

## What this does not show

- Only one machine and one disk; the checkpoint cost in particular depends on the disk and the OS cache. The 44 s outlier shows how much it can move.
- The aged world is 6 hours of this simulation's own catch-up; a world with live play, god turns, or more content will have different counts.
- `runPhases` times SQL statements by wrapping the database object; time spent inside `bun:sqlite`'s native code between statements is in the commit overhead, not the statements.

## Files

| Path | What |
| --- | --- |
| `fixtures/unit7-pack.json` | the immutable pack |
| `src/run.ts` | the matrix |
| `src/measure.ts`, `src/mirror.ts`, `src/instrument.ts`, `src/phases.ts` | the two measurements and their timers |
| `src/profile.ts`, `src/cpuprofile.ts` | the CPU profile run and reader |
| `src/pragmas.ts` | the commit-overhead diagnostic |
| `src/fingerprint.ts`, `src/world.ts` | the digests and the world helpers |
| `results/` | `baseline.{md,json}`, `profile-baseline-*.md`, `pragmas-baseline.md`, `fingerprint-baseline.json` |
