# M2 experience gate

- Model: qwen3-8b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 1 (0 ability, 1 context) | 1 | 0 | 1 / 0 | 2 / 0 | 0 | FAIL: minimum activity, influence, goal ended, petition answered |
| 1 | Hera | 3 (0 ability, 3 context) | 1 | 1 | 1 / 0 | 2 / 0 | 0 | FAIL: minimum activity, goal ended, petition answered |
| 2 | Zeus | 1 (0 ability, 1 context) | 1 | 0 | 1 / 0 | 2 / 0 | 0 | FAIL: minimum activity, influence, goal ended, petition answered |
| 2 | Hera | 3 (0 ability, 3 context) | 1 | 2 | 1 / 0 | 2 / 0 | 0 | FAIL: minimum activity, goal ended, petition answered |
| 3 | Zeus | 1 (0 ability, 1 context) | 1 | 0 | 1 / 0 | 2 / 0 | 0 | FAIL: minimum activity, influence, goal ended, petition answered |
| 3 | Hera | 15 (0 ability, 15 context) | 6 | 4 | 2 / 1 | 2 / 0 | 0 | FAIL: repetition, petition answered |

Automated checks failed:

- episode 1, Zeus: minimum activity (1 committed model actions (at least 5))
- episode 1, Zeus: influence (no told belief or relationship change traces to this god's proposals)
- episode 1, Zeus: goal ended (no goal ended (at least 1, any outcome))
- episode 1, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 1, Hera: minimum activity (3 committed model actions (at least 5))
- episode 1, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 1, Hera: petition answered (2 heard, none answered (at least 1))
- episode 1, property changed next action (no god both formed a belief or feeling and acted on either side of it)
- episode 2, Zeus: minimum activity (1 committed model actions (at least 5))
- episode 2, Zeus: influence (no told belief or relationship change traces to this god's proposals)
- episode 2, Zeus: goal ended (no goal ended (at least 1, any outcome))
- episode 2, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 2, Hera: minimum activity (3 committed model actions (at least 5))
- episode 2, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 2, Hera: petition answered (2 heard, none answered (at least 1))
- episode 2, property changed next action (no god both formed a belief or feeling and acted on either side of it)
- episode 3, Zeus: minimum activity (1 committed model actions (at least 5))
- episode 3, Zeus: influence (no told belief or relationship change traces to this god's proposals)
- episode 3, Zeus: goal ended (no goal ended (at least 1, any outcome))
- episode 3, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 3, Hera: repetition (longest run 6 of report:zeus (cap 3))
- episode 3, Hera: petition answered (2 heard, none answered (at least 1))
- episode 3, property changed next action (no god both formed a belief or feeling and acted on either side of it)

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 68 | 64 | 89% | 3440 / 7275 ms | 5 of 6 held |
| 2 | 52 | 48 | 87% | 4732 / 7440 ms | 5 of 6 held |
| 3 | 39 | 23 | 61% | 6642 / 13688 ms | 5 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
