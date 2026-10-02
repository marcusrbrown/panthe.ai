# M2 experience gate

- Model: granite3.3-8b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 3 (0 ability, 3 context) | 1 | 0 | 17 / 16 | 2 / 0 | 1 | FAIL: minimum activity, influence, petition answered |
| 1 | Hera | 3 (0 ability, 3 context) | 1 | 0 | 8 / 7 | 2 / 0 | 0 | FAIL: minimum activity, influence, petition answered |
| 2 | Zeus | 3 (0 ability, 3 context) | 1 | 0 | 13 / 12 | 2 / 0 | 2 | FAIL: minimum activity, influence, petition answered |
| 2 | Hera | 4 (0 ability, 4 context) | 1 | 1 | 14 / 13 | 2 / 0 | 0 | FAIL: minimum activity, petition answered |
| 3 | Zeus | 3 (0 ability, 3 context) | 1 | 0 | 13 / 13 | 2 / 0 | 0 | FAIL: minimum activity, influence, petition answered |
| 3 | Hera | 4 (0 ability, 4 context) | 1 | 1 | 10 / 9 | 2 / 0 | 0 | FAIL: minimum activity, petition answered |

Automated checks failed:

- episode 1, Zeus: minimum activity (3 committed model actions (at least 5))
- episode 1, Zeus: influence (no told belief or relationship change traces to this god's proposals)
- episode 1, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 1, Hera: minimum activity (3 committed model actions (at least 5))
- episode 1, Hera: influence (no told belief or relationship change traces to this god's proposals)
- episode 1, Hera: petition answered (2 heard, none answered (at least 1))
- episode 1, property changed next action (no god both formed a belief or feeling and acted on either side of it)
- episode 2, Zeus: minimum activity (3 committed model actions (at least 5))
- episode 2, Zeus: influence (no told belief or relationship change traces to this god's proposals)
- episode 2, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 2, Hera: minimum activity (4 committed model actions (at least 5))
- episode 2, Hera: petition answered (2 heard, none answered (at least 1))
- episode 2, property changed next action (no god both formed a belief or feeling and acted on either side of it)
- episode 3, Zeus: minimum activity (3 committed model actions (at least 5))
- episode 3, Zeus: influence (no told belief or relationship change traces to this god's proposals)
- episode 3, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 3, Hera: minimum activity (4 committed model actions (at least 5))
- episode 3, Hera: petition answered (2 heard, none answered (at least 1))
- episode 3, property changed next action (no god both formed a belief or feeling and acted on either side of it)

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 48 | 1 | 3% | 6334 / 7637 ms | 5 of 6 held |
| 2 | 36 | 0 | 0% | 7917 / 11998 ms | 5 of 6 held |
| 3 | 35 | 2 | 7% | 8079 / 15001 ms | 5 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
