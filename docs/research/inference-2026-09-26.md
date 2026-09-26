# Inference, providers, image generation, telemetry, and service lifecycle

Reviewed 2026-09-26 from linked documentation. No hardware benchmarks were run; M0 probes measure the actual workload.

## Local LLM serving (M1 Pro, 16 GB)

| Server | API | Concurrency and caveats |
| --- | --- | --- |
| Ollama v0.34.4 | Native `/api` and OpenAI-compatible; JSON Schema via `format` / `response_format`; tool calling | `OLLAMA_NUM_PARALLEL`; parallel sequences multiply KV-cache memory. <https://docs.ollama.com/api> |
| llama.cpp `llama-server` | OpenAI-compatible chat/responses/embeddings; schema-constrained JSON; Metal | `-np N` slots; continuous batching default. Pin a release artifact. <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md> |
| LM Studio | OpenAI-compatible; structured output; tool use | Max Concurrent Predictions (default 4) on llama.cpp engine. <https://lmstudio.ai/docs/developer/openai-compat> |
| mlx-lm server | OpenAI-style chat completions | Not recommended for production; basic security only. <https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md> |

Candidate models for the first comparison: Qwen3.5-4B Q4 (community M1 Pro 16 GB: ~50 tok/s, 4.2 GB peak at 4K context on oMLX), Gemma 4 E2B/E4B (E4B is 8B with embeddings), Ministral 3 3B/8B Instruct (Apache 2.0), Phi-4-mini-instruct 3.8B (MIT, function calling), Llama 3.2 1B/3B as baselines. Do not select on tokens/s alone; use a fixed action-schema eval.

Memory: unified memory pool shared by renderer, LLM weights/KV, and image model. Inference: run one heavy model at a time, short contexts, `parallel=1`, queued image jobs. Test with the renderer running.

## Hosted provider authentication

- OpenAI: API key only. No documented third-party OAuth/device flow for ChatGPT subscriptions. <https://developers.openai.com/api/docs/libraries>
- Anthropic: Console API key (`x-api-key`) or workload identity. Claude Code OAuth is product-internal; third parties may not offer Claude.ai login. <https://platform.claude.com/docs/en/api/overview>
- OpenCode Go: documented API key with model-specific endpoints, e.g. `https://opencode.ai/zen/go/v1/chat/completions` (`@ai-sdk/openai-compatible`) and `https://opencode.ai/zen/go/v1/responses` (`@ai-sdk/openai`). Endpoint/wire format is per model; use the live model table. <https://opencode.ai/docs/go>
- Vercel AI SDK `ai@7.0.93`; `@ai-sdk/openai-compatible` for Ollama/llama.cpp/Go. Verify v7 structured-output API before pinning. <https://github.com/vercel/ai/releases>

## Local image generation

| Option | Interface | Platform |
| --- | --- | --- |
| stable-diffusion.cpp | CLI + `sd-server` HTTP; Metal | Cross-platform. <https://github.com/leejet/stable-diffusion.cpp> |
| Draw Things | HTTP/gRPC API server + `draw-things-cli` | macOS/iOS only. <https://docs.drawthings.ai/> |
| ComfyUI | HTTP `/prompt` with API-format workflow | Python; cross-platform; heavy dependency. |
| mflux | CLI/Python subprocess | Apple MLX only. |
| Diffusers | Python worker | Cross-platform; MPS on macOS. |

Model fit: start with SD 1.5 at 512px plus a pixel-art LoRA (PixelArt.Redmond 1.5V; `pixel_dream_LORA` — verify licenses). SDXL-Turbo and FLUX quantized variants are benchmark tasks, not assumptions. No verified M1 Pro 16 GB seconds-per-image figure.

## Langfuse and OpenTelemetry

- Langfuse server v4 (`v4.45.4`, 2026-09-25). Self-hosting: web + worker + PostgreSQL + ClickHouse + Redis/Valkey + object storage. Not a baseline local dependency. <https://langfuse.com/self-hosting>
- Ingestion: OTLP/HTTP at `/api/public/otel` (+ `/v1/traces`), HTTP/protobuf, Basic auth from public/secret keys. <https://langfuse.com/docs/observability/features/opentelemetry>
- JS SDK: v5 current; `@langfuse/tracing` and `@langfuse/otel` are OTel-based; Node ≥20; Bun compatibility not stated. Test manual spans + OTLP/HTTP exporter + flush in Bun.
- GenAI semantic conventions moved to `semantic-conventions-genai`; `gen_ai.*` evolving; pin the convention version.

## Generated-code sandbox

Recommendation: `quickjs-emscripten` (README lists Bun) with a fresh runtime per execution, `setMemoryLimit`, `setMaxStackSize`, `setInterruptHandler`, module loading disabled, no host bridge beyond validated game operations, and an outer wall-clock timeout. wasmoon (Lua 5.4) remains viable only with tight library restriction and no documented fuel metering. Raw WebAssembly in Bun has no fuel metering. Test OOM/timeout recovery on the pinned build (QuickJS low-memory crash reports exist).

## Backend lifecycle in Tauri

- System tray: hide on close, explicit Quit. <https://v2.tauri.app/plugin/system-tray/>
- Sidecar spawn is not a detachment guarantee; keep the handle, shut down explicitly; orphan reports exist.
- Autostart plugin registers Launch Agents but is not a supervisor.
- Recommendation: app stays alive in tray mode with the service as a supervised child; a service that outlives the app is a separate OS-managed agent with authenticated local IPC (more install/upgrade complexity).
