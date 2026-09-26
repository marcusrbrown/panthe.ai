# 0005: Model providers

## Status

Proposed. Confirmation requires the M0 baseline-inference and provider probes.

## Context

D02 requires full offline capability with optional hosted models; D22 requires a configured fallback sequence with no silent hosted fallback in offline mode; P06/P07 require guided local setup, role-based model assignment, and optional mixed local/hosted providers with measured fallback behavior.

## Decision

Local serving: Ollama v0.34.4 is the first candidate (native `/api` and OpenAI-compatible endpoints, JSON Schema via `format`/`response_format`, tool calling). `llama-server` (llama.cpp) is the alternate if Ollama's concurrency or schema handling proves insufficient. Candidate models for the first comparison: Qwen3.5-4B (Q4), Gemma 4 E2B/E4B, Ministral 3 3B/8B Instruct, Phi-4-mini-instruct — selected on a fixed action-schema eval, not tokens/sec alone.

Hosted: API-key authentication only. OpenAI and Anthropic use their documented console API keys; OpenCode Go uses its documented API key with per-model endpoints (chat/completions vs. responses wire format differs by model — use the live model table, not a single hardcoded path). No hosted provider uses reused subscription-login/OAuth tokens from an unrelated app.

Provider abstraction candidate: Vercel AI SDK 7 (`ai@7.0.93`) with `@ai-sdk/openai-compatible` for Ollama/llama.cpp/OpenCode Go, and `@ai-sdk/openai`/an Anthropic adapter for their native APIs. Verify the v7 structured-output API against the pinned version before relying on it.

On the 16 GB baseline, serialize heavy LLM inference and image generation — run one heavy model at a time, short contexts, `parallel=1` on the local server, queued image jobs.

## Consequences

Model quality/latency tradeoffs are probe outputs, not fixed here. If the AI SDK's structured-output support doesn't match the pinned version's documented behavior, provider adapters may need to be hand-rolled per provider instead of going through one abstraction. Serializing LLM and image work bounds peak memory but caps effective throughput on the baseline machine; the M4 Pro profile can relax this.

## Evidence/links

[inference-2026-09-26.md](../research/inference-2026-09-26.md) local LLM serving and hosted provider authentication sections; [technical-constraints.md](../product/technical-constraints.md) model and image adapters.

## Requirement IDs

P06, P07, D22.
