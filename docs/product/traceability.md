# Requirement traceability

Update this table in every PR that touches a requirement. Milestone is the stage from [mvp-roadmap.md](mvp-roadmap.md) where the requirement's main implementation work happens; several requirements are re-verified at later milestones (see the roadmap's "Main requirements" column). Status starts at "planned" for every requirement and moves to "scaffolded", "implemented", or "verified" as work lands; amendments to accepted requirement wording are noted inline. Implementation is the primary source path once code exists; Evidence is the probe report, ADR, or test record backing the current status.

| ID | Milestone | Status | Implementation | Evidence |
| --- | --- | --- | --- | --- |
| P01 | M7 | planned | — | — |
| P02 | M0 | planned (amended by D25 / ADR-0002; packaged evidence: 59 fps, 28ms p50/31ms p95 click latency; context-loss reconstruction shown in a browser repro only, packaged recovery untested) | apps/probe-renderer/ | tools/probes/webgpu-wkwebview/README.md, tools/probes/renderer-webgl2/repro/device-loss.html, tools/probes/renderer-webgl2/README.md, docs/decisions/0002-renderer-backend.md, docs/product/technical-constraints.md, tools/probes/coexistence/README.md |
| P03 | M0 | planned (Bun sidecar shape confirmed by ADR-0003) | package.json (workspaces), bun.lock, .github/workflows/ci.yaml, tools/probes/shared/, apps/desktop/src-tauri/ | docs/decisions/0001-workspace-and-tooling.md, docs/decisions/0003-simulation-service.md, tools/probes/README.md, tools/probes/backend-lifecycle/README.md |
| P04 | M0 | planned (baseline llama3.2:3b @ 4K; gemma4:e4b quality runner-up) | — | tools/probes/inference-baseline/README.md, tools/probes/inference-baseline/results/summary.json, tools/probes/coexistence/README.md, docs/decisions/0005-model-providers.md |
| P05 | M0 | planned (Linux gated on a packaged either-backend probe, ADR-0002) | — | docs/decisions/0002-renderer-backend.md, tools/probes/renderer-webgl2/README.md, tools/probes/coexistence/README.md |
| P06 | M0 | planned (schedule budget ~39 turns/min at the baseline p95; gods-first/inhabitants-on-routines allocation, ADR-0005) | — | tools/probes/inference-baseline/README.md, tools/probes/inference-baseline/results/summary.json, tools/probes/coexistence/README.md, docs/decisions/0005-model-providers.md |
| P07 | M0 | planned (offline wire proof: silent + positive control, probe router only; Go arm confirmed, Zen scope note, ADR-0005) | — | tools/probes/provider-matrix/README.md, docs/decisions/0005-model-providers.md |
| P08 | M7 | planned | — | — |
| W01 | M2 | planned | — | — |
| W02 | M1 | planned | — | — |
| W03 | M1 | planned (offscreen tick continuity + capped catch-up confirmed by the backend-lifecycle probe, ADR-0003) | — | tools/probes/backend-lifecycle/README.md, docs/decisions/0003-simulation-service.md |
| W04 | M2 | planned | — | — |
| W05 | M1 | planned | — | — |
| W06 | M1 | planned | — | — |
| W07 | M1 | planned | — | — |
| W08 | M1 | planned | — | — |
| W09 | M2 | planned | — | — |
| W10 | M2 | planned | — | — |
| W11 | M3 | planned | — | — |
| M01 | M3 | planned | — | — |
| M02 | M3 | planned | — | — |
| M03 | M3 | planned | — | — |
| M04 | M3 | planned | — | — |
| M05 | M3 | planned | — | — |
| M06 | M3 | planned | — | — |
| M07 | M3 | planned | — | — |
| M08 | M3 | planned | — | — |
| U01 | M4 | planned | — | — |
| U02 | M4 | planned | — | — |
| U03 | M4 | planned | — | — |
| U04 | M4 | planned (0 escapes across adversarial fixtures after the descriptor-capture fix; QuickJS recommended, ADR-0004) | — | tools/probes/sandbox/README.md, docs/decisions/0004-generated-behavior-runtime.md |
| U05 | M0 | planned (generated-runtime boundary confirmed: subprocess wall-clock/RSS supervisor is the real limit, not `setMemoryLimit`, ADR-0004) | — | tools/probes/sandbox/README.md, docs/decisions/0004-generated-behavior-runtime.md |
| U06 | M0 | planned (stable-diffusion.cpp Q8_0 + pixel-art LoRA base arm, 37.3s/image p50, ADR-0007) | — | tools/probes/art-local/README.md, tools/probes/coexistence/README.md, docs/decisions/0007-local-image-generation.md |
| U07 | M4 | planned (placeholder-then-hot-swap confirmed deterministic; cancellation is SIGTERM-only on sd.cpp, no HTTP cancel, ADR-0007) | — | tools/probes/art-local/README.md, tools/probes/coexistence/README.md, docs/decisions/0007-local-image-generation.md |
| U08 | M4 | planned | — | — |
| X01 | M5 | planned | — | — |
| X02 | M5 | planned | — | — |
| X03 | M5 | planned | — | — |
| X04 | M5 | planned | — | — |
| X05 | M5 | planned | — | — |
| X06 | M5 | planned | — | — |
| O01 | M1 | planned | — | — |
| O02 | M6 | planned | — | — |
| O03 | M1 | planned (5/5 lifecycle transitions pass; sleep/resume interval applied exactly once, ADR-0003) | — | tools/probes/backend-lifecycle/README.md, docs/decisions/0003-simulation-service.md |
| O04 | M1 | planned | — | — |
| O05 | M6 | planned | — | — |
| O06 | M6 | planned | — | — |
| O07 | M6 | planned | — | — |
| O08 | M7 | planned | — | — |
