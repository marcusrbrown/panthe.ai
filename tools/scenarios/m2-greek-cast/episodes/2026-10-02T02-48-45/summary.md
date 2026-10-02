# M2 experience gate

- Model: gpt-6-luna through a hosted OpenAI-compatible endpoint, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 4 (1 ability, 3 context) | 1 | 1 | 1 / 1 | 2 / 0 | 0 | FAIL: minimum activity, petition answered |
| 1 | Hera | 4 (1 ability, 3 context) | 1 | 1 | 1 / 1 | 2 / 0 | 0 | FAIL: minimum activity, petition answered |
| 2 | Zeus | 4 (1 ability, 3 context) | 1 | 1 | 1 / 1 | 2 / 0 | 0 | FAIL: minimum activity, petition answered |
| 2 | Hera | 5 (0 ability, 5 context) | 1 | 2 | 2 / 2 | 2 / 0 | 0 | FAIL: petition answered |
| 3 | Zeus | 4 (1 ability, 3 context) | 1 | 1 | 2 / 2 | 2 / 0 | 0 | FAIL: minimum activity, petition answered |
| 3 | Hera | 4 (1 ability, 3 context) | 1 | 1 | 2 / 1 | 2 / 0 | 0 | FAIL: minimum activity, petition answered |

Automated checks failed:

- episode 1, Zeus: minimum activity (4 committed model actions (at least 5))
- episode 1, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 1, Hera: minimum activity (4 committed model actions (at least 5))
- episode 1, Hera: petition answered (2 heard, none answered (at least 1))
- episode 2, Zeus: minimum activity (4 committed model actions (at least 5))
- episode 2, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 2, Hera: petition answered (2 heard, none answered (at least 1))
- episode 3, Zeus: minimum activity (4 committed model actions (at least 5))
- episode 3, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 3, Hera: minimum activity (4 committed model actions (at least 5))
- episode 3, Hera: petition answered (2 heard, none answered (at least 1))

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 65 | 4 | 5% | 2791 / 15002 ms | 6 of 6 held |
| 2 | 71 | 2 | 3% | 2607 / 7656 ms | 6 of 6 held |
| 3 | 69 | 1 | 1% | 3119 / 7683 ms | 6 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
