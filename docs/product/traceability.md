# Requirement traceability

Update this table in every PR that touches a requirement. Milestone is the stage from [mvp-roadmap.md](mvp-roadmap.md) where the requirement's main implementation work happens; several requirements are re-verified at later milestones (see the roadmap's "Main requirements" column). Status starts at "planned" for every requirement and moves to "scaffolded", "implemented", or "verified" as work lands; amendments to accepted requirement wording are noted inline. Implementation is the primary source path once code exists; Evidence is the probe report, ADR, or test record backing the current status.

| ID | Milestone | Status | Implementation | Evidence |
| --- | --- | --- | --- | --- |
| P01 | M7 | planned | — | — |
| P02 | M0 | planned (amended by D25 / ADR-0002) | apps/probe-renderer/ | tools/probes/webgpu-wkwebview/README.md, tools/probes/renderer-webgl2/README.md, docs/decisions/0002-renderer-backend.md, docs/product/technical-constraints.md |
| P03 | M0 | planned | package.json (workspaces), bun.lock, .github/workflows/ci.yaml, tools/probes/shared/, apps/desktop/src-tauri/ | docs/decisions/0001-workspace-and-tooling.md, tools/probes/README.md, tools/probes/backend-lifecycle/README.md |
| P04 | M0 | planned (baseline llama3.2:3b @ 4K; gemma4:e4b quality runner-up) | — | tools/probes/inference-baseline/README.md, tools/probes/inference-baseline/results/summary.json |
| P05 | M0 | planned (Linux gated on a packaged either-backend probe, ADR-0002) | — | docs/decisions/0002-renderer-backend.md, tools/probes/renderer-webgl2/README.md |
| P06 | M0 | planned (schedule budget ~39 turns/min at the baseline p95) | — | tools/probes/inference-baseline/README.md, tools/probes/inference-baseline/results/summary.json |
| P07 | M0 | planned (offline wire proof: silent + positive control, probe router only) | — | tools/probes/provider-matrix/README.md |
| P08 | M7 | planned | — | — |
| W01 | M2 | planned | — | — |
| W02 | M1 | planned | — | — |
| W03 | M1 | planned | — | tools/probes/backend-lifecycle/README.md |
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
| U04 | M4 | planned | — | tools/probes/sandbox/README.md |
| U05 | M0 | planned | — | tools/probes/sandbox/README.md |
| U06 | M0 | planned | — | — |
| U07 | M4 | planned | — | — |
| U08 | M4 | planned | — | — |
| X01 | M5 | planned | — | — |
| X02 | M5 | planned | — | — |
| X03 | M5 | planned | — | — |
| X04 | M5 | planned | — | — |
| X05 | M5 | planned | — | — |
| X06 | M5 | planned | — | — |
| O01 | M1 | planned | — | — |
| O02 | M6 | planned | — | — |
| O03 | M1 | planned | — | tools/probes/backend-lifecycle/README.md |
| O04 | M1 | planned | — | — |
| O05 | M6 | planned | — | — |
| O06 | M6 | planned | — | — |
| O07 | M6 | planned | — | — |
| O08 | M7 | planned | — | — |
