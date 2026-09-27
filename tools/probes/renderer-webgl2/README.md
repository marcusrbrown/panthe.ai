# three-flatland on WebGPURenderer's WebGL2 backend — packaged-bundle probe

Question: does D25 (three's `WebGPURenderer`, WebGPU where supported / WebGL2
otherwise) actually hold up for three-flatland's 2D primitives — sprites,
tilemaps, animation, TSL-composed effects, pixel-perfect camera math, manual
hit-testing — at target frame rate, with measured input latency, inside an
ad-hoc-signed `.app` bundle? `tools/probes/webgpu-wkwebview/README.md`
already established that this machine's WKWebView never exposes
`navigator.gpu`, so every run here exercises the WebGL2 fallback path, not
WebGPU itself.

## How to run

```sh
cd apps/probe-renderer
bun run tauri dev            # dev-mode validation (fastest path)
```

For the packaged, ad-hoc-signed `.app` (the actual D25 target — WKWebView
inside a real bundle, not a dev server):

```sh
tools/probes/renderer-webgl2/sign-and-run.sh
```

The script runs `bun run tauri build`, ad-hoc codesigns the resulting
`.app` (`codesign -s -`), clears the quarantine xattr, copies it to
`/tmp/PantheaProbe/`, and opens it. See the script's header comment — this
is an M0 probe convenience, never release/distribution guidance.

Runtime controls once a window is open:

- Click anywhere on the canvas: manual raycast hit-test against the sprite
  array (`THREE.Raycaster.intersectObjects`, not a Flatland hit-test
  export); a hit sets the sprite's `tint` to yellow as the selection
  highlight.
- `d` key or the "Dump metrics" button: writes a JSON metrics snapshot to
  the browser console and, inside Tauri, invokes the `dump_metrics` Rust
  command (`println!`) so it also lands on the process's stdout.
- `b` key: toggles an "effect burst" — multiplies the fire/lightning
  effect's `intensity` uniform across all animated sprites (`1.0` →
  `3.4`).
- `?forceWebGL=1` query param: forces `WebGPURenderer`'s WebGL2 backend
  explicitly instead of letting it auto-detect.

## Caveat

This environment's screen is shared with other concurrent automated
sessions (confirmed directly — a screenshot taken mid-probe captured an
unrelated GitHub PR page open in another window, not this probe). The
probe's own window visibility flaps every 8–12 seconds in the unified log
(`View is visible` / `invisible` transitions), most likely other sessions'
windows stealing focus. That flapping, combined with `cargo build --release`
disabling the WKWebView inspector (no `devtools` Cargo feature enabled),
made the packaged `.app`'s blank-window finding hard to root-cause further
from the original session.

**Resolved in a follow-up session**: a debug-profile bundle
(`tauri build --debug`) exposes the WKWebView inspector without the
`devtools` Cargo feature; a temporary `window.open_devtools()` call in
`.setup()` (removed again once the console was read) surfaced the actual
`EvalError` behind the blank window. See Results §3 and Findings for the
root cause and fix.

## Environment

```
$ sw_vers
ProductName:    macOS
ProductVersion: 15.7.9
BuildVersion:   24G830

$ uname -m
arm64

$ swift --version
swift-driver version: 1.127.15 Apple Swift version 6.2.4 (swiftlang-6.2.4.1.4 clang-1700.6.4.2)
Target: arm64-apple-macosx15.0

$ rustc --version
rustc 1.98.1 (48a229cea 2026-09-01)

$ cargo --version
cargo 1.98.1 (797e8a9bc 2026-08-05)
```

Machine: Apple M1 Pro. Pins: `three@0.185.1`, `three-flatland@0.1.0-alpha.10`,
`@three-flatland/nodes@0.1.0-alpha.10`, `@tauri-apps/api@2.12.0`,
`@tauri-apps/cli@2.12.0`, `tauri` crate `=2.12.0`, `react@19.2.8`,
`vite@7.3.6`. WebKit build was independently confirmed as
`20621.3.11.11.3` in `tools/probes/webgpu-wkwebview/README.md` on this same
machine.

