## Question

What happens when the renderer, the LLM, and stable-diffusion.cpp image generation run concurrently under 16 GB unified memory, and which heavy-work serialization policy — unconstrained, a global mutex, or an admission-controlled queue — does the measured data support?

## How to run

**Staging (prerequisite, not timed):** start every service and keep it running for every scenario invocation below.

```sh
ollama serve &                       # native /api/chat on :11434 (llama3.2:3b, ADR-0005's baseline profile)
/tmp/PantheaProbe/panthea-probe-renderer.app/Contents/MacOS/panthea-probe-renderer > /tmp/panthea-probe-renderer.stdout.log 2>&1 &
cd tools/probes/art-local && ./bin/sd-server --model models/sd-v1-5-pruned-emaonly-Q8_0.gguf --listen-port 1234 --diffusion-fa &
```

**Scenario** (one 3-minute window per candidate; run `baseline` first):

```sh
cd tools/probes/coexistence
bun run src/run.ts scenario --name baseline --duration-ms 180000 \
  --ollama-base-url http://localhost:11434 --model llama3.2:3b \
  --ollama-pid <ollama-serve-pid> --renderer-pid <renderer-pid> \
  --renderer-log /tmp/panthea-probe-renderer.stdout.log --label A-baseline

bun run src/run.ts scenario --name unconstrained --duration-ms 180000 \
  --ollama-base-url http://localhost:11434 --model llama3.2:3b \
  --sdcpp-base-url http://127.0.0.1:1234 \
  --ollama-pid <pid> --sdserver-pid <pid> --renderer-pid <pid> \
  --renderer-log /tmp/panthea-probe-renderer.stdout.log --label B-unconstrained

bun run src/run.ts scenario --name mutex ... --label C-mutex

bun run src/run.ts scenario --name admission --threshold-mib 3072 ... --label D-admission-3gib
bun run src/run.ts scenario --name admission --threshold-mib 5120 ... --label D-admission-5gib
```

**Transition costs**:

```sh
ollama stop llama3.2:3b   # evict the model, forcing the next request to reload it
bun run src/run.ts transition-llm --ollama-base-url http://localhost:11434 --model llama3.2:3b \
  --transition llm-cold-after-sdcpp-resident --label llm-cold-after-sdcpp

kill <sd-server-pid>
bun run src/run.ts sdserver-spawn --binary ./bin/sd-server --model models/sd-v1-5-pruned-emaonly-Q8_0.gguf \
  --port 1234 --transition sdserver-cold-after-llm-resident --label sdserver-cold-after-llm
```

**Report**: `bun run src/run.ts report` — renders this README from raw `results/*.json` records when present (and regenerates the committed `results/summary.json` published aggregate to match); on a fresh checkout with no raw records, renders from that committed aggregate instead and leaves it untouched; with neither present, exits non-zero and writes nothing.

## Caveat

