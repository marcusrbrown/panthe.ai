# CPU profile: 20 mortals, aged (6 h)

Sampled 23655.2 ms (the child's whole run, startup included); real hour {"totalMs":23626.719125}.

| Phase | ms | Share |
| --- | --- | --- |
| routine planning (buildRoutineQueue) | 8431.1 | 35.6% |
| transaction control (BEGIN, COMMIT, WAL write) | 7234.9 | 30.6% |
| trace: JS and SQL (traceWorldTick) | 5600 | 23.7% |
| world: validation and application (runTick) | 761 | 3.2% |
| commit: event rows | 444.3 | 1.9% |
| commit: projection read/reduce/encode/write | 318.1 | 1.3% |
| summary (closeCatchUpBacklog) | 202 | 0.9% |
| world: practice judging | 191.5 | 0.8% |
| world: needs | 173.3 | 0.7% |
| other | 105.8 | 0.4% |
| world: notices | 102 | 0.4% |
| simulation: step and queue (stepWorldTick) | 82.1 | 0.3% |
| commit: other (commitTick, clock, progress) | 4.6 | 0% |
| world: fire | 3.7 | 0% |
| world: memory and perception | 0.7 | 0% |

## Top 25 functions by inclusive time

| Function | File | Inclusive ms | Self ms |
| --- | --- | --- | --- |
| runCatchUp | simulation/src/catchup.ts | 23611.9 | 53.8 |
| commitWorldTick | simulation/src/tick.ts | 13893.8 | 0 |
| transaction | bun:sqlite | 13892.4 | 0 |
| run |  | 11653.3 | 11653.3 |
| buildRoutineQueue | simulation/src/tick.ts | 8431.1 | 11.4 |
| decideRoutineProposal | world/src/routines.ts | 8412.1 | 51.7 |
| prayerStep | world/src/petitions.ts | 8163.2 | 138.1 |
| prayableCauses | world/src/petitions.ts | 7937.6 | 1164.4 |
| #runNoArgs | bun:sqlite | 7234.9 | 0 |
| onCommitted | simulation/src/tick.ts | 5804.2 | 0.8 |
| traceWorldTick | simulation/src/tick.ts | 5600 | 22.6 |
| run | bun:sqlite | 4417.7 | 3.9 |
| recordProposalOutcome | telemetry/src/trace.ts | 3485.8 | 8.7 |
| Set |  | 3207.2 | 3207.2 |
| recordScreenedObservation | simulation/src/tick.ts | 2061.3 | 1.3 |
| recordObservation | telemetry/src/trace.ts | 2059.9 | 2.7 |
| performIteration |  | 1933 | 1923 |
| get |  | 1508 | 1508 |
| getObservation | telemetry/src/trace.ts | 1499.5 | 0.7 |
| forEach |  | 1448.3 | 0 |
| stepWorldTick | simulation/src/tick.ts | 1158.2 | 5.9 |
| runTick | world/src/actions.ts | 1133.2 | 51.7 |
| filter |  | 995.7 | 950.6 |
| map |  | 619.3 | 507.4 |
| applyEvent | world/src/actions.ts | 563.8 | 35.7 |

## Top 25 functions by self time

| Function | File | Self ms | Inclusive ms |
| --- | --- | --- | --- |
| run |  | 11653.3 | 11653.3 |
| Set |  | 3207.2 | 3207.2 |
| performIteration |  | 1923 | 1933 |
| get |  | 1508 | 1508 |
| prayableCauses | world/src/petitions.ts | 1164.4 | 7937.6 |
| filter |  | 950.6 | 995.7 |
| map |  | 507.4 | 619.3 |
| Map |  | 343.6 | 343.6 |
| inCooldown | world/src/petitions.ts | 292.6 | 292.6 |
| parse |  | 178.9 | 178.9 |
| stringify |  | 165.1 | 165.1 |
| all |  | 155.2 | 155.2 |
| prayerStep | world/src/petitions.ts | 138.1 | 8163.2 |
| planNoticeStep | world/src/petitions.ts | 91 | 102 |
| copyDataProperties |  | 85.2 | 85.2 |
| findCounterparty | world/src/routines.ts | 65.6 | 99.2 |
| getResourceAmount | world/src/economy.ts | 65.3 | 66.1 |
| runCatchUp | simulation/src/catchup.ts | 53.8 | 23611.9 |
| cloneObject |  | 52.4 | 52.4 |
| runTick | world/src/actions.ts | 51.7 | 1133.2 |
| decideRoutineProposal | world/src/routines.ts | 51.7 | 8412.1 |
| transferBetweenActors | world/src/economy.ts | 36.4 | 180.2 |
| applyEvent | world/src/actions.ts | 35.7 | 563.8 |
| completeEvent | world/src/actions.ts | 32.9 | 35.5 |
| planNeedStep | world/src/needs.ts | 31.2 | 173.3 |
