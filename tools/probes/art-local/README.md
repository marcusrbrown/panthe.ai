## Question

Which local image-generation arm meets the offline pixel-art-generation profile for ADR-0007 on the M1 Pro 16GB baseline — seconds/image, peak RSS, first-image warmup, and cancellation — and can it settle the base arm without depending on Draw Things?

## How to run

**Staging (prerequisite, not timed):**

Download the pinned `stable-diffusion.cpp` release (macOS arm64) into `tools/probes/art-local/bin/` (gitignored; tag/sha256 recorded below):

```sh
curl -sL -o sd.zip https://github.com/leejet/stable-diffusion.cpp/releases/download/master-921-168f7b8/sd-master-168f7b8-bin-Darwin-macOS-26.6.2-arm64.zip
unzip sd.zip -d bin/
```

Download the SD 1.5 checkpoints and pixel-art LoRA into `tools/probes/art-local/models/` (gitignored; identifiers/sha256 recorded below). Q8_0 is recommended — the LoRA was empirically confirmed to apply reliably only at this quantization (see Caveat); Q4_0 and f16 are kept for comparison/reproducibility, not as base-arm candidates:

```sh
mkdir -p models/loras
curl -sL -o models/sd-v1-5-pruned-emaonly-Q8_0.gguf https://huggingface.co/second-state/stable-diffusion-v1-5-GGUF/resolve/main/stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf
curl -sL -o models/sd-v1-5-pruned-emaonly-Q4_0.gguf https://huggingface.co/second-state/stable-diffusion-v1-5-GGUF/resolve/main/stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf
curl -sL -o models/sd-v1-5-pruned-emaonly-f16.gguf https://huggingface.co/second-state/stable-diffusion-v1-5-GGUF/resolve/main/stable-diffusion-v1-5-pruned-emaonly-f16.gguf
curl -sL -o models/loras/PixelArtRedmond15V-PixelArt-PIXARFK.safetensors https://huggingface.co/artificialguybr/pixelartredmond-1-5v-pixel-art-loras-for-sd-1-5/resolve/main/PixelArtRedmond15V-PixelArt-PIXARFK.safetensors
```

Launch `sd-server` against ONE checkpoint at a time (it loads the model given at startup; `--diffusion-fa` is not optional, see Caveat: the same generation measured ~5x slower without it):

```sh
# Q8_0 (recommended base arm — LoRA confirmed working, see Caveat)
./bin/sd-server --model models/sd-v1-5-pruned-emaonly-Q8_0.gguf --lora-model-dir models/loras --listen-port 1234 --diffusion-fa

# Q4_0 (measured for speed/RSS only — LoRA application is unreliable here,
# see Caveat; do not use this quantization to judge LoRA/pixel-art quality)
./bin/sd-server --model models/sd-v1-5-pruned-emaonly-Q4_0.gguf --lora-model-dir models/loras --listen-port 1234 --diffusion-fa

# f16 (comparison-only, matches Draw Things' precision — CRASHES this build
# when the LoRA is applied; see Caveat. Kept documented for whoever retries
# this once a fixed stable-diffusion.cpp build is available.)
./bin/sd-server --model models/sd-v1-5-pruned-emaonly-f16.gguf --lora-model-dir models/loras --listen-port 1234 --diffusion-fa
```

Draw Things (optional add-on, owner-installed 26.0924.0): Settings → API Server → enable HTTP on 127.0.0.1:7860; select the same base model + LoRA in-app (no HTTP model/LoRA selection exists, see Caveat). Never leave it enabled after a run — localhost is not a security boundary here, any local process can drive it.

**Suite** (per arm; `--model` is always explicit — if omitted for `--arm sd.cpp`, it is resolved from the single checkpoint file directly under `models/`, erroring with the candidate list if that's ambiguous or absent; for `--arm draw-things` it is auto-read from `GET /sdapi/v1/options`, the app's own selection, if omitted):

```sh
cd tools/probes/art-local
bun run src/run.ts suite --arm sd.cpp --base-url http://127.0.0.1:1234 \
  --model sd-v1-5-pruned-emaonly-Q8_0 --width 512 --height 512 --steps 12 \
  --lora-path PixelArtRedmond15V-PixelArt-PIXARFK.safetensors --lora-multiplier 0.6 \
  --rss-pid <sd-server-pid> --label sdcpp-512

bun run src/run.ts suite --arm draw-things --base-url http://127.0.0.1:7860 \
  --width 512 --height 512 --steps 12 --rss-pid <DrawThings-pid> --label drawthings-512
```