Each scenario window is 3 minutes; longer windows would surface slower memory-pressure effects (sustained compression growth, deferred jetsam) this probe's window may miss. Renderer frame p95 is sampled via a `d`-keystroke dump into the packaged app's stdout log before and after each window, not continuously during it (a continuous automated-keystroke sampler would itself compete for the same CPU the renderer's animation loop runs on) — the window server driving synthetic keystrokes measured flaky in this environment; when a dump could not be captured the table records `n/a` rather than a stale or fabricated number. Draw Things was not exercised here — art-local's stable-diffusion.cpp base arm is the only image-generation adapter under contention (Unit 7's owner direction: sd.cpp is the cross-platform base arm and must work standalone). The pixel-art LoRA used by art-local's own bench is omitted here: this probe measures memory/latency contention, not image style, and the LoRA is a negligible ~26 MiB addition to sd-server's resident footprint. This machine carries a large pre-existing swap floor (roughly 7 GiB already committed before this probe's own scenarios ever ran) that macOS's dynamic swapfiles do not shrink again once the pressure that caused them eases — every scenario's peak-swap reading includes that inherited floor, not just this probe's own contribution, so peak swap alone is not a clean discriminating signal between candidates; min free+inactive memory and the LLM p95 penalty are the more reliable ones. No co-resident qemu-system-aarch64 VM was running during this probe's scenarios (checked via `pgrep -fl qemu` immediately before and after) — unlike the background load noted in tools/probes/inference-baseline/README.md's own caveat, this run's contention is attributable to the three tracked services alone plus the pre-existing swap floor above. Fro Bot review on PR #22 found three measurement bugs in the original run: LLM p50/p95 included failed/timed-out requests (inflating or, for an all-failed scenario, silently reading p95=0), a missing post-window frame dump fell back to the pre-window value instead of reading n/a, and 'no viable candidate' silently defaulted to recommending the mutex hypothesis instead of reporting inconclusive. All three are fixed in this run's code (success-only percentiles with a >=20-success/<=5%-error-rate evaluability floor, frame p95 only ever from a verified post-window sample, and an explicit 'inconclusive' outcome that never silently picks a fallback). The A (baseline) and D-admission-3072MiB scenarios were re-measured end to end with the fixed sampler; B (unconstrained), C (mutex), and D-admission-5120MiB were not re-run because their raw per-request records were gitignored and did not survive the worktree that produced them being retired — their rows below carry over the original run's LLM p50/p95/images/peak-swap numbers for context but are marked not-evaluable (their success/error counts and post-window frame samples cannot be recomputed without the lost raw records). The re-measured D-admission-queue@3072MiB result changed materially between runs: the original run (same code, same machine, several hours earlier in a long multi-scenario session) measured a -10.6% LLM p95 penalty; this fresh, independently-started re-run measured +148.4%, with LLM latency climbing roughly monotonically across the 3-minute window (352ms first request → 3329ms last) while sd.cpp generated images almost back-to-back (6 images in 180s — the 3072MiB gate was cleared almost continuously and rarely actually throttled image start). Both runs used the same (correct, success-only) percentile logic for this scenario — the difference is real machine-to-machine-session variance, not a measurement artifact, and it means a single 3-minute window's number for this threshold should not be treated as stable without a repeat measurement.

## Environment

| Field | Value |
| --- | --- |
| Hardware | Apple M1 Pro |
| Memory | 17179869184 |
| OS | macOS 15.7.9 (24G830) |
| Bun | 1.4.2 |
| Tauri | 2.12.0 |
| Three.js | 0.185.1 |
| Three Flatland | 0.1.0-alpha.10 |
| model | llama3.2:3b |

## Results

#### Per-scenario memory and latency

| Scenario | LLM p50 (ms) | LLM p95 (ms) | p95 penalty vs A | LLM success/attempts | Images completed | Frame p95 (ms) | Peak swap (MiB) | Min free+inactive (MiB) | Sample cadence (median ms) | Process died | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A: baseline (renderer + LLM) | 645 | 1242 | — | 60/60 | 0 | 18 | 6967 | 4306 | 501 | false | evaluable |
| D: admission-queue @ 3072MiB | 1574 | 3086 | +148.4% | 60/60 | 6 | 18 | 9211 | 868 | 501 | false | failed: LLM p95 penalty +148.4% exceeds the +25.0% bar |
| B: unconstrained | 1315 | 2216 | +78.4% | n/a | 7 | n/a (not evaluable) | 7015 | 2059 | n/a | false | not-evaluable: LLM data not evaluable (success/error counts unavailable (raw per-request records not recomputable)) |
| D: admission-queue @ 5120MiB | 626 | 960 | -22.7% | n/a | 0 | n/a (not evaluable) | 7015 | 3466 | n/a | false | not-evaluable: LLM data not evaluable (success/error counts unavailable (raw per-request records not recomputable)) |
| C: mutex | 22784 | 23094 | +1759.3% | n/a | 8 | n/a (not evaluable) | 7015 | 2384 | n/a | false | not-evaluable: LLM data not evaluable (success/error counts unavailable (raw per-request records not recomputable)) |

#### Transition costs

| Transition | ms | ok |
| --- | --- | --- |
| sdserver-cold-after-llm-resident | 36089 | true |
| llm-cold-baseline | 1509 | true |
| llm-cold-after-sdcpp-resident | 1727 | true |
| sdserver-cold-baseline | 24596 | true |

## Findings

- Baseline (renderer + LLM loop only): LLM p50/p95 645/1242ms over 60/60 successful/attempted requests (evaluable), renderer frame p95 18, sample cadence median 501ms.
- admission-queue@3072MiB: LLM p95 3086ms (+148.4% vs baseline), 60/60 successful LLM requests, 6 image(s) completed, frame p95 18ms — failed: LLM p95 penalty +148.4% exceeds the +25.0% bar
- unconstrained: LLM p95 2216ms (+78.4% vs baseline), LLM success/attempt counts unavailable, 7 image(s) completed, frame p95 not evaluable (no post-window sample) — not-evaluable: LLM data not evaluable (success/error counts unavailable (raw per-request records not recomputable))
- admission-queue@5120MiB: LLM p95 960ms (-22.7% vs baseline), LLM success/attempt counts unavailable, 0 image(s) completed, frame p95 not evaluable (no post-window sample) — not-evaluable: LLM data not evaluable (success/error counts unavailable (raw per-request records not recomputable))
- mutex: LLM p95 23094ms (+1759.3% vs baseline), LLM success/attempt counts unavailable, 8 image(s) completed, frame p95 not evaluable (no post-window sample) — not-evaluable: LLM data not evaluable (success/error counts unavailable (raw per-request records not recomputable))
- Transition sdserver-cold-after-llm-resident: 36089ms (ok=true).
- Transition llm-cold-baseline: 1509ms (ok=true).
- Transition llm-cold-after-sdcpp-resident: 1727ms (ok=true).
- Transition sdserver-cold-baseline: 24596ms (ok=true).
- Next measurement steps to resolve this: re-run B (unconstrained), C (mutex), and D-admission-5120MiB with the fixed sampler (success-only percentiles, verified post-window frame samples) so every candidate is evaluable in the same run; and measure at least one intermediate admission threshold between 3072MiB and 5120MiB, since 3072MiB now measures a real +148.4% penalty (images ran almost continuously, rarely gated) while 5120MiB starves image generation to zero — the viable threshold, if one exists on this machine's pre-existing swap floor, likely sits between them.

## Bottom line

**No heavy-work serialization policy is recommended yet — inconclusive.** No candidate cleared the +25.0% LLM p95 penalty bar while completing images, and none was silently defaulted to: admission-queue@3072MiB: LLM p95 3086ms (+148.4% vs baseline), 60/60 successful LLM requests, 6 image(s) completed, frame p95 18ms — failed: LLM p95 penalty +148.4% exceeds the +25.0% bar; unconstrained: LLM p95 2216ms (+78.4% vs baseline), LLM success/attempt counts unavailable, 7 image(s) completed, frame p95 not evaluable (no post-window sample) — not-evaluable: LLM data not evaluable (success/error counts unavailable (raw per-request records not recomputable)); admission-queue@5120MiB: LLM p95 960ms (-22.7% vs baseline), LLM success/attempt counts unavailable, 0 image(s) completed, frame p95 not evaluable (no post-window sample) — not-evaluable: LLM data not evaluable (success/error counts unavailable (raw per-request records not recomputable)); mutex: LLM p95 23094ms (+1759.3% vs baseline), LLM success/attempt counts unavailable, 8 image(s) completed, frame p95 not evaluable (no post-window sample) — not-evaluable: LLM data not evaluable (success/error counts unavailable (raw per-request records not recomputable)). Further measurement is needed before recommending a heavy-work policy.