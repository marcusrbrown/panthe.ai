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

Each scenario window is 3 minutes; longer windows would surface slower memory-pressure effects (sustained compression growth, deferred jetsam) this probe's window may miss. Renderer frame p95 is sampled via a `d`-keystroke dump into the packaged app's stdout log before and after each window, not continuously during it (a continuous automated-keystroke sampler would itself compete for the same CPU the renderer's animation loop runs on) — the window server driving synthetic keystrokes measured flaky in this environment; when a dump could not be captured the table records `n/a` rather than a stale or fabricated number. Draw Things was not exercised here — art-local's stable-diffusion.cpp base arm is the only image-generation adapter under contention (Unit 7's owner direction: sd.cpp is the cross-platform base arm and must work standalone). The pixel-art LoRA used by art-local's own bench is omitted here: this probe measures memory/latency contention, not image style, and the LoRA is a negligible ~26 MiB addition to sd-server's resident footprint. Peak swap reads identically (~7015 MiB) across every scenario below, including the renderer+LLM-only baseline: this machine already had that swap committed before this probe started (a pre-existing, not probe-caused, condition — macOS grows its dynamic swapfiles but does not shrink them again after the pressure that caused them eases, so a prior session's peak persists as this session's floor). Peak swap is therefore not a discriminating signal between candidates in this run; min free+inactive memory and the LLM p95 penalty are. No co-resident qemu-system-aarch64 VM was running during this probe's scenarios (checked via `pgrep -fl qemu` immediately before and after) — unlike the background load noted in tools/probes/inference-baseline/README.md's own caveat, this run's contention is attributable to the three tracked services alone plus the pre-existing swap floor above.

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
| ollama | 0.34.4 |
| sd-server binary | master-921-168f7b8 |
| sd 1.5 checkpoint (Q8_0) | second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf) |

## Results

#### Per-scenario memory and latency

| Scenario | LLM p50 (ms) | LLM p95 (ms) | p95 penalty vs A | Images completed | Frame p95 (ms) | Peak swap (MiB) | Min free+inactive (MiB) | Process died |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A: baseline (renderer + LLM) | 611 | 1535 | — | 0 | 17 | 7015 | 3400 | false |
| D: admission-queue @ 3072MiB | 892 | 1373 | -10.6% | 7 | 18 | 7015 | 2075 | false |
| B: unconstrained | 1315 | 2216 | +44.3% | 7 | 17 | 7015 | 2059 | false |
| D: admission-queue @ 5120MiB | 626 | 960 | -37.5% | 0 | 17 | 7015 | 3466 | false |
| C: mutex | 22784 | 23094 | +1404.2% | 8 | 17 | 7015 | 2384 | false |

#### Transition costs

| Transition | ms | ok |
| --- | --- | --- |
| sdserver-cold-after-llm-resident | 36089 | true |
| llm-cold-baseline | 1509 | true |
| llm-cold-after-sdcpp-resident | 1727 | true |
| sdserver-cold-baseline | 24596 | true |

## Findings

- Baseline (renderer + LLM loop only): LLM p50/p95 611/1535ms, renderer frame p95 17ms.
- admission-queue@3072MiB: LLM p95 1373ms (-10.6% vs baseline), 7 image(s) completed, peak swap 7015MiB, min free+inactive 2075MiB.
- unconstrained: LLM p95 2216ms (+44.3% vs baseline), 7 image(s) completed, peak swap 7015MiB, min free+inactive 2059MiB.
- admission-queue@5120MiB: LLM p95 960ms (-37.5% vs baseline), 0 image(s) completed, peak swap 7015MiB, min free+inactive 3466MiB.
- mutex: LLM p95 23094ms (+1404.2% vs baseline), 8 image(s) completed, peak swap 7015MiB, min free+inactive 2384MiB.
- Transition sdserver-cold-after-llm-resident: 36089ms (ok=true).
- Transition llm-cold-baseline: 1509ms (ok=true).
- Transition llm-cold-after-sdcpp-resident: 1727ms (ok=true).
- Transition sdserver-cold-baseline: 24596ms (ok=true).

## Bottom line

**Recommended heavy-work serialization policy: admission-queue @ 3072MiB.** admission-queue@3072MiB cleared the +25.0% bar without blocking the LLM — admission-queue@3072MiB: LLM p95 1373ms (-10.6% vs baseline 1535ms), 7 image(s) completed. Every other candidate measured worse or failed: unconstrained: LLM p95 2216ms (+44.3% vs baseline 1535ms), 7 image(s) completed; admission-queue@5120MiB: LLM p95 960ms (-37.5% vs baseline 1535ms), 0 image(s) completed; mutex: LLM p95 23094ms (+1404.2% vs baseline 1535ms), 8 image(s) completed.