`--rss-pid` is the generator process's own pid (`pgrep -f sd-server`, or Draw Things' pid from Activity Monitor/`ps`) — the sampler polls its RSS every 250ms and records the peak.

**Cancellation**:

```sh
bun run src/run.ts cancel --arm sd.cpp --base-url http://127.0.0.1:1234 \
  --width 512 --height 512 --steps 20 --baseline-seconds <measured-p50-seconds> \
  --lora-path PixelArtRedmond15V-PixelArt-PIXARFK.safetensors --lora-multiplier 0.6 \
  --rss-pid <sd-server-pid> --label sdcpp-cancel

bun run src/run.ts cancel --arm draw-things --label drawthings-cancel
```

Submits a job and aborts it at ~30% of `--baseline-seconds`. Tries `POST /sdcpp/v1/jobs/{id}/cancel` first; if this server build reports `cancel_generating: false` (measured true here, see Caveat), `--rss-pid` is required and the fallback SIGTERMs the `sd-server` process itself, measuring time to idle. Draw Things has no cancel path at all and is recorded as unsupported without attempting a request.

**Report**: `bun run src/run.ts report` — renders this README from raw `results/*.json` records when present (and regenerates the committed `results/summary.json` published aggregate to match); on a fresh checkout with no raw records, renders from that committed aggregate instead and leaves it untouched; with neither present, exits non-zero and writes nothing. `results/summary.json` publishes already-computed rates/percentiles/counts, not the raw per-prompt samples they were computed from.

## Caveat

Draw Things is an OPTIONAL add-on arm (owner direction): stable-diffusion.cpp is the base arm and must work, and settles, standalone. Draw Things was reachable at port 7860 and its measured numbers appear in the table below as an optional add-on arm. Draw Things' HTTP surface (`/sdapi/v1/txt2img`, A1111-shaped) has no model/LoRA selection, no model list, and no cancellation — the active model is whatever the app has selected. This probe reads the selected model from `GET /sdapi/v1/options` (Draw Things' own settings dict, keyed `model`, not the vanilla A1111/stable-diffusion.cpp-compat `sd_model_checkpoint` key) and records it per run rather than assuming it. Qwen Image 2.1 under Draw Things ships under the Qwen Research License (non-commercial). Panthea is noncommercial (D01), so it is allowed for evaluation only; a commercial fork would need a different default (see docs/decisions/0007-local-image-generation.md). 16GB three-way coexistence (renderer + inference + image generation together) is out of scope here — that is Unit 8's `tools/probes/coexistence` measurement, not this probe's. Pixel-art styling on the sd.cpp arm comes from a LoRA (artificialguybr/pixelartredmond-1-5v-pixel-art-loras-for-sd-1-5 (PixelArtRedmond15V-PixelArt-PIXARFK.safetensors)), not a pixel-art-tuned base checkpoint — no single-file pixel-art-tuned SD 1.5 checkpoint in a stable-diffusion.cpp-loadable format (safetensors/ckpt/GGUF) was found within this probe's time budget; the base checkpoint is plain SD 1.5 (second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf)). LoRA license: bespoke-lora-trained-license (CivitAI: allowNoCredit=true, allowCommercialUse=Rent, allowDerivatives=true, allowDifferentLicense=false) — non-commercial-oriented, verify before any content-pack use. LoRA trigger-word placement matters: the PixelArtRedmond LoRA only reliably triggers when `PixArFK` is the FIRST token of the prompt (e.g. `PixArFK, pixel art, ...`), not mid-string (e.g. `pixel art, PixArFK, ...`) — confirmed by the owner against the live Draw Things app and applied to every prompt in `prompts.json` for both arms. **LoRA reliability differs by sd.cpp quantization (owner-flagged, verified empirically):** at Q4_0, a fixed-seed with-vs-without-LoRA comparison showed only a weak, hard-to-distinguish difference — the sd.cpp Q4_0 row above should be read as **effectively no-LoRA**, not a validated pixel-art measurement. At Q8_0, the same comparison showed a dramatic, unambiguous difference (without the LoRA the model drifted off-prompt entirely; with it, the correct subject rendered in pixel-art style), matching stable-diffusion.cpp's own documented warning that its "apply at runtime" LoRA path (used automatically for quantized weights) can have precision/compatibility issues. Q8_0 (second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf), sha256 d0555243938c...) is therefore the recommended sd.cpp base-arm quantization for this LoRA, superseding the earlier Q4_0-only measurement; Q4_0's numbers remain recorded (real, measured speed/RSS) but are not evidence of a working pixel-art pipeline. `--diffusion-fa` (flash attention) is not optional for usable sd-server performance on this Metal build: the same 512x512, 12-step, no-LoRA generation measured ~127s without it and ~24s with it — roughly a 5x difference — so every sd.cpp arm number in this README was measured with `--diffusion-fa` enabled; running without it is not a viable base-arm configuration. This sd-server build's native `sdcpp` API reports `cancel_generating: false` in `GET /sdcpp/v1/capabilities` — `POST /sdcpp/v1/jobs/{id}/cancel` only works on a job still queued behind another, not one already generating, so it cannot interrupt the single in-flight job this probe's cancellation test submits. SIGINT to the `sd-server` process was tried first and measured to be silently ignored (the process kept running and started its next queued job); SIGTERM reliably terminates it, though not always within a single 250ms poll tick. This run's outcome was `idle-cpu`, not a confirmed kill — see the Cancellation table for why no cancel-to-idle number is reported. An f16 (unquantized) sd.cpp + LoRA run was attempted, specifically to match Draw Things' precision for an engine-isolating comparison, but it reproducibly crashed this sd-server build (master-921-168f7b8) with or without `--diffusion-fa` — a real, confirmed bug applying this LoRA against non-quantized (f16) weights on Metal (`ggml-backend.cpp:930: pre-allocated tensor ... in a buffer (MTL0) that cannot run the operation (ADD)`, inside `LoraModel::apply`). Plain f16 generation *without* the LoRA succeeded, isolating the crash to the LoRA-on-f16 combination specifically, not f16 in general. The Draw Things comparison below is therefore precision-confounded (sd.cpp Q8_0 vs Draw Things f16), not the engine-isolating comparison this probe set out to make; the f16 checkpoint (second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-f16.gguf), sha256 da017009aa86...) remains downloaded and recorded for whoever revisits this once a fixed build is available. Draw Things' sampled process RSS peak (257 MiB) is likely a lower bound, not the true resident footprint: an SD 1.5 f16 checkpoint is roughly 2GB on disk, so Metal/GPU-resident unified-memory buffers are probably not fully reflected in `ps`'s RSS column for this app — recorded as sampled, not corrected.

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
| sd-server binary | master-921-168f7b8 (sha256 2650e3bb9d11...) |
| SD 1.5 checkpoint (Q8_0, recommended) | second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf) |
| SD 1.5 checkpoint (Q4_0, LoRA-unreliable) | second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf) |
| SD 1.5 checkpoint (f16, comparison-only) | second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-f16.gguf) |
| Pixel-art LoRA | artificialguybr/pixelartredmond-1-5v-pixel-art-loras-for-sd-1-5 (PixelArtRedmond15V-PixelArt-PIXARFK.safetensors) |

