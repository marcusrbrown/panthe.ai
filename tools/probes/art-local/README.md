## Question

Which local image-generation arm meets the offline pixel-art-generation profile for ADR-0007 on the M1 Pro 16GB baseline — seconds/image, peak RSS, first-image warmup, and cancellation — and can it settle the base arm without depending on Draw Things?

## How to run

**Staging (prerequisite, not timed):**

Download the pinned `stable-diffusion.cpp` release (macOS arm64) into `tools/probes/art-local/bin/` (gitignored; tag/sha256 recorded below):

```sh
curl -sL -o sd.zip https://github.com/leejet/stable-diffusion.cpp/releases/download/master-921-168f7b8/sd-master-168f7b8-bin-Darwin-macOS-26.6.2-arm64.zip
unzip sd.zip -d bin/
```

Download the SD 1.5 checkpoint and pixel-art LoRA into `tools/probes/art-local/models/` (gitignored; identifiers/sha256 recorded below):

```sh
curl -sL -o models/sd-v1-5-pruned-emaonly-Q4_0.gguf https://huggingface.co/second-state/stable-diffusion-v1-5-GGUF/resolve/main/stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf
curl -sL -o models/loras/PixelArtRedmond15V-PixelArt-PIXARFK.safetensors https://huggingface.co/artificialguybr/pixelartredmond-1-5v-pixel-art-loras-for-sd-1-5/resolve/main/PixelArtRedmond15V-PixelArt-PIXARFK.safetensors
```

Launch `sd-server` (Metal backend on macOS arm64 — `--diffusion-fa` is not optional, see Caveat: the same generation measured ~5x slower without it):

```sh
./bin/sd-server --model models/sd-v1-5-pruned-emaonly-Q4_0.gguf --lora-model-dir models/loras --listen-port 1234 --diffusion-fa
```

Draw Things (optional add-on, owner-installed 26.0924.0): Settings → API Server → enable HTTP on 127.0.0.1:7860; select the same base model + LoRA in-app for a like-for-like comparison (no HTTP model/LoRA selection exists, see Caveat). Never leave it enabled after a run — localhost is not a security boundary here, any local process can drive it.

**Suite** (per arm):

```sh
cd tools/probes/art-local
bun run src/run.ts suite --arm sd.cpp --base-url http://127.0.0.1:1234 \
  --width 512 --height 512 --steps 12 \
  --lora-path PixelArtRedmond15V-PixelArt-PIXARFK.safetensors --lora-multiplier 0.6 \
  --rss-pid <sd-server-pid> --label sdcpp-512

bun run src/run.ts suite --arm draw-things --base-url http://127.0.0.1:7860 \
  --width 512 --height 512 --steps 12 --rss-pid <DrawThings-pid> --label drawthings-512
```