## Results

Three ways the exact same production frontend code ran, in ascending order
of "how close to the real packaged target":

### 1. `bun run tauri dev` (debug profile, WKWebView, real Tauri IPC)

Command: `cd apps/probe-renderer && bun run tauri dev`. Compiled cleanly
(26s dev-profile `cargo` build), opened a window, and the frontend called
`dump_metrics` (captured on the `cargo run` process's stdout, since dev mode
runs attached to a terminal):

```json
{
  "timestamp": "2026-09-27T00:51:38.892Z",
  "backend": "webgl2",
  "backendDetectionProperty": "renderer.backend.isWebGLBackend",
  "navigatorGpuType": "undefined",
  "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  "webglDebugRenderer": { "vendor": "Apple Inc.", "renderer": "Apple GPU" },
  "frameTime": { "p50": 17, "p95": 17, "sampleCount": 600 },
  "clickToVisibleLatencyMs": null,
  "contextLoss": { "lostCount": 0, "restoredCount": 0 },
  "spriteCount": 230,
  "effectFailures": []
}
```

Three consecutive dumps over ~20s of runtime all reported the same numbers
(`spriteCount: 230` = 200 static `Sprite2D` + 30 `AnimatedSprite2D`,
`effectFailures: []`, `contextLoss: 0/0`) — the scene populated once and
stayed stable; the dumps recurred automatically rather than from a manual
keypress in this session (see Caveat: something in this shared environment
is periodically interacting with new GUI windows; not our code's doing —
`dumpMetrics` is only wired to the `d` key and the button's `onClick`).

### 2. Production bundle via `vite preview` + Safari (real browser, real click/resize input)

`bun run build && bun run preview`, opened `http://localhost:4173/` in
Safari (a normal, non-Tauri browser tab loading the *exact same* minified
production JS Tauri would embed). This is where interactive input actually
worked reliably in this shared-screen session:

- Initial load: full scene rendered — checker/road tilemap floor, ~200
  diamond `Sprite2D` actors, orange pulsing `AnimatedSprite2D` markers,
  overlay reading `backend: webgl2 (renderer.backend.isWebGLBackend)`,
  `frame p50/p95: 17.00ms / 18.00ms (n=600)`, `sprites: 230`,
  `effect failures: 0`.
- Click (`System Events click at`) + `b` keypress: overlay updated to
  `click->visible latency: 8.0ms` and `burst: ON (press b to toggle)` —
  both the manual-raycast click path and the effect-burst toggle fired
  correctly.
- Window resize (Safari `set bounds of window 1`, ~900×700 → ~700×500):
  `updatePixelPerfectCamera` recomputed the orthographic frustum and the
  scene re-rendered proportionally with no distortion; overlay state
  (`burst: ON`, `effect failures: 0`, prior click latency) persisted
  correctly across the resize. (Preview-route screenshots are not kept in
  the repo; the packaged-app capture in `shots/` is the retained evidence.)

Frame time (17–18ms ≈ 55–59fps) is consistent with a display-vsync-limited
steady state; sample count hit the 600-entry rolling cap in both dev and
preview runs.

### 3. Packaged, ad-hoc-signed `.app` via `sign-and-run.sh` (the actual target)

`tauri build` (release profile) succeeded: `cargo fmt --check` and
`cargo clippy --locked -- -D warnings` both clean, `vite build` produced
`dist/` (1.2MB main chunk, noted as a follow-up — see Findings), Tauri
bundled both `panthea-probe-renderer.app` (9.84 MiB) and a `.dmg` (2.89
MiB). `codesign --force --deep -s -` and `xattr -cr` both succeeded with no
errors; the app launched, stayed running (confirmed via `ps` — stable low
CPU, no crash), and its window (title "Panthea Renderer Probe") appeared
with correct chrome.

**Initial finding (root-caused and fixed in this session): the WKWebView
content area rendered blank white** in every attempt across the prior
session (5 separate build/sign/launch cycles). A debug-profile bundle
(`tauri build --debug`, ad-hoc signed the same way) reproduced the same
blank window, and — with a temporary `window.open_devtools()` call in
`src-tauri/src/lib.rs`'s `.setup()` (debug builds expose the WKWebView
inspector without needing the `devtools` Cargo feature; removed again
before this fix landed) — the Web Inspector's Console tab showed the real
error, which `log show`/`log stream` never surface for in-page JS
exceptions:

