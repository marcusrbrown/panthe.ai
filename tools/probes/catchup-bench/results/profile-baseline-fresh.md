# CPU profile: 20 mortals, fresh

Sampled 5517.8 ms (the child's whole run, startup included); real hour {"totalMs":5496.575083}.

| Phase | ms | Share |
| --- | --- | --- |
| transaction control (BEGIN, COMMIT, WAL write) | 1864.8 | 33.8% |
| routine planning (buildRoutineQueue) | 1180.9 | 21.4% |
| trace: JS and SQL (traceWorldTick) | 949.7 | 17.2% |
| world: validation and application (runTick) | 460.2 | 8.3% |
| commit: event rows | 405.4 | 7.3% |
| world: needs | 177.9 | 3.2% |
| world: practice judging | 150.9 | 2.7% |
| summary (closeCatchUpBacklog) | 89.3 | 1.6% |
| commit: projection read/reduce/encode/write | 76.3 | 1.4% |
| other | 69.3 | 1.3% |
| world: notices | 52.8 | 1% |
| simulation: step and queue (stepWorldTick) | 30.5 | 0.6% |
| commit: other (commitTick, clock, progress) | 5.2 | 0.1% |
| world: fire | 2 | 0% |
| world: income | 2 | 0% |
| world: director | 0.7 | 0% |

## Top 25 functions by inclusive time

| Function | File | Inclusive ms | Self ms |
| --- | --- | --- | --- |
| runCatchUp | simulation/src/catchup.ts | 5493.5 | 24.6 |
| commitWorldTick | simulation/src/tick.ts | 3477.3 | 0.7 |
| transaction | bun:sqlite | 3475.8 | 0 |
| run |  | 2945.8 | 2945.8 |
| #runNoArgs | bun:sqlite | 1864.8 | 0 |
| buildRoutineQueue | simulation/src/tick.ts | 1180.9 | 3.1 |
| decideRoutineProposal | world/src/routines.ts | 1170.7 | 47.2 |
| run | bun:sqlite | 1084 | 4.2 |
| onCommitted | simulation/src/tick.ts | 1042.3 | 0.8 |
| prayerStep | world/src/petitions.ts | 981.3 | 12.2 |
| prayableCauses | world/src/petitions.ts | 955.1 | 119.8 |
| traceWorldTick | simulation/src/tick.ts | 949.7 | 16.7 |
| stepWorldTick | simulation/src/tick.ts | 779.3 | 3.5 |
| runTick | world/src/actions.ts | 766 | 33.1 |
| recordProposalOutcome | telemetry/src/trace.ts | 534.4 | 7.7 |
| applyEvent | world/src/actions.ts | 414 | 24 |
| insertEventRow | persistence/src/store.ts | 405.4 | 6 |
| Set |  | 383.7 | 383.7 |
| recordScreenedObservation | simulation/src/tick.ts | 373.7 | 1.3 |
| recordObservation | telemetry/src/trace.ts | 372.4 | 3.3 |
| performIteration |  | 240.7 | 236.9 |
| Map |  | 240.2 | 240.2 |
| map |  | 212 | 106.3 |
| planNeedStep | world/src/needs.ts | 177.9 | 27.3 |
| forEach |  | 174.6 | 0.6 |

## Top 25 functions by self time

| Function | File | Self ms | Inclusive ms |
| --- | --- | --- | --- |
| run |  | 2945.8 | 2945.8 |
| Set |  | 383.7 | 383.7 |
| Map |  | 240.2 | 240.2 |
| performIteration |  | 236.9 | 240.7 |
| stringify |  | 119.8 | 119.8 |
| prayableCauses | world/src/petitions.ts | 119.8 | 955.1 |
| get |  | 118.8 | 118.8 |
| map |  | 106.3 | 212 |
| filter |  | 105.2 | 125.5 |
| parse |  | 76.4 | 76.4 |
| findCounterparty | world/src/routines.ts | 73.1 | 97.9 |
| cloneObject |  | 61.8 | 61.8 |
| decideRoutineProposal | world/src/routines.ts | 47.2 | 1170.7 |
| planNoticeStep | world/src/petitions.ts | 44.7 | 52.8 |
| all |  | 39 | 39 |
| copyDataProperties |  | 36.8 | 36.8 |
| getResourceAmount | world/src/economy.ts | 35.2 | 35.2 |
| runTick | world/src/actions.ts | 33.1 | 766 |
| planNeedStep | world/src/needs.ts | 27.3 | 177.9 |
| currentNeeds | world/src/needs.ts | 25.6 | 148.1 |
| runCatchUp | simulation/src/catchup.ts | 24.6 | 5493.5 |
| applyEvent | world/src/actions.ts | 24 | 414 |
| transferBetweenActors | world/src/economy.ts | 19.4 | 129.4 |
| withResourceAmount | world/src/economy.ts | 17.3 | 76.4 |
| entries |  | 17 | 17 |
