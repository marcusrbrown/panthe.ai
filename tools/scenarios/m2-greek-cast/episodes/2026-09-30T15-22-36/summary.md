# M2 experience gate

- Model: llama3.2-3b-4k through local Ollama, 4K context
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Checks |
| --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 17 (0 ability, 17 context) | 10 | 8 | FAIL: repetition |
| 1 | Hera | 24 (6 ability, 18 context) | 8 | 10 | FAIL: repetition |
| 2 | Zeus | 34 (1 ability, 33 context) | 4 | 10 | FAIL: repetition |
| 2 | Hera | 24 (8 ability, 16 context) | 3 | 5 | pass |
| 3 | Zeus | 37 (2 ability, 35 context) | 5 | 13 | FAIL: repetition |
| 3 | Hera | 32 (2 ability, 30 context) | 9 | 9 | FAIL: repetition |

Automated checks failed:

- episode 1, Zeus: repetition (longest run 10 of report:hera (cap 3))
- episode 1, Hera: repetition (longest run 8 of report:zeus (cap 3))
- episode 2, Zeus: repetition (longest run 4 of report:hera (cap 3))
- episode 3, Zeus: repetition (longest run 5 of report:hera (cap 3))
- episode 3, Hera: repetition (longest run 9 of report:zeus (cap 3))

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 103 | 22 | 18% | 2212 / 4221 ms | 4 of 4 held |
| 2 | 111 | 11 | 9% | 1713 / 3516 ms | 4 of 4 held |
| 3 | 104 | 16 | 15% | 2201 / 4447 ms | 4 of 4 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: replan
