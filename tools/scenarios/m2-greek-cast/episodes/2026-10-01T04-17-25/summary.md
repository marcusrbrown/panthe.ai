# M2 experience gate

- Model: gemma4-e4b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Checks |
| --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 28 (0 ability, 28 context) | 28 | 10 | FAIL: repetition |
| 1 | Hera | 28 (0 ability, 28 context) | 28 | 8 | FAIL: repetition |
| 2 | Zeus | 31 (0 ability, 31 context) | 31 | 14 | FAIL: repetition |
| 2 | Hera | 30 (0 ability, 30 context) | 30 | 7 | FAIL: repetition |
| 3 | Zeus | 33 (0 ability, 33 context) | 33 | 9 | FAIL: repetition |
| 3 | Hera | 34 (0 ability, 34 context) | 34 | 9 | FAIL: repetition |

Automated checks failed:

- episode 1, Zeus: repetition (longest run 28 of report:hera (cap 3))
- episode 1, Hera: repetition (longest run 28 of report:zeus (cap 3))
- episode 1, property changed next action (hera: report:zeus,zeus,hera before its first belief, report:zeus,zeus,hera after (same))
- episode 2, Zeus: repetition (longest run 31 of report:hera (cap 3))
- episode 2, Hera: repetition (longest run 30 of report:zeus (cap 3))
- episode 3, Zeus: repetition (longest run 33 of report:hera (cap 3))
- episode 3, Hera: repetition (longest run 34 of report:zeus (cap 3))
- episode 3, property changed next action (hera: report:zeus,zeus,hera before its first belief, report:zeus,zeus,hera after (same))

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 57 | 1 | 1% | 4486 / 7756 ms | 3 of 4 held |
| 2 | 62 | 1 | 1% | 4158 / 7165 ms | 4 of 4 held |
| 3 | 67 | 0 | 0% | 3967 / 4686 ms | 3 of 4 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
