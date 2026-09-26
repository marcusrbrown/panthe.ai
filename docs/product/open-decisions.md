# Open engineering decisions and risks

Status: Delegated implementation work, not unfinished product interviewing.
The accepted boundary is fixed in the brief and decisions.
These items require research, prototype evidence, or content production.

| Item | Owner of resolution | Required evidence | Effect if unsuccessful |
| --- | --- | --- | --- |
| Packaged WebGPU across platforms | M0 renderer probe | macOS 15 resolved: dual-backend, WebGL2 baseline (D25). Linux is gated on a successful packaged either-backend probe, not specifically on `navigator.gpu` — WebGL2 on WebKitGTK counts as support. Remaining evidence: Flatland features on WebGL2, Windows WebView2 WebGPU, macOS 26 WKWebView, Linux WebKitGTK packaged probe | Limit conditional OS support; seek a scope decision if the baseline cannot work |
| Backend and service lifecycle | M0 architecture work | Background continuation, crash/restart, sleep/resume, packaging | Select another backend while preserving domain contracts |
| Model profiles and population | M0/M2 probes | Quality, latency, memory, starvation, and unattended participation | Tune model/context/scheduling; do not silently remove the roster |
| Local image generation | M0/M4 probes | Baseline memory, duration, cancellation, model/runtime compatibility | Queue or serialize expensive work; procedural art preserves activity; core generation capability still needs resolution |
| Hosted authorization | Provider research | Official supported authentication and tested adapter behavior | Expose only supported connection modes; no promise of retail OAuth portability |
| Behavior language and isolation | M0/M4 probes | Escape tests, budget enforcement, deterministic world API contract | Revise runtime; do not expose host privileges |
| Three Flatland evolution | Implementation version pinning | Working documentation and tested matching versions | Update deliberately with regression evidence |
| Lore sources and variants | Content work | Per-character source manifest and separation of lore from invention | Do not label unsourced inventions as researched mythology |
| Generated-art quality | Art pipeline/review | Consistent style and correct sprite/portrait metadata | Iterate assets without blocking core simulation with synchronous generation |
| Story variety | M2/M7 observation | Episodes, repetition metrics, owner review, causal consequences | Tune drives, opportunities, memory, and director before declaring success |
| Replay fidelity and storage | M1/M6 data work | Recorded outcomes, retained assets, restore and seek tests | Reduce diagnostic retention independently; disclose playback gaps |
| Export integration | M6 telemetry work | Local storage plus external trace correlation and outage behavior | Keep local inspection working while correcting adapter issues |
| OS minimums and release signing | Packaging work | Clean-install results and documented signing requirements | Publish only tested artifacts; no implied purchases or credentials |
| Future multiplayer | Post-MVP design | Separate permissions, privacy, concurrency, and time model | Do not apply local-owner authority to all remote players |

## Explicitly unspecified

No release deadline or monetary budget was supplied.
No exact local language or image model was selected.
No claim was made that the opening model examples are current or appropriate identifiers.
The implementation must probe candidates and record exact versions and terms for supplied artifacts.

## Defaults versus scope changes

Balance, timing, retention, population profiles, content-source selections, and library choices can be resolved within delegated authority.
Desktop delivery, offline operation, the named roster, persistent consequences, generated creation, and research inspection are accepted capabilities.
Removing one requires a product decision rather than a tuning note.

Roman, Norse, Yoruba, and tentative Akan rollout order can wait until after MVP.
Full nonvisual world navigation, permanent divine death, lesser deities, and retraining also remain future exploration.
This does not block the specified initial release.
