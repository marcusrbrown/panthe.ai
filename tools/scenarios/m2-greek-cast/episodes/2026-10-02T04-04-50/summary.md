# M2 experience gate

- Model: llama3.1-8b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds
- dispositions: report 30 × committed, legend 20 × committed, bless 17 × committed, move 14 × committed, realm-transition 12 × committed, goal 11 × committed, goal 6 × committed, no event, report 3 × stale-target, move 1 × stale-target, strike 1 × stale-target

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 12 (1 ability, 11 context) | 6 | 4 | 5 / 4 | 2 / 0 | 1 | FAIL: repetition, petition answered |
| 1 | Hera | 16 (6 ability, 10 context) | 4 | 8 | 3 / 2 | 2 / 0 | 1 | FAIL: repetition, petition answered |
| 2 | Zeus | 19 (2 ability, 17 context) | 2 | 3 | 4 / 3 | 9 / 8 | 3 | pass |
| 2 | Hera | 16 (7 ability, 9 context) | 3 | 1 | 5 / 4 | 1 / 0 | 2 | FAIL: petition answered |
| 3 | Zeus | 16 (1 ability, 15 context) | 1 | 8 | 6 / 5 | 11 / 9 | 0 | pass |
| 3 | Hera | 14 (3 ability, 11 context) | 3 | 1 | 4 / 3 | 1 / 0 | 3 | FAIL: petition answered |

Automated checks failed:

- episode 1, Zeus: repetition (longest run 6 of report:hera (cap 3))
- episode 1, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 1, Hera: repetition (longest run 4 of report:zeus (cap 3))
- episode 1, Hera: petition answered (2 heard, none answered (at least 1))
- episode 2, Hera: petition answered (1 heard, none answered (at least 1))
- episode 2, property changed next action (hera: report:zeus,zeus,hera before its first belief, report:zeus,zeus,hera after (same))
- episode 3, Hera: petition answered (1 heard, none answered (at least 1))
- episode 3, property changed next action (no god both formed a belief or feeling and acted on either side of it)

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 37 | 5 | 13% | 7159 / 13775 ms | 6 of 6 held |
| 2 | 50 | 5 | 7% | 4757 / 10292 ms | 5 of 6 held |
| 3 | 56 | 6 | 6% | 4123 / 10185 ms | 5 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
