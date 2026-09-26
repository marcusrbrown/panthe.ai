# 0006: Telemetry export

## Status

Proposed. Confirmation requires the M6 telemetry probe (local recording, endpoint export, redaction, retention, outage behavior).

## Context

D16 requires full local inspection plus configurable hosted telemetry export; O04–O06 require an inspectable causal chain locally and optional correlated export to Langfuse/OpenTelemetry tooling without making the full observability stack a baseline dependency.

## Decision

Store traces locally first; the full local trace/event store is the source of truth for the in-game inspector (O04) regardless of export configuration. When export is configured, use an OTLP/HTTP exporter targeting Langfuse v4's `/api/public/otel` endpoint (HTTP/protobuf, Basic auth from public/secret keys). Pin the GenAI semantic-conventions version used for `gen_ai.*` span attributes rather than tracking a moving target. Bun's compatibility with the OTel JS SDK (`@langfuse/tracing`, `@langfuse/otel`, Node ≥20 documented, Bun unstated) must be tested directly — manual spans, OTLP/HTTP export, and flush behavior — before this ADR moves to Accepted.

## Consequences

Export failure must never stop or degrade the simulation (D16); local telemetry keeps working independent of endpoint reachability. A full self-hosted Langfuse deployment (web + worker + Postgres + ClickHouse + Redis + object storage) is explicitly not a baseline dependency — it's an operator-configured external target.

## Evidence/links

[inference-2026-09-26.md](../research/inference-2026-09-26.md) Langfuse and OpenTelemetry section; [technical-constraints.md](../product/technical-constraints.md) observability section.

## Requirement IDs

O04, O05, O06, D16.
