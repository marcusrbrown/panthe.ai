# M0 exit checklist

Status: M0 complete (2026-09-27). This is the feasibility-milestone checklist referenced by
[mvp-roadmap.md](mvp-roadmap.md)'s M0 row; it does not certify any requirement as release-complete
(see [traceability.md](traceability.md), whose statuses stay `planned` — M0 verifies feasibility,
not release obligations).

## Probe → ADR disposition

| Probe | Requirement(s) | ADR | Status | Headline evidence |
| --- | --- | --- | --- | --- |
| [webgpu-wkwebview](../../tools/probes/webgpu-wkwebview/README.md) | P02, P05 | [0002](../decisions/0002-renderer-backend.md) | Accepted | `navigator.gpu` is `undefined` on macOS 15 WKWebView even after force-enabling the private `WebGPUEnabled` flag |
| [renderer-webgl2](../../tools/probes/renderer-webgl2/README.md) | P02, P05 | [0002](../decisions/0002-renderer-backend.md) | Accepted | Packaged `.app`: ~59 fps steady state (17ms frame p50/p95), 28ms p50 / 31ms p95 click-to-visible (14/14 real clicks); `koota` requires `'unsafe-eval'` in CSP; `WebGPURenderer` latches after context loss (`_isDeviceLost` never cleared) — app-managed reconstruction untested |
| [backend-lifecycle](../../tools/probes/backend-lifecycle/README.md) | P03, W03, O03 | [0003](../decisions/0003-simulation-service.md) | Accepted | 5/5 lifecycle transitions pass (tray-mode close, quit, sidecar crash+restart, force-kill orphan guard, duplicate-launch refusal); sleep/resume interval applied exactly once (120923ms for a 120000ms stop) |
| [sandbox](../../tools/probes/sandbox/README.md) | U04, U05 | [0004](../decisions/0004-generated-behavior-runtime.md) | Accepted | 0 escapes across every adversarial fixture after a 3-round descriptor-capture fix; `setMemoryLimit` confirmed soft (quickjs-emscripten#255/#219) — the subprocess wall-clock/RSS supervisor is the real memory boundary |
| [inference-baseline](../../tools/probes/inference-baseline/README.md) | P04, P06 | [0005](../decisions/0005-model-providers.md) | Accepted | `llama3.2:3b` @ 4K, `parallel=1`: 100% native validity, 83% kind-acceptable, completion p50/p95 706/1538ms, RSS 2783 MiB; `gemma4:e4b` quality runner-up (93%, ~3.6s); ~39 reasoning turns/min system-wide schedule |
| [provider-matrix](../../tools/probes/provider-matrix/README.md) | P07 | [0005](../decisions/0005-model-providers.md) | Accepted | OpenCode Go confirmed (free models first, then paid `mimo-v2.5`); Zen is a scope note (403 `FreeTierError`, same credential as Go); offline mode silent on the wire, confirmed by a positive control |
| [art-local](../../tools/probes/art-local/README.md) | U06, U07 | [0007](../decisions/0007-local-image-generation.md) | Accepted | stable-diffusion.cpp Q8_0 + PixelArtRedmond LoRA (`--diffusion-fa` required): 37.3s/image p50, 2320 MiB peak RSS; Q4_0 LoRA is a silent no-op; f16+LoRA crashes; Draw Things optional add-on, 5.7s p50, no HTTP cancel |
| [coexistence](../../tools/probes/coexistence/README.md) | P04, P06, U06 (informs 0005/0007) | [0005](../decisions/0005-model-providers.md), [0007](../decisions/0007-local-image-generation.md) | Accepted (feeds the shared memory policy) | Admission-controlled queue @ 3 GiB free+inactive: LLM p95 -10.6% vs baseline, 7/7 images completed; global mutex +1404% LLM p95 (rejected); unconstrained +44% (rejected); 5 GiB gate starves image generation to 0/7 (rejected) |

ADR-0001 (workspace/tooling) was already Accepted before this milestone. ADR-0006 (telemetry
export) is M6 scope and stays Proposed — untouched by M0.

## Open re-checks (not M0 blockers)

These four independently verify the renderer/platform picture beyond what this machine could
measure. None blocks M1 work from starting; each is its own follow-up probe.

1. **Packaged Flatland feature completeness on WebGL2 on a second machine/GPU** — the renderer-webgl2
   probe ran on one Apple M1 Pro; a different GPU/driver combination has not been checked.
2. **Signed-app (not ad-hoc) macOS 15 WebGPU re-check** — every probe here ran ad-hoc-signed; whether
   WebKit's WebGPU gate depends on code-signing/entitlements rather than purely the OS version
   remains unverified (see ADR-0002's superseded-context note).
3. **macOS 26 WKWebView WebGPU re-check** — confirm `navigator.gpu` actually appears once the OS
   gate lifts, and re-verify the `WebGPURenderer` context-loss-recovery limitation on that path.
4. **Packaged Windows/Linux renderer run** — Linux (WebKitGTK) and Windows (WebView2) remain
   conditional per P05/ADR-0002 until their own packaged-app probe runs.

## Requirements touched by M0 evidence

P02, P03, P04, P05, P06, P07, W03, O03, U04, U05, U06, U07 — see [traceability.md](traceability.md)
for the current evidence links (statuses stay `planned`; M0 is feasibility evidence, not a release
obligation).
