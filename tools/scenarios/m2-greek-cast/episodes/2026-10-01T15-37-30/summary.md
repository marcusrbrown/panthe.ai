# M2 experience gate

- Model: llama3.2-3b-4k through local Ollama, 4K context, reasoning at the model's default
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 17 (3 ability, 14 context) | 4 | 6 | 16 / 16 | FAIL: repetition |
| 1 | Hera | 13 (0 ability, 13 context) | 2 | 5 | 8 / 7 | pass |
| 2 | Zeus | 29 (0 ability, 29 context) | 22 | 12 | 6 / 6 | FAIL: repetition |
| 2 | Hera | 19 (0 ability, 19 context) | 5 | 7 | 12 / 11 | FAIL: repetition |
| 3 | Zeus | 30 (2 ability, 28 context) | 5 | 8 | 12 / 11 | FAIL: repetition |
| 3 | Hera | 35 (4 ability, 31 context) | 4 | 6 | 10 / 10 | FAIL: repetition |

Automated checks failed:

- episode 1, Zeus: repetition (longest run 4 of report:hera (cap 3))
- episode 2, Zeus: repetition (longest run 22 of report:hera (cap 3))
- episode 2, Hera: repetition (longest run 5 of report:zeus (cap 3))
- episode 3, Zeus: repetition (longest run 5 of report:hera (cap 3))
- episode 3, Hera: repetition (longest run 4 of report:zeus (cap 3))

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 118 | 21 | 15% | 1896 / 3689 ms | 5 of 5 held |
| 2 | 91 | 11 | 11% | 2523 / 4650 ms | 5 of 5 held |
| 3 | 130 | 10 | 10% | 1508 / 3921 ms | 5 of 5 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
