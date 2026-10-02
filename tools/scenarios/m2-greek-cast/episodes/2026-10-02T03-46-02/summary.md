# M2 experience gate

- Model: gpt-6-luna through a hosted OpenAI-compatible endpoint, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds
- dispositions: bless 54 × committed, report 27 × committed, report 26 × stale-target, move 12 × committed, legend 11 × committed, realm-transition 6 × committed, legend 3 × stale-target, move 2 × stale-target

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 23 (2 ability, 21 context) | 2 | 6 | 1 / 0 | 10 / 9 | 1 | FAIL: goal ended |
| 1 | Hera | 17 (1 ability, 16 context) | 3 | 4 | 2 / 2 | 10 / 9 | 0 | pass |
| 2 | Zeus | 19 (4 ability, 15 context) | 3 | 17 | 1 / 1 | 10 / 9 | 0 | pass |
| 2 | Hera | 17 (0 ability, 17 context) | 1 | 3 | 2 / 2 | 10 / 9 | 0 | pass |
| 3 | Zeus | 18 (4 ability, 14 context) | 1 | 13 | 1 / 1 | 10 / 9 | 0 | pass |
| 3 | Hera | 16 (0 ability, 16 context) | 1 | 2 | 2 / 2 | 10 / 9 | 0 | pass |

Automated checks failed:

- episode 1, Zeus: goal ended (no goal ended (at least 1, any outcome))

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 64 | 6 | 9% | 3256 / 8654 ms | 6 of 6 held |
| 2 | 55 | 11 | 15% | 3584 / 15003 ms | 6 of 6 held |
| 3 | 57 | 8 | 15% | 3461 / 15002 ms | 6 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
