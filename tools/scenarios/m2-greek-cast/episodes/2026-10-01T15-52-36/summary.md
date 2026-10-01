# M2 experience gate

- Model: gemma4-e4b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 24 (0 ability, 24 context) | 24 | 6 | 8 / 7 | FAIL: repetition |
| 1 | Hera | 16 (0 ability, 16 context) | 16 | 3 | 6 / 5 | FAIL: repetition |
| 2 | Zeus | 25 (0 ability, 25 context) | 25 | 6 | 8 / 7 | FAIL: repetition |
| 2 | Hera | 23 (0 ability, 23 context) | 23 | 4 | 6 / 5 | FAIL: repetition |
| 3 | Zeus | 23 (0 ability, 23 context) | 23 | 6 | 10 / 9 | FAIL: repetition |
| 3 | Hera | 12 (0 ability, 12 context) | 12 | 4 | 5 / 4 | FAIL: repetition |

Automated checks failed:

- episode 1, Zeus: repetition (longest run 24 of report:hera (cap 3))
- episode 1, Hera: repetition (longest run 16 of report:zeus (cap 3))
- episode 2, Zeus: repetition (longest run 25 of report:hera (cap 3))
- episode 2, Hera: repetition (longest run 23 of report:zeus (cap 3))
- episode 3, Zeus: repetition (longest run 23 of report:hera (cap 3))
- episode 3, Hera: repetition (longest run 12 of report:zeus (cap 3))

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 49 | 8 | 13% | 5398 / 8958 ms | 5 of 5 held |
| 2 | 51 | 3 | 5% | 5034 / 8339 ms | 5 of 5 held |
| 3 | 46 | 11 | 18% | 5701 / 8957 ms | 5 of 5 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
