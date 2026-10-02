# M2 experience gate

- Model: llama3.2-3b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 12 (0 ability, 12 context) | 1 | 3 | 6 / 5 | 2 / 0 | 3 | FAIL: petition answered |
| 1 | Hera | 6 (0 ability, 6 context) | 2 | 3 | 5 / 4 | 2 / 0 | 0 | FAIL: petition answered |
| 2 | Zeus | 4 (0 ability, 4 context) | 1 | 2 | 5 / 4 | 2 / 0 | 3 | FAIL: minimum activity, petition answered |
| 2 | Hera | 7 (0 ability, 7 context) | 2 | 2 | 5 / 4 | 2 / 0 | 1 | FAIL: petition answered |
| 3 | Zeus | 11 (0 ability, 11 context) | 6 | 9 | 5 / 4 | 2 / 0 | 2 | FAIL: repetition, petition answered |
| 3 | Hera | 8 (0 ability, 8 context) | 2 | 4 | 5 / 4 | 2 / 0 | 3 | FAIL: petition answered |

Automated checks failed:

- episode 1, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 1, Hera: petition answered (2 heard, none answered (at least 1))
- episode 2, Zeus: minimum activity (4 committed model actions (at least 5))
- episode 2, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 2, Hera: petition answered (2 heard, none answered (at least 1))
- episode 3, Zeus: repetition (longest run 6 of report:hera (cap 3))
- episode 3, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 3, Hera: petition answered (2 heard, none answered (at least 1))

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 92 | 9 | 9% | 2187 / 5882 ms | 6 of 6 held |
| 2 | 107 | 16 | 10% | 1916 / 5029 ms | 6 of 6 held |
| 3 | 81 | 10 | 13% | 3045 / 6107 ms | 6 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