`--model` is optional for `--arm sd.cpp` (defaults to a literal description) but required in practice for a meaningful README row; for `--arm draw-things` it is auto-read from `GET /sdapi/v1/options` (the app's own selection) if omitted. `--rss-pid` is the generator process's own pid (`pgrep -f sd-server`, or Draw Things' pid from Activity Monitor/`ps`) — the sampler polls its RSS every 250ms and records the peak.

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

Draw Things is an OPTIONAL add-on arm (owner direction): stable-diffusion.cpp is the base arm and must work, and settles, standalone. Draw Things was reachable at port 7860 and its measured numbers appear in the table below as an optional add-on arm. Draw Things' HTTP surface (`/sdapi/v1/txt2img`, A1111-shaped) has no model/LoRA selection, no model list, and no cancellation — the active model is whatever the app has selected. This probe reads the selected model from `GET /sdapi/v1/options` (Draw Things' own settings dict, keyed `model`, not the vanilla A1111/stable-diffusion.cpp-compat `sd_model_checkpoint` key) and records it per run rather than assuming it. Qwen Image 2.1 under Draw Things ships under the Qwen Research License (non-commercial). Panthea is noncommercial (D01), so it is allowed for evaluation only; a commercial fork would need a different default (see docs/decisions/0007-local-image-generation.md). 16GB three-way coexistence (renderer + inference + image generation together) is out of scope here — that is Unit 8's `tools/probes/coexistence` measurement, not this probe's. Pixel-art styling on the sd.cpp arm comes from a LoRA (artificialguybr/pixelartredmond-1-5v-pixel-art-loras-for-sd-1-5 (PixelArtRedmond15V-PixelArt-PIXARFK.safetensors)), not a pixel-art-tuned base checkpoint — no single-file pixel-art-tuned SD 1.5 checkpoint in a stable-diffusion.cpp-loadable format (safetensors/ckpt/GGUF) was found within this probe's time budget; the base checkpoint is plain SD 1.5 (second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf)). LoRA license: bespoke-lora-trained-license (CivitAI: allowNoCredit=true, allowCommercialUse=Rent, allowDerivatives=true, allowDifferentLicense=false) — non-commercial-oriented, verify before any content-pack use. LoRA trigger-word placement matters: the PixelArtRedmond LoRA only reliably triggers when `PixArFK` is the FIRST token of the prompt (e.g. `PixArFK, pixel art, ...`), not mid-string (e.g. `pixel art, PixArFK, ...`) — confirmed by the owner against the live Draw Things app and applied to every prompt in `prompts.json` for both arms. `--diffusion-fa` (flash attention) is not optional for usable sd-server performance on this Metal build: the same 512x512, 12-step, no-LoRA generation measured ~127s without it and ~24s with it — roughly a 5x difference — so every sd.cpp arm number in this README was measured with `--diffusion-fa` enabled; running without it is not a viable base-arm configuration. This sd-server build's native `sdcpp` API reports `cancel_generating: false` in `GET /sdcpp/v1/capabilities` — `POST /sdcpp/v1/jobs/{id}/cancel` only works on a job still queued behind another, not one already generating, so it cannot interrupt the single in-flight job this probe's cancellation test submits. SIGINT to the `sd-server` process was tried first and measured to be silently ignored (the process kept running and started its next queued job); SIGTERM reliably terminates it. The recorded cancel-to-idle number is therefore a whole-process-kill proxy, not a graceful in-job cancel. Draw Things' sampled process RSS peak (257 MiB) is likely a lower bound, not the true resident footprint: an SD 1.5 f16 checkpoint is roughly 2GB on disk, so Metal/GPU-resident unified-memory buffers are probably not fully reflected in `ps`'s RSS column for this app — recorded as sampled, not corrected.

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
| SD 1.5 checkpoint | second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf) |
| Pixel-art LoRA | artificialguybr/pixelartredmond-1-5v-pixel-art-loras-for-sd-1-5 (PixelArtRedmond15V-PixelArt-PIXARFK.safetensors) |

## Results

#### Per-arm results

| Arm | Model | Size | Steps | n | Warmup (s) | s/image p50 | s/image p95 | Peak RSS | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sd.cpp | sd1.5-q4_0+diffusion-fa+pixelart-lora@0.6 | 512x512 | 12 | 15 | 37.7 | 37.2 | 38.1 | 2035 MiB | 0 |
| draw-things | sd_v1.5_f16.ckpt + pixelartredmond15v_pixelart_pixarfk_lora_f16.ckpt@0.6 | 512x512 | 12 | 15 | 6.3 | 5.7 | 5.9 | 257 MiB | 0 |

#### Cancellation

| Arm | Supported | Cancel-to-idle | Note |
| --- | --- | --- | --- |
| sd.cpp | yes | 7ms | this sd-server build reports cancel_generating=false, so the in-flight job could not be cancelled over HTTP; SIGINT was tried first and measured to be silently ignored (the process kept running and started its next queued job), so this fell back to SIGTERM on the sd-server process (pid 62542) at ~30% of baseline (16200ms) and measured time-to-idle (cpu-below-threshold). SIGTERM ends the whole server, not just the one job — a real, coarser proxy for "how fast can the GPU be reclaimed by force" when the HTTP API cannot cancel an in-flight job. |
| draw-things | no | n/a | Draw Things' HTTP API (/sdapi/v1/txt2img) exposes no cancellation endpoint; a started job runs to completion or app-level user cancel only. |

