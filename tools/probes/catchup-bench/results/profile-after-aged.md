# CPU profile: 20 mortals, aged (6 h)

Sampled 4079.1 ms (the child's whole run, startup included); real hour {"totalMs":4043.199167}.

| Phase | ms | Share |
| --- | --- | --- |
| trace: JS and SQL (traceWorldTick) | 775.2 | 19% |
| transaction control (BEGIN, COMMIT, WAL write) | 751 | 18.4% |
| world: validation and application (runTick) | 630.7 | 15.5% |
| routine planning (buildRoutineQueue) | 556.2 | 13.6% |
| commit: event rows | 478.6 | 11.7% |
| commit: projection read/reduce/encode/write | 309.8 | 7.6% |
| world: practice judging | 168.7 | 4.1% |
| world: needs | 162.3 | 4% |
| summary (closeCatchUpBacklog) | 97 | 2.4% |
| other | 60.4 | 1.5% |
| world: notices | 42.7 | 1% |
| simulation: step and queue (stepWorldTick) | 30.3 | 0.7% |
| commit: other (commitTick, clock, progress) | 8.4 | 0.2% |
| world: fire | 3.5 | 0.1% |
| world: income | 3.1 | 0.1% |
| world: director | 1.2 | 0% |

## Top 15 functions by inclusive time

| Function | File | Inclusive ms | Self ms |
| --- | --- | --- | --- |
| runCatchUp | simulation/src/catchup.ts | 4040 | 23.2 |
| commitWorldTick | simulation/src/tick.ts | 2515.5 | 0 |
| transaction | bun:sqlite | 2514 | 0 |
| run |  | 1786.9 | 1786.9 |
| run | bun:sqlite | 1039 | 5.1 |
| stepWorldTick | simulation/src/tick.ts | 920.8 | 0.7 |
| runTick | world/src/actions.ts | 909.6 | 19.9 |
| onCommitted | simulation/src/tick.ts | 878.5 | 0.5 |
| traceWorldTick | simulation/src/tick.ts | 775.2 | 15.8 |
| #runNoArgs | bun:sqlite | 751 | 0 |
| buildRoutineQueue | simulation/src/tick.ts | 556.2 | 7.3 |
| applyEvent | world/src/actions.ts | 507.5 | 21.5 |
| insertEventRow | persistence/src/store.ts | 478.6 | 6.4 |
| decideRoutineProposal | world/src/routines.ts | 465.3 | 40.8 |
| recordProposalOutcome | telemetry/src/trace.ts | 463.7 | 8.4 |

## Top 15 functions by self time

| Function | File | Self ms | Inclusive ms |
| --- | --- | --- | --- |
| run |  | 1786.9 | 1786.9 |
| Map |  | 296.6 | 296.6 |
| stringify |  | 181 | 181 |
| parse |  | 161.9 | 161.9 |
| performIteration |  | 123.3 | 126.6 |
| findCounterparty | world/src/routines.ts | 68.9 | 97.4 |
| get |  | 64.8 | 64.8 |
| filter |  | 63.9 | 98.8 |
| cloneObject |  | 61.1 | 61.1 |
| hex | contracts/src/ids.ts | 56.8 | 57.9 |
| petitionIndex | world/src/petitions.ts | 54.9 | 60.3 |
| copyDataProperties |  | 54.3 | 54.3 |
| getResourceAmount | world/src/economy.ts | 52.3 | 52.3 |
| (anonymous) | contracts/src/ids.ts | 45.2 | 159.1 |
| decideRoutineProposal | world/src/routines.ts | 40.8 | 465.3 |
