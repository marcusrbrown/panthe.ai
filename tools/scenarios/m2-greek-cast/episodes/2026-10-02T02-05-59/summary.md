# M2 experience gate

- Model: gemma3-4b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 4 (0 ability, 4 context) | 1 | 1 | 25 / 24 | 2 / 0 | 0 | FAIL: minimum activity, petition answered |
| 1 | Hera | 7 (0 ability, 7 context) | 1 | 2 | 8 / 7 | 2 / 0 | 0 | FAIL: petition answered |
| 2 | Zeus | 6 (0 ability, 6 context) | 3 | 3 | 19 / 18 | 2 / 0 | 0 | FAIL: petition answered |
| 2 | Hera | 8 (0 ability, 8 context) | 3 | 4 | 1 / 0 | 2 / 0 | 0 | FAIL: goal ended, petition answered |
| 3 | Zeus | 3 (0 ability, 3 context) | 1 | 0 | 24 / 23 | 2 / 0 | 0 | FAIL: minimum activity, influence, petition answered |
| 3 | Hera | 6 (0 ability, 6 context) | 2 | 3 | 21 / 20 | 2 / 0 | 0 | FAIL: petition answered |

Automated checks failed:

- episode 1, Zeus: minimum activity (4 committed model actions (at least 5))
- episode 1, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 1, Hera: petition answered (2 heard, none answered (at least 1))
- episode 2, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 2, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 2, Hera: petition answered (2 heard, none answered (at least 1))
- episode 3, Zeus: minimum activity (3 committed model actions (at least 5))
- episode 3, Zeus: influence (no told belief or relationship change traces to this god's proposals)
- episode 3, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 3, Hera: petition answered (2 heard, none answered (at least 1))
- episode 3, property changed next action (no god both formed a belief or feeling and acted on either side of it)

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 58 | 1 | 1% | 4544 / 5960 ms | 6 of 6 held |
| 2 | 52 | 18 | 43% | 4706 / 9764 ms | 6 of 6 held |
| 3 | 55 | 1 | 3% | 4963 / 6700 ms | 5 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
