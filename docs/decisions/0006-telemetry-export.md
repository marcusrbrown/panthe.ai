# 0006: Telemetry export

## Status

Local trace store: accepted (2026-09-28); see the note under Consequences. External export: proposed. Confirmation of export requires the M6 telemetry probe (endpoint export, redaction, retention, outage behavior).

## Context

D16 requires full local inspection plus configurable hosted telemetry export; O04–O06 require an inspectable causal chain locally and optional correlated export to Langfuse/OpenTelemetry tooling without making the full observability stack a baseline dependency.

## Decision

Store traces locally first; the full local trace/event store is the source of truth for the in-game inspector (O04) regardless of export configuration. When export is configured, use an OTLP/HTTP exporter targeting Langfuse v4's `/api/public/otel` endpoint (HTTP/protobuf, Basic auth from public/secret keys). Pin the GenAI semantic-conventions version used for `gen_ai.*` span attributes rather than tracking a moving target. Bun's compatibility with the OTel JS SDK (`@langfuse/tracing`, `@langfuse/otel`, Node ≥20 documented, Bun unstated) must be tested directly — manual spans, OTLP/HTTP export, and flush behavior — before this ADR moves to Accepted.

## Consequences

Export failure must never stop or degrade the simulation (D16); local telemetry keeps working independent of endpoint reachability. A full self-hosted Langfuse deployment (web + worker + Postgres + ClickHouse + Redis + object storage) is explicitly not a baseline dependency — it's an operator-configured external target.

**2026-09-28, local trace store accepted.** Always-on local causal recording and inspection is implemented in [packages/telemetry](../../packages/telemetry/src/index.ts) and exercised end to end by the sidecar: observation records, proposal outcomes (committed and rejected), and presentation receipts, linked by correlation and causation IDs ([trace.ts](../../packages/telemetry/src/trace.ts)), with `followEvent` and `followProposal` walking the chain ([query.ts](../../packages/telemetry/src/query.ts)). The sidecar serves the chain at `GET /trace/event` and `GET /trace/proposal` ([apps/simulation/src/server.ts](../../apps/simulation/src/server.ts)). The store needs no endpoint, key, or network, so it works offline. The state model it sits beside is in [ADR-0008](0008-world-state-and-client-transport.md). M1 keeps every causal record for the life of the world; retention pruning (O05) and the seven-day default in [defaults.md](../product/defaults.md) are not implemented. No credential-bearing data enters trace construction, so the local store has no redaction step; add one at the write boundary before any producer passes credential-bearing data into a trace record.

**2026-09-28, trace linkage and restore limit.** `trace_outcome_events` links every event a committed proposal produced to that proposal in commit order, so following an event resolves the proposal that caused it, including when two proposals cite one observation ([trace.ts](../../packages/telemetry/src/trace.ts)). Archives carry world state and the external proposal journal with each entry's outcome, but not trace records ([ADR-0008](0008-world-state-and-client-transport.md)), so a restored branch has no causal trace before the restore; its chains start at the restore. The headless [M1 scenario](../../tools/scenarios/m1-living-world/README.md) walks a strike's ignition from its observation to the client's presentation receipt (S15).

The export decision above is unchanged: external export remains proposed, opt-in, and unimplemented, and the Bun/OTel compatibility test still gates it.

## Evidence/links

[inference-2026-09-26.md](../research/inference-2026-09-26.md) Langfuse and OpenTelemetry section; [technical-constraints.md](../product/technical-constraints.md) observability section.

## Requirement IDs

O04, O05, O06, D16.