## Results

#### Per-arm results

| Arm | Model | Size | Steps | n | Warmup (s) | s/image p50 | s/image p95 | Peak RSS | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sd.cpp | sd-v1-5-pruned-emaonly-Q8_0 | 512x512 | 12 | 15 | 37.8 | 37.3 | 37.4 | 2320 MiB | 0 |
| draw-things | sd_v1.5_f16.ckpt + pixelartredmond15v_pixelart_pixarfk_lora_f16.ckpt@0.6 | 512x512 | 12 | 15 | 6.3 | 5.7 | 5.9 | 257 MiB | 0 |
| sd.cpp | sd-v1-5-pruned-emaonly-Q4_0 | 512x512 | 12 | 15 | 40.4 | 37.1 | 37.3 | 2164 MiB | 0 |

#### Cancellation

| Arm | Supported | Outcome | Cancel-to-idle | Note |
| --- | --- | --- | --- | --- |
| sd.cpp | no | idle-cpu | n/a | this sd-server build reports cancel_generating=false, so the in-flight job could not be cancelled over HTTP; SIGINT was tried first and measured to be silently ignored (the process kept running and started its next queued job), so this fell back to SIGTERM on the sd-server process (pid 72164) at ~30% of baseline (11190ms). SIGTERM ends the whole server, not just the one job — a real, coarser proxy for "how fast can the GPU be reclaimed by force" when the HTTP API cannot cancel an in-flight job. The process was still alive 3ms after SIGTERM, with CPU% below the 5% idle threshold — not a confirmed kill (SIGTERM may not have fully terminated it within the poll window), so this is NOT reported as a supported process-kill measurement. |
| draw-things | no | unsupported | n/a | Draw Things' HTTP API (/sdapi/v1/txt2img) exposes no cancellation endpoint; a started job runs to completion or app-level user cancel only. |

#### Contact sheets (owner review, no automated quality score)

