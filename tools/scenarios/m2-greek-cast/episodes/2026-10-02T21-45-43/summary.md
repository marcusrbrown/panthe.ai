# M2 experience gate

- Requirements: O08
- Model: qwen3-8b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds
- dispositions: bless 54 × committed, report 26 × committed, move 18 × committed, realm-transition 6 × committed, report 3 × not-adjacent

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 18 (0 ability, 18 context) | 1 | 5 | 3 / 2 | 10 / 9 | 0 | pass |
| 1 | Hera | 18 (0 ability, 18 context) | 2 | 6 | 1 / 0 | 10 / 9 | 0 | FAIL: goal ended |
| 2 | Zeus | 16 (0 ability, 16 context) | 1 | 3 | 1 / 0 | 10 / 9 | 0 | FAIL: goal ended |
| 2 | Hera | 18 (0 ability, 18 context) | 3 | 5 | 3 / 2 | 10 / 9 | 0 | pass |
| 3 | Zeus | 17 (0 ability, 17 context) | 1 | 3 | 2 / 1 | 10 / 9 | 0 | pass |
| 3 | Hera | 17 (0 ability, 17 context) | 1 | 4 | 1 / 1 | 10 / 9 | 0 | pass |

Automated checks failed:

- episode 1, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 1, property changed next action (no god both formed a belief or feeling and acted on either side of it)
- episode 1, property god thread endings (no thread was opened)
- episode 1, property supplication and settlement (0 supplications, 0 settlements, 0 refused or breached)
- episode 1, property consequence changes a later choice (no thread ending left a consequence on a god)
- episode 2, Zeus: goal ended (no goal ended (at least 1, any outcome))
- episode 2, property changed next action (no god both formed a belief or feeling and acted on either side of it)
- episode 2, property god thread endings (no thread was opened)
- episode 2, property supplication and settlement (0 supplications, 0 settlements, 0 refused or breached)
- episode 2, property consequence changes a later choice (no thread ending left a consequence on a god)
- episode 3, property changed next action (no god both formed a belief or feeling and acted on either side of it)
- episode 3, property god thread endings (no thread was opened)
- episode 3, property supplication and settlement (0 supplications, 0 settlements, 0 refused or breached)
- episode 3, property consequence changes a later choice (no thread ending left a consequence on a god)

## Practices

| Episode | Threads | Ended | Open | Refused or breached | No progress | Obligated turns |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| 3 | 0 | 0 | 0 | 0 | 0 | 0 |

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 40 | 1 | 3% | 6514 / 8834 ms | 9 of 13 held |
| 2 | 39 | 2 | 6% | 7030 / 10713 ms | 9 of 13 held |
| 3 | 36 | 2 | 5% | 7504 / 11375 ms | 9 of 13 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: not rated (owner chose to proceed to Phase B, 2026-10-03)
