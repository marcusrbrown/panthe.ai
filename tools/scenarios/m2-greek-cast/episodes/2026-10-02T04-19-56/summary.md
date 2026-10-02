# M2 experience gate

- Model: qwen3-8b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds
- dispositions: bless 54 × committed, report 19 × stale-target, report 19 × committed, move 12 × committed, realm-transition 6 × committed, move 4 × stale-target

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 14 (0 ability, 14 context) | 2 | 2 | 3 / 2 | 10 / 9 | 1 | pass |
| 1 | Hera | 15 (0 ability, 15 context) | 1 | 2 | 2 / 1 | 10 / 9 | 1 | pass |
| 2 | Zeus | 14 (0 ability, 14 context) | 2 | 2 | 2 / 1 | 10 / 9 | 1 | pass |
| 2 | Hera | 17 (0 ability, 17 context) | 2 | 3 | 2 / 1 | 10 / 9 | 1 | pass |
| 3 | Zeus | 17 (0 ability, 17 context) | 1 | 3 | 2 / 1 | 10 / 9 | 0 | pass |
| 3 | Hera | 14 (0 ability, 14 context) | 1 | 2 | 2 / 1 | 10 / 9 | 1 | pass |

Automated checks failed:

- episode 1, property changed next action (no god both formed a belief or feeling and acted on either side of it)
- episode 2, property changed next action (no god both formed a belief or feeling and acted on either side of it)

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 47 | 10 | 19% | 5422 / 8957 ms | 5 of 6 held |
| 2 | 46 | 10 | 21% | 5485 / 9333 ms | 5 of 6 held |
| 3 | 47 | 6 | 17% | 5754 / 9179 ms | 6 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: 