- sd.cpp (sd-v1-5-pruned-emaonly-Q8_0): `results/images/sdcpp-512-contact-sheet.png`
- draw-things (sd_v1.5_f16.ckpt + pixelartredmond15v_pixelart_pixarfk_lora_f16.ckpt@0.6): `results/images/drawthings-512-contact-sheet.png`
- sd.cpp (sd-v1-5-pruned-emaonly-Q4_0): `results/images/sdcpp-q4-512-contact-sheet.png`

#### Environment provenance

| Artifact | Identifier | Size | License |
| --- | --- | --- | --- |
| sd-server binary | master-921-168f7b8 (sd-master-168f7b8-bin-Darwin-macOS-26.6.2-arm64.zip) | — | see leejet/stable-diffusion.cpp |
| Base checkpoint (Q8_0, recommended — LoRA confirmed working) | second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf) | 1682 MiB | creativeml-openrail-m |
| Base checkpoint (Q4_0, LoRA unreliable, see Caveat) | second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf) | 1494 MiB | creativeml-openrail-m |
| Base checkpoint (f16, comparison-only — LoRA crashes this build, see Caveat) | second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-f16.gguf) | 2034 MiB | creativeml-openrail-m |
| Pixel-art LoRA | artificialguybr/pixelartredmond-1-5v-pixel-art-loras-for-sd-1-5 (PixelArtRedmond15V-PixelArt-PIXARFK.safetensors) | 26 MiB | bespoke-lora-trained-license (CivitAI: allowNoCredit=true, allowCommercialUse=Rent, allowDerivatives=true, allowDifferentLicense=false) — non-commercial-oriented, verify before any content-pack use |

## Findings

- sd.cpp sd-v1-5-pruned-emaonly-Q8_0 @ 512x512, 12 steps: 15 prompts, warmup 37.8s, seconds/image p50/p95 37.3/37.4, peak RSS 2320 MiB, 0 error(s).
- draw-things sd_v1.5_f16.ckpt + pixelartredmond15v_pixelart_pixarfk_lora_f16.ckpt@0.6 @ 512x512, 12 steps: 15 prompts, warmup 6.3s, seconds/image p50/p95 5.7/5.9, peak RSS 257 MiB, 0 error(s).
- sd.cpp sd-v1-5-pruned-emaonly-Q4_0 @ 512x512, 12 steps: 15 prompts, warmup 40.4s, seconds/image p50/p95 37.1/37.3, peak RSS 2164 MiB, 0 error(s).
- Cancellation (sd.cpp): supported=false, outcome=idle-cpu — this sd-server build reports cancel_generating=false, so the in-flight job could not be cancelled over HTTP; SIGINT was tried first and measured to be silently ignored (the process kept running and started its next queued job), so this fell back to SIGTERM on the sd-server process (pid 72164) at ~30% of baseline (11190ms). SIGTERM ends the whole server, not just the one job — a real, coarser proxy for "how fast can the GPU be reclaimed by force" when the HTTP API cannot cancel an in-flight job. The process was still alive 3ms after SIGTERM, with CPU% below the 5% idle threshold — not a confirmed kill (SIGTERM may not have fully terminated it within the poll window), so this is NOT reported as a supported process-kill measurement.
- Cancellation (draw-things): supported=false, outcome=unsupported — Draw Things' HTTP API (/sdapi/v1/txt2img) exposes no cancellation endpoint; a started job runs to completion or app-level user cancel only.
- Draw Things reachability: reachable at port 7860 (ok).

## Bottom line

**stable-diffusion.cpp (sd-v1-5-pruned-emaonly-Q8_0) at 512x512, 12 steps is the recommended base arm profile for ADR-0007** — measured warmup 37.8s, steady-state seconds/image p50/p95 37.3/37.4, peak RSS 2320 MiB. Draw Things was reachable and ran the same SD 1.5 checkpoint + pixel-art LoRA at the same 512x512, 12-step settings as the sd.cpp arm above, but at a **different precision** (sd.cpp Q8_0 vs Draw Things f16) — not an engine-isolating comparison. Draw Things measured 6.5x faster per image (5.7s vs 37.3s p50). This gap is **unexplained and precision-confounded** — quantization is a plausible partial cause and this probe did not isolate it (an f16 sd.cpp + LoRA measurement was attempted and crashed this server build reproducibly; see Caveat). It does not change the base-arm recommendation: stable-diffusion.cpp is cross-platform and must work standalone (owner direction), while Draw Things is a macOS/iOS-only optional add-on with no HTTP-level model/LoRA selection or in-flight cancellation.