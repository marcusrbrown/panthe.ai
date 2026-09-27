# tools/probes

Hardware, provider, renderer, and sandbox probes live in `tools/probes/<name>/`, each with a README recording the method and results.

- [webgpu-wkwebview](webgpu-wkwebview/README.md) — WebGPU-in-WKWebView probe via an unsigned Swift WKWebView script (not a packaged app).
- `renderer-webgl2` (planned) — packaged Three Flatland scene proving D25 (WebGL2 baseline) with measured frame time and input latency (ADR-0002).
- `backend-lifecycle` (planned) — Bun sidecar under Tauri: supervised lifecycle, crash restart, no orphan, no double time advancement (ADR-0003).
- `inference-baseline` (planned) — local model profile measured for schema validity, latency, throughput, and memory with the renderer running (ADR-0005).
- `art-local` (planned) — local pixel-art generation via Draw Things and stable-diffusion.cpp, measured for time, memory, and cancellation (ADR-0007).
- `sandbox` (planned) — QuickJS and Lua adversarial fixture matrix measuring termination behavior for the generated-code runtime (ADR-0004).
- `provider-matrix` (planned) — hosted provider adapters, fallback chain, and an offline-mode packet capture proving no network egress (ADR-0005).
- `coexistence` (planned) — renderer + inference + image generation together on 16 GB, measuring a heavy-work policy recommendation.
- `shared` — harness code shared by every probe: environment capture, README report rendering, timing/percentile helpers, and the action-proposal schema (`@panthea/tools-probes-shared`).
