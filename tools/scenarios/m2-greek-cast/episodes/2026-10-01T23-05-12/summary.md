# M2 experience gate

- Model: llama3.2-3b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 8 (0 ability, 8 context) | 1 | 2 | 6 / 5 | 2 / 0 | 11 | FAIL: petition answered |
| 1 | Hera | 14 (0 ability, 14 context) | 1 | 1 | 6 / 5 | 2 / 0 | 7 | FAIL: petition answered |
| 2 | Zeus | 28 (2 ability, 26 context) | 4 | 10 | 8 / 7 | 2 / 0 | 2 | FAIL: repetition, petition answered |
| 2 | Hera | 14 (0 ability, 14 context) | 3 | 5 | 7 / 6 | 2 / 0 | 11 | FAIL: petition answered |
| 3 | Zeus | 10 (0 ability, 10 context) | 1 | 1 | 5 / 4 | 2 / 0 | 2 | FAIL: petition answered |
| 3 | Hera | 9 (0 ability, 9 context) | 1 | 0 | 5 / 4 | 2 / 0 | 4 | FAIL: influence, petition answered |

Automated checks failed:

- episode 1, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 1, Hera: petition answered (2 heard, none answered (at least 1))
- episode 2, Zeus: repetition (longest run 4 of report:hera (cap 3))
- episode 2, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 2, Hera: petition answered (2 heard, none answered (at least 1))
- episode 3, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 3, Hera: influence (no told belief or relationship change traces to this god's proposals)
- episode 3, Hera: petition answered (2 heard, none answered (at least 1))

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 139 | 11 | 6% | 1403 / 3535 ms | 6 of 6 held |
| 2 | 111 | 6 | 5% | 1928 / 3925 ms | 6 of 6 held |
| 3 | 134 | 43 | 31% | 1861 / 3026 ms | 6 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
