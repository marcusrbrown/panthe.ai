# M2 experience gate

- Requirements: O08
- Model: qwen3-8b-4k through local Ollama, 4K context, reasoning off (reasoning_effort none)
- 3 episodes of 300 s, each a fresh world from the initial authored Greek state; no fixtures, no seeds
- dispositions: bless 54 × committed, report 35 × committed, move 18 × committed, report 8 × not-adjacent, realm-transition 6 × committed, strike 1 × committed, strike 1 × stale-target

## Automated checks

| Episode | God | Committed actions | Longest run | Told beliefs and feelings caused | Goals set / ended | Petitions heard / answered | Goal changes refused | Checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Zeus | 20 (0 ability, 20 context) | 2 | 5 | 6 / 6 | 10 / 9 | 0 | pass |
| 1 | Hera | 19 (0 ability, 19 context) | 3 | 7 | 6 / 6 | 10 / 9 | 0 | pass |
| 2 | Zeus | 20 (1 ability, 19 context) | 1 | 6 | 6 / 6 | 11 / 9 | 0 | pass |
| 2 | Hera | 17 (0 ability, 17 context) | 2 | 5 | 3 / 3 | 10 / 9 | 0 | pass |
| 3 | Zeus | 18 (0 ability, 18 context) | 1 | 4 | 4 / 3 | 10 / 9 | 0 | pass |
| 3 | Hera | 20 (0 ability, 20 context) | 4 | 5 | 4 / 4 | 10 / 9 | 0 | FAIL: repetition |

Automated checks failed:

- episode 1, property changed next action (no god both formed a belief or feeling and acted on either side of it)
- episode 1, property petition privacy (zeus's prompt lists evt-104-549, addressed to hera)
- episode 3, Hera: repetition (longest run 4 of report:farmer (cap 3))
- episode 3, property changed next action (no god both formed a belief or feeling and acted on either side of it)

## Model runs

| Episode | Requests | Exhausted | Degraded polls | Latency p50 / p95 | Properties |
| --- | --- | --- | --- | --- | --- |
| 1 | 43 | 1 | 3% | 6303 / 8422 ms | 4 of 6 held |
| 2 | 42 | 1 | 3% | 6272 / 10415 ms | 6 of 6 held |
| 3 | 43 | 2 | 5% | 6273 / 9414 ms | 5 of 6 held |

## Transcripts

- [episode-1.md](episode-1.md)
- [episode-2.md](episode-2.md)
- [episode-3.md](episode-3.md)

## Owner

Scores are in each transcript's rubric. The owner scores; the tool never does.

Decision: continue / tune / replan: continue (owner, 2026-10-02)

Rated with the failures above disclosed: repetition (Hera, episode 3, a run of 4); petition privacy is a check false positive (Zeus witnessed the prayer at the altar); changed next action is a check coverage limit.