#### Contact sheets (owner review, no automated quality score)

- sd.cpp (sd1.5-q4_0+diffusion-fa+pixelart-lora@0.6): `results/images/sdcpp-512-contact-sheet.png`
- draw-things (sd_v1.5_f16.ckpt + pixelartredmond15v_pixelart_pixarfk_lora_f16.ckpt@0.6): `results/images/drawthings-512-contact-sheet.png`

#### Environment provenance

| Artifact | Identifier | Size | License |
| --- | --- | --- | --- |
| sd-server binary | master-921-168f7b8 (sd-master-168f7b8-bin-Darwin-macOS-26.6.2-arm64.zip) | — | see leejet/stable-diffusion.cpp |
| Base checkpoint | second-state/stable-diffusion-v1-5-GGUF (stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf) | 1494 MiB | creativeml-openrail-m |
| Pixel-art LoRA | artificialguybr/pixelartredmond-1-5v-pixel-art-loras-for-sd-1-5 (PixelArtRedmond15V-PixelArt-PIXARFK.safetensors) | 26 MiB | bespoke-lora-trained-license (CivitAI: allowNoCredit=true, allowCommercialUse=Rent, allowDerivatives=true, allowDifferentLicense=false) — non-commercial-oriented, verify before any content-pack use |

## Findings

- sd.cpp sd1.5-q4_0+diffusion-fa+pixelart-lora@0.6 @ 512x512, 12 steps: 15 prompts, warmup 37.7s, seconds/image p50/p95 37.2/38.1, peak RSS 2035 MiB, 0 error(s).
- draw-things sd_v1.5_f16.ckpt + pixelartredmond15v_pixelart_pixarfk_lora_f16.ckpt@0.6 @ 512x512, 12 steps: 15 prompts, warmup 6.3s, seconds/image p50/p95 5.7/5.9, peak RSS 257 MiB, 0 error(s).
- Cancellation (sd.cpp): supported=true, cancel-to-idle 7ms — this sd-server build reports cancel_generating=false, so the in-flight job could not be cancelled over HTTP; SIGINT was tried first and measured to be silently ignored (the process kept running and started its next queued job), so this fell back to SIGTERM on the sd-server process (pid 62542) at ~30% of baseline (16200ms) and measured time-to-idle (cpu-below-threshold). SIGTERM ends the whole server, not just the one job — a real, coarser proxy for "how fast can the GPU be reclaimed by force" when the HTTP API cannot cancel an in-flight job.
- Cancellation (draw-things): supported=false — Draw Things' HTTP API (/sdapi/v1/txt2img) exposes no cancellation endpoint; a started job runs to completion or app-level user cancel only.
- Draw Things reachability: reachable at port 7860 (ok).

## Bottom line

**stable-diffusion.cpp (sd1.5-q4_0+diffusion-fa+pixelart-lora@0.6) at 512x512, 12 steps is the base arm profile for ADR-0007** — measured warmup 37.7s, steady-state seconds/image p50/p95 37.2/38.1, peak RSS 2035 MiB. Draw Things was reachable and ran the same SD 1.5 checkpoint + pixel-art LoRA at the same 512x512, 12-step settings as the base arm — a like-for-like comparison. Draw Things measured 6.5x faster per image (5.7s vs 37.2s p50) at a fraction of the sampled process RSS, on the same weights and LoRA — a real, measured gap this probe does not explain (candidates: a more mature Metal attention/kernel path in Draw Things' inference engine vs this stable-diffusion.cpp build's newer flash-attention support and Q4_0 "apply lora at runtime" overhead; unverified, worth a follow-up probe). It does not change the base-arm recommendation: stable-diffusion.cpp is cross-platform and must work standalone (owner direction), while Draw Things is a macOS/iOS-only optional add-on with no HTTP-level model/LoRA selection or in-flight cancellation.