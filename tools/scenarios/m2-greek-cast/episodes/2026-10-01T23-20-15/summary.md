# M2 experience gate

- Model: gemma4-e4b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 21 (0 ability, 21 context) | 18 | 5 | 1 / 0 | 2 / 0 | 0 | FAIL: repetition, goal ended, petition answered |
| 1 | Hera | 21 (0 ability, 21 context) | 18 | 6 | 1 / 0 | 2 / 0 | 0 | FAIL: repetition, goal ended, petition answered |
| 2 | Zeus | 25 (0 ability, 25 context) | 11 | 8 | 1 / 0 | 2 / 0 | 0 | FAIL: repetition, goal ended, petition answered |
| 2 | Hera | 26 (0 ability, 26 context) | 11 | 4 | 1 / 0 | 2 / 0 | 0 | FAIL: repetition, goal ended, petition answered |
| 3 | Zeus | 25 (0 ability, 25 context) | 8 | 4 | 1 / 0 | 2 / 0 | 0 | FAIL: repetition, goal ended, petition answered |
| 3 | Hera | 25 (0 ability, 25 context) | 8 | 7 | 1 / 0 | 2 / 0 | 0 | FAIL: repetition, goal ended, petition answered |

Automated checks failed:

- episode 1, Zeus: repetition (longest run 18 of report:hera (cap 3))
- episode 1, Zeus: goal ended (no goal ended (at least 1, any outcome))
- episode 1, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 1, Hera: repetition (longest run 18 of report:zeus (cap 3))
- episode 1, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 1, Hera: petition answered (2 heard, none answered (at least 1))
- episode 1, property changed next action (hera: report:zeus,zeus,hera,zeus before its first belief, report:zeus,zeus,hera,zeus after (same))
- episode 2, Zeus: repetition (longest run 11 of report:hera (cap 3))
- episode 2, Zeus: goal ended (no goal ended (at least 1, any outcome))
- episode 2, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 2, Hera: repetition (longest run 11 of report:zeus (cap 3))
- episode 2, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 2, Hera: petition answered (2 heard, none answered (at least 1))
- episode 3, Zeus: repetition (longest run 8 of report:hera (cap 3))
- episode 3, Zeus: goal ended (no goal ended (at least 1, any outcome))
- episode 3, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 3, Hera: repetition (longest run 8 of report:zeus (cap 3))
- episode 3, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 3, Hera: petition answered (2 heard, none answered (at least 1))

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 43 | 1 | 2% | 6516 / 8428 ms | 5 of 6 held |
| 2 | 51 | 0 | 0% | 4961 / 7791 ms | 6 of 6 held |
| 3 | 50 | 0 | 0% | 5239 / 7617 ms | 6 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
