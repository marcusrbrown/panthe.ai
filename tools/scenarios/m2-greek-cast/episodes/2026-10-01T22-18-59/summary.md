# M2 experience gate

- Model: llama3.2-3b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 23 (0 ability, 23 context) | 3 | 9 | 7 / 6 | 2 / 0 | 10 | FAIL: petition answered |
| 1 | Hera | 17 (1 ability, 16 context) | 5 | 7 | 5 / 5 | 2 / 0 | 9 | FAIL: repetition, petition answered |
| 2 | Zeus | 20 (1 ability, 19 context) | 4 | 4 | 7 / 6 | 2 / 0 | 7 | FAIL: repetition, petition answered |
| 2 | Hera | 17 (0 ability, 17 context) | 1 | 7 | 6 / 6 | 2 / 0 | 7 | FAIL: petition answered |
| 3 | Zeus | 14 (0 ability, 14 context) | 11 | 8 | 5 / 4 | 2 / 0 | 2 | FAIL: repetition, petition answered |
| 3 | Hera | 13 (2 ability, 11 context) | 7 | 5 | 5 / 4 | 2 / 0 | 5 | FAIL: repetition, petition answered |

Automated checks failed:

- episode 1, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 1, Hera: repetition (longest run 5 of report:zeus (cap 3))
- episode 1, Hera: petition answered (2 heard, none answered (at least 1))
- episode 2, Zeus: repetition (longest run 4 of report:hera (cap 3))
- episode 2, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 2, Hera: petition answered (2 heard, none answered (at least 1))
- episode 3, Zeus: repetition (longest run 11 of report:hera (cap 3))
- episode 3, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 3, Hera: repetition (longest run 7 of report:zeus (cap 3))
- episode 3, Hera: petition answered (2 heard, none answered (at least 1))

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 97 | 0 | 0% | 2403 / 4259 ms | 6 of 6 held |
| 2 | 115 | 3 | 3% | 1759 / 3591 ms | 6 of 6 held |
| 3 | 87 | 7 | 8% | 2877 / 4748 ms | 6 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
