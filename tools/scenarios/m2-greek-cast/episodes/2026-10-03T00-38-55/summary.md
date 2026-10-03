# M2 experience gate

- Requirements: O08
- Model: qwen3-8b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds
- dispositions: practice 30 × committed, bless 30 × committed, move 12 × committed, report 10 × committed, practice 7 × insufficient-resources, realm-transition 6 × committed, report 1 × not-adjacent, strike 1 × stale-target

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 13 (0 ability, 13 context) | 1 | 0 | 0 / 0 | 6 / 5 | 0 | FAIL: influence, goal set, goal ended |
| 1 | Hera | 17 (0 ability, 17 context) | 1 | 3 | 1 / 0 | 9 / 8 | 0 | FAIL: goal ended |
| 2 | Zeus | 13 (0 ability, 13 context) | 1 | 0 | 0 / 0 | 6 / 5 | 0 | FAIL: influence, goal set, goal ended |
| 2 | Hera | 12 (0 ability, 12 context) | 5 | 5 | 1 / 0 | 2 / 1 | 0 | FAIL: repetition, goal ended |
| 3 | Zeus | 15 (0 ability, 15 context) | 1 | 0 | 1 / 1 | 6 / 5 | 0 | FAIL: influence |
| 3 | Hera | 18 (0 ability, 18 context) | 1 | 1 | 0 / 0 | 7 / 6 | 0 | FAIL: goal set, goal ended |

Automated checks failed:

- episode 1, Zeus: influence (no told belief or relationship change traces to this god's proposals)
- episode 1, Zeus: goal set (0 goals set (at least 1))
- episode 1, Zeus: goal ended (no goal ended (at least 1, any outcome))
- episode 1, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 1, property supplication and settlement (8 supplications, 0 settlements, 0 refused or breached)
- episode 2, Zeus: influence (no told belief or relationship change traces to this god's proposals)
- episode 2, Zeus: goal set (0 goals set (at least 1))
- episode 2, Zeus: goal ended (no goal ended (at least 1, any outcome))
- episode 2, Hera: repetition (longest run 5 of report:farmer (cap 3))
- episode 2, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 2, property supplication and settlement (7 supplications, 0 settlements, 0 refused or breached)
- episode 3, Zeus: influence (no told belief or relationship change traces to this god's proposals)
- episode 3, Hera: goal set (0 goals set (at least 1))
- episode 3, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 3, property supplication and settlement (12 supplications, 1 settlements, 0 refused or breached)

## Practices

| Episode | Threads | Ended | Open | Refused or breached | No progress | Obligated turns |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 8 | 8 | 0 | 0 | 0 | 0 |
| 2 | 7 | 7 | 0 | 0 | 0 | 0 |
| 3 | 13 | 12 | 1 | 0 | 0 | 0 |

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 35 | 1 | 4% | 7584 / 12047 ms | 12 of 13 held |
| 2 | 33 | 3 | 11% | 8733 / 12364 ms | 12 of 13 held |
| 3 | 35 | 1 | 4% | 7290 / 12500 ms | 12 of 13 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: not rated (owner chose to proceed to Phase B, 2026-10-03)