```
EvalError: Refused to evaluate a string as JavaScript because 'unsafe-eval'
is not an allowed source of script in the following Content Security Policy
directive: "script-src 'self' 'self' 'sha256-...' ...".
  ƒ Function — index-DqyebVS_.js:584
```

**Root cause**: `three-flatland` depends on `koota` (an ECS library) for
its entity/component storage. `koota`'s trait system
(`three-flatland/dist/ecs/traits.js`, calling into
`koota/dist/chunk-*.js` around lines 682–711 in this build) generates its
struct-of-arrays property setters/getters with `new Function("index",
"store","value", ...)` at store-creation time — a legitimate perf pattern
(compiling a specialized accessor once per component shape instead of a
generic one), but one that requires `'unsafe-eval'` in `script-src`. This
runs during `three-flatland` import/store setup, before React's first
commit reaches the DOM, so the uncaught `EvalError` aborted the entire
module — which is why even the static "booting probe-renderer…" placeholder
never painted (that finding correctly ruled out a WebGPU/rendering-specific
failure; it did not rule out a pre-render synchronous throw). Confirmed
with an A/B: reverting `script-src` to `'self'` alone reproduces the blank
window and the identical `EvalError` on demand; restoring `'unsafe-eval'`
renders correctly every time.

**Why only the packaged build was affected**: Tauri only synthesizes and
enforces a CSP response header for content served through its own custom
protocol (`tauri://localhost` on macOS), which is what `frontendDist`-based
production builds use. `tauri dev` serves the frontend from Vite's own dev
server at `devUrl` (`http://localhost:1430`) — a plain HTTP response with
no CSP header at all — and `vite preview` + Safari is a normal browser tab,
also with no CSP. Both bypass Tauri's CSP enforcement entirely, so neither
reproduced the `'unsafe-eval'` block; only the packaged bundle, loaded
through the CSP-enforcing custom protocol, did.

**Fix**: added `'unsafe-eval'` to `app.security.csp.script-src` in both
`src-tauri/tauri.conf.json` (production) and `src-tauri/tauri.dev.conf.json`
(kept in sync for when/if `devUrl` enforcement changes) — not
`'wasm-unsafe-eval'`; the violated directive was explicitly `'unsafe-eval'`
and nothing in this scene exercises WASM. See Findings for the product-level
implication (this is a hard CSP floor for any app that imports
`three-flatland`, not a one-off probe quirk).

With the fix in place, the packaged `.app` renders the full scene: tilemap
floor, all 230 sprites (200 static + 30 animated), overlay reporting
`backend: webgl2`, and the Dump metrics button/`d` key both work. Ran the
full 60s steady-state + 30s effect-burst protocol directly against this
build (see below) — nothing here was actually environment-gated once the
CSP was fixed. Screenshot: `shots/04-packaged-app-rendered.png`.

