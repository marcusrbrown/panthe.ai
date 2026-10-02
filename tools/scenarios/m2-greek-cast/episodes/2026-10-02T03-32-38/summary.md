# M2 experience gate

- Model: gpt-6-luna through a hosted OpenAI-compatible endpoint, reasoning off (reasoning_effort none)
- 1 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds
- dispositions: bless 73 × stale-target, move 4 × committed, realm-transition 2 × committed, report 1 × committed, report 1 × stale-target

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 3 (0 ability, 3 context) | 1 | 0 | 1 / 1 | 2 / 0 | 0 | FAIL: minimum activity, influence, petition answered |
| 1 | Hera | 4 (0 ability, 4 context) | 1 | 1 | 1 / 0 | 2 / 0 | 1 | FAIL: minimum activity, goal ended, petition answered |

Automated checks failed:

- episode 1, Zeus: minimum activity (3 committed model actions (at least 5))
- episode 1, Zeus: influence (no told belief or relationship change traces to this god's proposals)
- episode 1, Zeus: petition answered (2 heard, none answered (at least 1))
- episode 1, Hera: minimum activity (4 committed model actions (at least 5))
- episode 1, Hera: goal ended (no goal ended (at least 1, any outcome))
- episode 1, Hera: petition answered (2 heard, none answered (at least 1))
- episode 1, property changed next action (no god both formed a belief or feeling and acted on either side of it)

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 82 | 1 | 1% | 2474 / 5744 ms | 5 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
