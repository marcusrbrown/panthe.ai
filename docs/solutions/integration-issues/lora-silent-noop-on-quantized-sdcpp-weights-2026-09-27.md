---
title: A LoRA on a quantized stable-diffusion.cpp checkpoint can silently no-op
date: 2026-09-27
category: integration-issues
module: art-local
problem_type: integration_issue
component: tooling
symptoms:
  - a LoRA had no visible effect on a Q4_0 quantized checkpoint despite the server logging `(576/576) LoRA tensors have been applied`
  - prompt text alone produced pixel-art-ish output, so nothing in the response, logs, timings, or memory numbers distinguished a working arm from a broken one
root_cause: wrong_api
resolution_type: config_change
severity: medium
tags: [stable-diffusion-cpp, lora, quantization, q8-0, q4-0, fixed-seed, u06, u07]
---

# A LoRA on a quantized stable-diffusion.cpp checkpoint can silently no-op

## Problem

`sd-server` accepts a `lora: [{ path, multiplier }]` body field and reports success regardless of
the base checkpoint's quantization. On Q4_0 SD 1.5 the PixelArtRedmond LoRA had no visible
effect while the server logged `(576/576) LoRA tensors have been applied` — and because the
prompt text alone ("pixel art, 32x32 game asset…") produces pixel-art-ish output, nothing in the
response, logs, timings, or memory numbers distinguished a working arm from a broken one. The
owner caught it from the contact sheet on [PR #21](https://github.com/marcusrbrown/panthea/pull/21).

## Method

For each quantization, generate the same prompt at a fixed seed twice: once with the `lora` field
in the request body, once with it omitted (`tools/probes/art-local/src/sdcpp.ts`,
`submitImgGen`). Compare the two images visually or by pixel diff. A working pairing shows a
clearly styled image; a no-op shows two near-identical images.

```sh
# with LoRA (base arm as documented)
bun run src/run.ts suite --arm sd.cpp --base-url http://127.0.0.1:1234 \
  --model sd-v1-5-pruned-emaonly-Q8_0 --width 512 --height 512 --steps 12 \
  --lora-path PixelArtRedmond15V-PixelArt-PIXARFK.safetensors --lora-multiplier 0.6 \
  --rss-pid <sd-server-pid> --label sdcpp-512
# control: same command without --lora-path/--lora-multiplier
```

## Result

| Arm | LoRA effect (fixed-seed A/B) | Warmup | p50 | Peak RSS |
|---|---|---|---|---|
| Q4_0 | **none visible** — with/without near-identical; one prompt collapsed to a blank frame either way | 40.4 s | 37.1 s | 2164 MiB |
| Q8_0 | unmistakable — off-prompt drift without, correct styled subject with | 37.8 s | 37.3 s | 2320 MiB |
| f16 | not measurable — crashes inside `LoraModel::apply` (`ggml-backend.cpp:930 … (MTL0) … (ADD)`) | — | — | — |

Numbers from `tools/probes/art-local/results/summary.json`; contact sheets for Q8_0
(`sdcpp-512`), Q4_0 (`sdcpp-q4-512`) and Draw Things under `results/images/`.

## Why This Works

The fixed-seed A/B isolates the LoRA's contribution from the prompt's. Upstream documents the
precision hazard: at the pinned tag, `docs/lora.md` says the "immediately" apply mode "may have
precision and compatibility issues with quantized parameters"
([leejet/stable-diffusion.cpp@master-921-168f7b8 docs/lora.md#L24](https://github.com/leejet/stable-diffusion.cpp/blob/master-921-168f7b8/docs/lora.md#L24)).
The measured no-op at Q4_0 and the clean result at Q8_0 match that warning; which apply mode
`sd-server` selects for a quantized checkpoint was not verified here, so the finding is recorded
as measured behaviour, not a mechanism. (The probe's `buildQuantizationLoraReliabilityCaveat`
comment attributes the warning to the runtime path generally — tighten that wording when next
touched.)

## Decision

Q8_0 is the base-arm quantization in [ADR-0007](../../decisions/0007-local-image-generation.md).
Q4_0 rows stay in the table as speed/RSS reference, flagged effectively no-LoRA. The Draw Things
comparison (f16 in-app) is precision-confounded and says nothing engine-isolating until an f16
sd.cpp + LoRA run exists. The trigger word `PixArFK` must be the first prompt token.

## Prevention

- Never accept apply logs, HTTP 202s, or tensor counts as evidence a LoRA took effect.
- Fixed-seed with/without before publishing any LoRA number or choosing a quantization.
- Record precision per arm in every cross-arm table so a speed gap isn't mistaken for an engine
  difference.
- Keep the Q4_0 contact sheet committed as the evidence of the failure mode.

## Re-check

A new stable-diffusion.cpp release, a new LoRA, a new base checkpoint, or a new quantization —
run the A/B again. If Q8_0 stops showing a clear delta, this record is stale. If a fixed build
lands, retry f16 + LoRA to get the precision-matched Draw Things comparison.

## Related Issues

- [ADR-0007 Local image generation](../../decisions/0007-local-image-generation.md)
- [U06, U07](../../product/requirements.md), [D15](../../product/decisions.md)
- [stable-diffusion.cpp needs --diffusion-fa and has no real job cancellation](sdcpp-cancel-sigint-diffusion-fa-2026-09-27.md)
  — same arm, different failure mode
- [tools/probes/art-local/README.md](../../../tools/probes/art-local/README.md),
  [PR #21](https://github.com/marcusrbrown/panthea/pull/21)