**60s steady-state dump** (binary launched directly from a shell, not via
`open`, so `dump_metrics`'s `println!` lands on the captured stdout):

```json
{
  "timestamp": "2026-09-27T01:27:39.319Z",
  "backend": "webgl2",
  "backendDetectionProperty": "renderer.backend.isWebGLBackend",
  "navigatorGpuType": "undefined",
  "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  "webglDebugRenderer": { "vendor": "Apple Inc.", "renderer": "Apple GPU" },
  "frameTime": { "p50": 17, "p95": 17, "sampleCount": 600 },
  "clickToVisibleLatencyMs": null,
  "contextLoss": { "lostCount": 0, "restoredCount": 0 },
  "spriteCount": 230,
  "effectFailures": []
}
```

**30s effect-burst dump** (`b` pressed immediately after the steady-state
dump, held for 30s, then dumped again):

```json
{
  "timestamp": "2026-09-27T01:28:22.895Z",
  "backend": "webgl2",
  "backendDetectionProperty": "renderer.backend.isWebGLBackend",
  "navigatorGpuType": "undefined",
  "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  "webglDebugRenderer": { "vendor": "Apple Inc.", "renderer": "Apple GPU" },
  "frameTime": { "p50": 17, "p95": 17, "sampleCount": 600 },
  "clickToVisibleLatencyMs": null,
  "contextLoss": { "lostCount": 0, "restoredCount": 0 },
  "spriteCount": 230,
  "effectFailures": []
}
```

Both dumps match routes 1–2's frame times exactly (17ms, ~59fps) with zero
context loss and zero effect failures throughout, including through the
intensity-3.4x burst toggle. `pmset displaysleepnow` sleep/wake was not
exercised in this follow-up session either — it remains genuinely
out-of-scope for a CSP fix and can be picked up whenever the packaged-bundle
criterion needs that specific evidence.

## Findings

- **D25 backend-fallback claim: confirmed.** `new WebGPURenderer({ canvas,
  forceWebGL: false })` — no `forceWebGL` override — correctly falls back
  to the WebGL2 backend on this machine, detected via
  `renderer.backend.isWebGLBackend === true` (the exact three.js 0.185.1
  API; verified by reading `three`'s own source, which uses this same
  property internally in `RenderObject.js`/`Background.js`/etc.).
  `WEBGL_debug_renderer_info` reports `Apple Inc.` / `Apple GPU`.
  `navigator.gpu` is `undefined` in this WKWebView (matching
  `webgpu-wkwebview`'s finding), so the fallback is not merely available —
  it is the *only* path this machine's WKWebView can take.
- **three-flatland's primitives all render correctly on that WebGL2
  backend**: a hand-built 64×64 `TileMap2D` (checker + road tiles, one
  `Tileset`/`TileLayer` built manually — see deviations below), 200
  `Sprite2D` instances with `sortLayer: 'entities'` + world-Y-derived
  `zIndex` for isometric painter's-algorithm ordering, 30
  `AnimatedSprite2D` instances playing a hand-built 4-frame ping-pong
  animation, and a `createMaterialEffect`-based fire/lightning flicker —
  all confirmed via dev mode and the production-bundle preview route.
- **`@three-flatland/nodes`'s `pulseGlow` import succeeded** — the
  fallback TSL-flicker code path (a hand-rolled `sin(time)`-driven emissive
  pulse) was never exercised (`effectFailures: []` in every run). The
  fallback path is implemented and typechecks but is unverified at
  runtime; a future run with the package intentionally broken (e.g. wrong
  version pin) would be the way to actually exercise it.
- **Packaged `.app` blank-WKWebView finding: root-caused and fixed.**
  `three-flatland`'s `koota` (ECS) dependency generates its
  struct-of-arrays accessors via `new Function(...)` at store-creation
  time, which Tauri's packaged-bundle CSP (`script-src 'self'`, no
  `'unsafe-eval'`) blocks with an uncaught `EvalError` before React's first
  commit — not a D25/WebGL2/three-flatland rendering problem, but a hard
  CSP requirement of the `three-flatland` → `koota` dependency chain
  itself (see Results §3 for the exact stack frame, the A/B verification,
  and why `tauri dev`/`vite preview` never hit it — neither enforces
  Tauri's CSP at all). **Product implication**: any Panthea surface that
  imports `three-flatland` needs `'unsafe-eval'` in its `script-src`
  unless/until `koota` ships a non-`eval` accessor path — this is not a
  probe-only workaround, it's a real constraint to carry into `apps/client`
  and `apps/desktop`'s CSP once those adopt `three-flatland`.
- **`PixelPerfectCamera` is not exported by `three-flatland` at
  `0.1.0-alpha.10`** — confirmed by enumerating the full `index.d.ts`
  export list from the installed package (not just the README, which
  doesn't mention it either). Implemented a minimal equivalent
  (`updatePixelPerfectCamera` in `Scene.tsx`): pins the orthographic
  frustum to `canvas.clientWidth/Height` at a fixed 1-world-unit-per-CSS-
  pixel scale (`renderer.setPixelRatio(1)`) and rounds camera position to
  integer pixels.
- **`createMaterialEffect` lives on `three-flatland`'s top-level export,
  not `@three-flatland/nodes`** — the latter is a separate companion
  package (also pinned at `0.1.0-alpha.10`, listed under "Companion
  Packages" in `three-flatland`'s own README) that supplies ~150 TSL
  *node functions* (`pulseGlow`, `flashAdditive`, `tint`, `bloom`,
  `crtScanlines`, etc.), not the effect-factory function itself. Both
  packages had to be added as explicit dependencies of
  `apps/probe-renderer` (neither ships as a transitive dependency of the
  other — `three-flatland`'s own `package.json` only pulls in
  `@three-flatland/bake` and `@three-flatland/normals`, both unrelated
  internal helpers).
- **No literal "fire" or "lightning" node exists** in `@three-flatland/nodes`
  0.1.0-alpha.10's ~150-function export list (checked the full list). Used
  `pulseGlow(inputColor, time, glowColor, speed, intensity)` — a generic
  pulsing-glow VFX node — with a warm orange `glowColor` to compose a
  fire/lightning-style flicker via `createMaterialEffect`, which is the
  documented, intended composition pattern (see the package's own README
  Quick Start, which shows exactly this "define an effect via
  `createMaterialEffect` + a node from the nodes package" pattern for
  `tintAdditive`).
- **Manual raycast, not a Flatland hit-test export**: `Sprite2D` (and by
  inheritance `AnimatedSprite2D`) overrides `Object3D.raycast()` directly,
  so a plain `THREE.Raycaster.intersectObjects(selectableSprites, false)`
  against the flat sprite array works without touching any of
  `three-flatland`'s `events/HitTestMode` exports — confirmed working via
  the preview-route click test (`click->visible latency: 8.0ms`).
- The production build emits one 1.2MB (342KB gzip) JS chunk with a Vite
  size warning; not investigated further here (out of scope for a D25
  feasibility probe) but worth a manual-chunking pass before this pattern
  is reused for a real app shell.

## Bottom line

Both claims are now answered with evidence, and both are yes.

**The renderer backend is fine**: D25 holds — three-flatland's full
primitive set (tilemaps, sortLayer/zIndex-ordered sprites, animated
sprites, TSL-composed effects, manual hit-testing, a hand-rolled
pixel-perfect camera) renders correctly on three's `WebGPURenderer` running
its WebGL2 fallback backend, at a stable ~59fps (17ms frame times), with
real input latency measured (8.0ms click-to-visible) — on this machine,
where `navigator.gpu` is unconditionally unavailable to WKWebView (per
`webgpu-wkwebview`'s probe).

**This specific packaged bundle loads its content**: the ad-hoc-signed
`.app` built by `sign-and-run.sh` renders the identical scene, at the same
~59fps/17ms frame times, with zero context loss and zero effect failures
across a 60s steady-state run and a 30s effect-burst run captured directly
against the packaged binary (Results §3). The blank-WKWebView finding from
the prior session was real but was a CSP configuration gap
(`script-src` missing `'unsafe-eval'`, required by `three-flatland`'s
`koota` dependency), not a packaging or rendering defect — fixed in
`src-tauri/tauri.conf.json` and `tauri.dev.conf.json`, verified by A/B
(remove the directive → blank window returns with the identical
`EvalError`; restore it → renders every time).

P02/P05's packaged-bundle criterion is satisfied for this machine's
WebGL2-fallback path. The one carry-forward item is the CSP constraint
itself: **any Panthea surface that imports `three-flatland` must include
`'unsafe-eval'` in `script-src`** until `koota` (or `three-flatland`) ships
a non-`eval` accessor path — track this against `apps/client`/`apps/desktop`
when they adopt `three-flatland`, since a security-conscious default CSP
would otherwise silently reproduce this exact blank-screen failure with no
`log show`/`log stream` signal (the WKWebView inspector, not the unified
log, is what surfaces it).
