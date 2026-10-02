# M2 experience gate

- Requirements: O08
- Model: llama3.1-8b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds
- dispositions: move 27 × committed, report 17 × committed, legend 13 × committed, realm-transition 12 × committed, bless 11 × committed, goal 8 × committed, goal 2 × committed, no event, strike 1 × stale-target

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 21 (3 ability, 18 context) | 1 | 9 | 3 / 2 | 11 / 9 | 1 | pass |
| 1 | Hera | 15 (1 ability, 14 context) | 1 | 1 | 3 / 2 | 1 / 0 | 2 | FAIL: petition answered |
| 2 | Zeus | 12 (3 ability, 9 context) | 2 | 7 | 2 / 1 | 2 / 0 | 0 | FAIL: petition answered |
| 2 | Hera | 7 (3 ability, 4 context) | 2 | 2 | 1 / 0 | 2 / 0 | 1 | FAIL: goal ended, petition answered |
| 3 | Zeus | 15 (2 ability, 13 context) | 1 | 5 | 3 / 2 | 3 / 2 | 0 | pass |
| 3 | Hera | 10 (1 ability, 9 context) | 2 | 2 | 1 / 1 | 1 / 0 | 1 | FAIL: petition answered |

Automated checks failed:

- episode 1, Hera: petition answered (1 heard, none answered (at least 1))
- episode 1, property changed next action (no god both formed a belief or feeling and acted on either side of it)
- episode 2, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 2, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 2, Hera: petition answered (2 heard, none answered (at least 1))
- episode 2, property changed next action (hera: legend:hera,hera,great-hall before its first belief, legend:hera,hera,great-hall after (same))
- episode 3, Hera: petition answered (1 heard, none answered (at least 1))

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 53 | 4 | 5% | 4828 / 10360 ms | 5 of 6 held |
| 2 | 41 | 20 | 51% | 6570 / 10240 ms | 5 of 6 held |
| 3 | 45 | 17 | 43% | 5027 / 11272 ms | 6 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: not rated (comparison only, owner, 2026-10-02)
