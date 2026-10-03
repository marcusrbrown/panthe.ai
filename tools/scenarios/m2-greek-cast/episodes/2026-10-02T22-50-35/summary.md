# M2 experience gate

- Requirements: O08
- Model: qwen3-8b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds
- dispositions: bless 16 × committed, practice 12 × committed, move 10 × committed, report 6 × committed, realm-transition 4 × committed

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 10 (0 ability, 10 context) | 1 | 0 | 1 / 1 | 5 / 3 | 0 | FAIL: influence |
| 1 | Hera | 3 (0 ability, 3 context) | 1 | 1 | 0 / 0 | 1 / 0 | 0 | FAIL: minimum activity, goal set, goal ended, petition answered |
| 2 | Zeus | 15 (0 ability, 15 context) | 1 | 2 | 2 / 1 | 9 / 8 | 0 | pass |
| 2 | Hera | 9 (0 ability, 9 context) | 1 | 2 | 1 / 0 | 4 / 3 | 0 | FAIL: goal ended |
| 3 | Zeus | 8 (0 ability, 8 context) | 1 | 0 | 1 / 1 | 4 / 2 | 0 | FAIL: influence |
| 3 | Hera | 3 (0 ability, 3 context) | 1 | 1 | 0 / 0 | 1 / 0 | 0 | FAIL: minimum activity, goal set, goal ended, petition answered |

Automated checks failed:

- episode 1, Zeus: influence (no told belief or relationship change traces to this god's proposals)
- episode 1, Hera: minimum activity (3 committed model actions (at least 5))
- episode 1, Hera: goal set (0 goals set (at least 1))
- episode 1, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 1, Hera: petition answered (1 heard, none answered (at least 1))
- episode 1, property changed next action (no god both formed a belief or feeling and acted on either side of it)
- episode 1, property god thread endings (hera: no thread ending it caused left a persistent consequence; zeus: 2 (fulfilled [evt-89-426], fulfilled [evt-191-939]))
- episode 1, property supplication and settlement (4 supplications, 1 settlements, 0 refused or breached)
- episode 2, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 2, property supplication and settlement (3 supplications, 0 settlements, 0 refused or breached)
- episode 3, Zeus: influence (no told belief or relationship change traces to this god's proposals)
- episode 3, Hera: minimum activity (3 committed model actions (at least 5))
- episode 3, Hera: goal set (0 goals set (at least 1))
- episode 3, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 3, Hera: petition answered (1 heard, none answered (at least 1))
- episode 3, property changed next action (no god both formed a belief or feeling and acted on either side of it)
- episode 3, property god thread endings (hera: no thread ending it caused left a persistent consequence; zeus: 1 (fulfilled [evt-101-483]))
- episode 3, property supplication and settlement (3 supplications, 1 settlements, 0 refused or breached)
- episode 3, property consequence changes a later choice (zeus: bless: before the consequence, bless: after (same); the prompt behind it showed how the thread ended)

## Practices

| Episode | Threads | Ended | Open | Refused or breached | No progress | Obligated turns |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 5 | 4 | 1 | 0 | 0 | 0 |
| 2 | 3 | 3 | 0 | 0 | 0 | 0 |
| 3 | 4 | 3 | 1 | 0 | 0 | 0 |

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 31 | 18 | 51% | 9087 / 13787 ms | 10 of 13 held |
| 2 | 34 | 10 | 31% | 8659 / 12025 ms | 12 of 13 held |
| 3 | 26 | 15 | 49% | 10240 / 15203 ms | 9 of 13 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: not rated (owner chose to proceed to Phase B, 2026-10-03)
