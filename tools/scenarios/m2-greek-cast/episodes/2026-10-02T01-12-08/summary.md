# M2 experience gate

- Model: llama3.1-8b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 4 (0 ability, 4 context) | 1 | 2 | 6 / 5 | 2 / 0 | 2 | FAIL: minimum activity, petition answered |
| 1 | Hera | 21 (16 ability, 5 context) | 9 | 2 | 5 / 4 | 2 / 0 | 4 | FAIL: repetition, petition answered |
| 2 | Zeus | 6 (0 ability, 6 context) | 1 | 2 | 4 / 3 | 2 / 0 | 1 | FAIL: petition answered |
| 2 | Hera | 15 (4 ability, 11 context) | 1 | 1 | 4 / 3 | 2 / 0 | 4 | FAIL: petition answered |
| 3 | Zeus | 4 (0 ability, 4 context) | 1 | 1 | 3 / 2 | 2 / 0 | 1 | FAIL: minimum activity, petition answered |
| 3 | Hera | 11 (3 ability, 8 context) | 2 | 1 | 2 / 1 | 2 / 0 | 0 | FAIL: petition answered |

Automated checks failed:

- episode 1, Zeus: minimum activity (4 committed model actions (at least 5))
- episode 1, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 1, Hera: repetition (longest run 9 of legend:legend (cap 3))
- episode 1, Hera: petition answered (2 heard, none answered (at least 1))
- episode 2, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 2, Hera: petition answered (2 heard, none answered (at least 1))
- episode 3, Zeus: minimum activity (4 committed model actions (at least 5))
- episode 3, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 3, Hera: petition answered (2 heard, none answered (at least 1))

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 53 | 0 | 0% | 4870 / 8105 ms | 6 of 6 held |
| 2 | 47 | 3 | 9% | 5134 / 12144 ms | 6 of 6 held |
| 3 | 41 | 5 | 12% | 6289 / 15001 ms | 6 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
