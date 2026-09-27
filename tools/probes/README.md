# tools/probes

Hardware, provider, renderer, and sandbox probes live in `tools/probes/<name>/`, each with a README recording the method and results.

- [webgpu-wkwebview](webgpu-wkwebview/README.md) — WebGPU-in-WKWebView probe via an unsigned Swift WKWebView script (not a packaged app).
- [renderer-webgl2](renderer-webgl2/README.md) — packaged Three Flatland scene on the WebGL2 backend (D25): 59 fps, 28 ms p50 / 31 ms p95 click-to-visible latency measured on the packaged `.app` (14/14 real clicks), koota CSP constraint (ADR-0002); with `three@0.185.1`'s `WebGPURenderer`, synthetic context loss/restore both occur but the renderer instance stays latched (`_isDeviceLost` never cleared) — automatic same-instance recovery is unavailable in this build, app-managed renderer/canvas reconstruction is untested, sleep/wake is untested.
- [backend-lifecycle](backend-lifecycle/README.md) — Bun sidecar under Tauri: supervised lifecycle, crash restart, no orphan, no double time advancement (ADR-0003).
- [inference-baseline](inference-baseline/README.md) — local model profile measured for schema validity, latency, throughput, and memory with the renderer running: llama3.2:3b @ 4k is the baseline (p95 1.8 s), but 27 characters at parallel=1 already exceed the 30 s cadence threshold (ADR-0005).
- [art-local](art-local/README.md) — local pixel-art generation: stable-diffusion.cpp (`sd-server`, SD 1.5 + pixel-art LoRA, `--diffusion-fa` required for usable Metal performance) is the base arm at 37.2s/image p50, 2035 MiB peak RSS (512x512, 12 steps); Draw Things (optional add-on, same model+LoRA) measured 6.5x faster on the same settings but is macOS-only with no HTTP-level model/LoRA selection or in-flight cancellation (ADR-0007).
- `sandbox` (planned) — QuickJS and Lua adversarial fixture matrix measuring termination behavior for the generated-code runtime (ADR-0004).
- [provider-matrix](provider-matrix/README.md) — hosted provider adapters (OpenCode Go, OpenAI/Anthropic by contract), a fallback chain, and an offline-mode packet-capture proof; OpenCode Zen's `zen/v1` free tier is a scope note (unconditional 403 from a non-public service), so the OpenCode arm is Go, free models first (ADR-0005).
- `coexistence` (planned) — renderer + inference + image generation together on 16 GB, measuring a heavy-work policy recommendation.
- `shared` — harness code shared by every probe: environment capture, README report rendering, timing/percentile helpers, and the action-proposal schema (`@panthea/tools-probes-shared`).
