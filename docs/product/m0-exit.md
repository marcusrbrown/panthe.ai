# M0 exit checklist

Status: M0 complete (2026-09-27). This is the feasibility-milestone checklist referenced by
[mvp-roadmap.md](mvp-roadmap.md)'s M0 row; it does not certify any requirement as release-complete
(see [traceability.md](traceability.md), whose statuses stay `planned` — M0 verifies feasibility,
not release obligations).

**2026-10-02 note:** traceability.md no longer reads `planned` throughout; M1 and M2 work has since moved rows to `implemented` with scenario evidence. M0 itself still certifies feasibility only.

## Probe → ADR disposition

| Probe | Requirement(s) | ADR | Status | Headline evidence |
| --- | --- | --- | --- | --- |
| [webgpu-wkwebview](../../tools/probes/webgpu-wkwebview/README.md) | P02, P05 | [0002](../decisions/0002-renderer-backend.md) | Accepted | `navigator.gpu` is `undefined` on macOS 15 WKWebView even after force-enabling the private `WebGPUEnabled` flag |
| [renderer-webgl2](../../tools/probes/renderer-webgl2/README.md) | P02, P05 | [0002](../decisions/0002-renderer-backend.md) | Accepted | Packaged `.app`: ~59 fps steady state (17ms frame p50/p95), 28ms p50 / 31ms p95 click-to-visible (14/14 real clicks); `koota` requires `'unsafe-eval'` in CSP; `WebGPURenderer` latches after context loss (`_isDeviceLost` never cleared) — app-managed reconstruction untested (2026-10-02: reconstruction is now implemented in `apps/client` and was verified by a forced context loss in the packaged debug build; the presented-frame gate, bounded retries, and real sleep/wake remain open, see the [device-loss learning](../solutions/integration-issues/three-webgpurenderer-device-loss-latch-2026-09-27.md)) |
| [backend-lifecycle](../../tools/probes/backend-lifecycle/README.md) | P03, W03, O03 | [0003](../decisions/0003-simulation-service.md) | Accepted | 5/5 lifecycle transitions pass (tray-mode close, quit, sidecar crash+restart, force-kill orphan guard, duplicate-launch refusal); sleep/resume interval applied exactly once (120923ms for a 120000ms stop) |
| [sandbox](../../tools/probes/sandbox/README.md) | U04, U05 | [0004](../decisions/0004-generated-behavior-runtime.md) | Accepted | 0 escapes across every adversarial fixture after a 3-round descriptor-capture fix; `setMemoryLimit` confirmed soft (quickjs-emscripten#255/#219) — the subprocess wall-clock/RSS supervisor is the real memory boundary |
| [inference-baseline](../../tools/probes/inference-baseline/README.md) | P04, P06 | [0005](../decisions/0005-model-providers.md) | Accepted | `llama3.2:3b` @ 4K, `parallel=1`: 100% native validity, 83% kind-acceptable, completion p50/p95 706/1538ms, RSS 2783 MiB; `gemma4:e4b` quality runner-up (93%, ~3.6s); ~39 reasoning turns/min system-wide schedule |
| [provider-matrix](../../tools/probes/provider-matrix/README.md) | P07 | [0005](../decisions/0005-model-providers.md) | Accepted | OpenCode Go confirmed (free models first, then paid `mimo-v2.5`); Zen is a scope note (403 `FreeTierError`, same credential as Go); offline mode silent on the wire, confirmed by a positive control (2026-10-02: OpenCode Go is not used for Panthea's game or gate traffic, because its usage policy limits it to coding-agent traffic; the measurements stand, see the correction in [ADR-0005](../decisions/0005-model-providers.md)) |
| [art-local](../../tools/probes/art-local/README.md) | U06, U07 | [0007](../decisions/0007-local-image-generation.md) | Accepted | stable-diffusion.cpp Q8_0 + PixelArtRedmond LoRA (`--diffusion-fa` required): 37.3s/image p50, 2320 MiB peak RSS; Q4_0 LoRA is a silent no-op; f16+LoRA crashes; Draw Things optional add-on, 5.7s p50, no HTTP cancel |
| [coexistence](../../tools/probes/coexistence/README.md) | P04, P06, U06 (informs 0003/0005/0007) | none (memory-sharing policy still open) | **Inconclusive** | Re-measured with success-only latencies and an evaluability floor (≥20 successes, ≤5% errors): only A and D@3GiB were measured in the same session and are evaluable — baseline (A) 645/1242 ms p50/p95 (60/60); 3 GiB admission queue (D) 1574/3086 ms (60/60, 6 images) — a **+148% p95 penalty**, reversing the first round's claimed -10.6% improvement. Unconstrained (B: 1315/2216 ms, 7 images), mutex (C: 22784/23094 ms, 8 images), and D@5GiB (626/960 ms, 0 images) are first-round, not evaluable — no comparable baseline (different session, success/attempt counts unrecoverable); no candidate policy is supported. Deferred to M1: re-measure B/C/D@5GiB with a corrected baseline before closing any of them. **2026-09-28:** M1 closed without it; the gate is now the M2 workload baseline at M2 exit, then comparable candidate results before M4 enables concurrent image generation ([ADR-0005](../decisions/0005-model-providers.md#decision)) |

ADR-0001 (workspace/tooling) was already Accepted before this milestone. ADR-0006 (telemetry
export) is M6 scope and stays Proposed — untouched by M0.

**2026-10-02 note:** no telemetry-export or save/replay probe README exists under `tools/probes`. The local trace store was accepted on 2026-09-28 on M1 and M2 scenario evidence ([m1-living-world](../../tools/scenarios/m1-living-world/README.md), [m2-greek-cast](../../tools/scenarios/m2-greek-cast/README.md)); that is not M6 replay acceptance. External export stays proposed, and O05–O07 stay planned for M6.

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
   conditional per P05/ADR-0002 until their own packaged-app probe runs. The probe app
   (`apps/probe-renderer`) was removed on 2026-09-28 (source at commit `ce9e5a4`), so this run will
   use the packaged desktop app with a measurement harness.

## Requirements touched by M0 evidence

P02, P03, P04, P05, P06, P07, W03, O03, U04, U05, U06, U07 — see [traceability.md](traceability.md)
for the current evidence links (statuses stay `planned`; M0 is feasibility evidence, not a release
obligation).
