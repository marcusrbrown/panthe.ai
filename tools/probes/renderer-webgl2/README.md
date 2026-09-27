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
- `l` key: forces a `WEBGL_lose_context` loss, then calls
  `restoreContext()` after 2s — see Results §3 for what does and does
  not recover.
- `?forceWebGL=1` query param: forces `WebGPURenderer`'s WebGL2 backend
  explicitly instead of letting it auto-detect.
- `?seed=N` query param: overrides the sprite-layout PRNG seed (fixed by
  default — `mulberry32` — so sprite screen positions, and therefore
  `spriteScreenPositions` in a metrics dump, are reproducible across runs
  at a given canvas size; this is what let real clicks be driven at known
  sprite coordinates from outside the WebView, see Results §3).

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

#### Click-to-visible latency on the packaged app (fixed timing model + real clicks)

The original click-to-visible timer had two bugs, both found in Fro Bot
review: it started on every `pointerdown` (including misses, which have no
"visible" moment to time) and stopped on the very next `render()` call —
i.e. the same frame the highlight was *submitted* in, not a later frame
once the browser had actually had a chance to *present* it. Combined with
the fact that the only evidence on file was from the `vite preview` +
Safari route (Results §2's 8.0ms), the packaged app's own dumps had
`clickToVisibleLatencyMs: null` in every prior dump in this file —
the 8.0ms number was never packaged-bundle evidence, and this section
replaces the claim rather than repeating it.

`metrics.ts`'s `ClickLatencyTracker` now: starts the timer only in the
raycast-*hit* branch of `onPointerDown` (a miss increments a separate
`clickMissCount` instead); records which frame index the hit's tint
mutation was first submitted in (`noteRenderSubmitted`, called right after
`renderer.render()` every tick); and only resolves the latency on a
*later* frame index than that — one full frame after the submit, not on
it. Each resolution records `{ spriteId, appliedFrameIndex,
resolvedFrameIndex, latencyMs }` in the dump (`lastClickResolution`) so the
timing claim is independently checkable, not just a number.

Driving real clicks at the packaged `.app` from outside the WebView turned
up two more things, both fixed before this evidence was captured:

- **`osascript`'s `System Events click at {x,y}` does not fire
  `pointerdown`/`pointerup` in this WKWebView** — confirmed by a temporary
  diagnostic build that logged every `pointerdown`/`mousedown`/`click`/
  `pointerup` on the canvas: a synthetic `click at` produced `mousedown`
  and `click` only. `cliclick` (`brew install cliclick`; genuine
  `CGEventPost`-level synthetic input) produced the full
  `pointerdown`→`pointerup`→`click` sequence and is what actually drove
  every click in this section. `System Events click at` remains fine for
  *element-targeted* actions (it correctly hit the "Dump metrics" button
  via its accessibility action in earlier testing) — just not for
  raw-coordinate pointer input against a canvas.
  - Follow-up correction: a `d`-dumped `spriteScreenPositions` list was
    computed against `canvasEl.clientWidth/Height`, which correctly
    excludes the native title bar — but the *test harness* converting
    those canvas-relative coordinates to absolute screen coordinates for
    `cliclick` initially assumed no title-bar offset. Measured directly
    (a diagnostic `dump_metrics` call echoing `event.clientX/Y`,
    `canvasEl.clientWidth/Height`, and the raycast hit count for a known
    click): the standard macOS title bar is exactly 28pt, and this app's
    WKWebView content view is `windowHeight - 28`, not the full window
    frame height. `screenX = windowX + canvasX; screenY = windowY + 28 +
    canvasY` is the correct transform for this window (no custom
    title-bar/decorations config in `tauri.conf.json`).
  - `spriteScreenPositions` now reports each sprite's world-space
    *bounding-box center* (`THREE.Box3.setFromObject(sprite)`), not
    `sprite.position` — the two coincided for this scene's actors in
    testing, so this didn't change the miss rate, but it's the physically
    correct point to target regardless of a sprite's `anchor` setting, and
    the dump now also reports each sprite's `kind` (`"static" |
    "animated"`) — the animated ring sprites render a *stroked* circle
    (transparent center), so a reliable click target should prefer
    `"static"` (filled diamond) sprites.
  - Sprite layout is now driven by a fixed-seed `mulberry32` PRNG
    (`?seed=N` overrides it) instead of `Math.random()`, so
    `spriteScreenPositions` from one dump stays valid for a subsequent
    click at the same canvas size — required for driving a whole batch of
    clicks off one earlier dump's coordinates.

With all of that, 14 real `cliclick`-driven clicks against known static-
sprite screen coordinates on the running packaged `.app` (binary launched
directly from a shell, dumped after each click): **14/14 hits, 0 misses**,
resolving against the exact intended sprite ID every time (`37`, `40`,
`56`, `58`, `59`, `60`, `63`, `65`, `68`, `70`, `76`, `78`, `86`, `103`).
Latencies (ms): `28, 23, 20, 23, 28, 28, 26, 27, 31, 26, 29, 18, 31, 30` —
**p50 = 28ms, p95 = 31ms, n = 14** (one representative resolution below;
same shape as the rest). Screenshot of a resolved hit (yellow-tinted
sprite, overlay reading `click->visible latency: 24.0ms (misses: 0)`):
`shots/05-click-latency-hit.png`.

```json
{
  "lastClickResolution": {
    "spriteId": 37,
    "appliedFrameIndex": 1555,
    "resolvedFrameIndex": 1556,
    "latencyMs": 28
  },
  "clickToVisibleLatencyMs": 28,
  "clickMissCount": 0
}
```

#### Context loss/restore on the packaged app (fixed app-level state; upstream renderer limitation found)

Two app-level bugs, both from Fro Bot review: the stale `selectedSprite`/
`selectedOriginalTint` references (and any in-flight click-latency timer)
were never cleared on `webglcontextlost`, so a restore could re-tint an
already-disposed sprite; and the old sprites' `geometry`/`material` were
never disposed before `populateActors()` rebuilt a fresh set on
`webglcontextrestored` (the shared source *textures* — `actorTexture`,
`animTexture` — are intentionally **not** disposed; they're reused by the
rebuilt sprites, not recreated). `ContextLossTracker.attach()` now takes
both an `onLost` and an `onRestore` callback; `onLost` clears the stale
selection state via `clickLatency.reset()`, `onRestore` disposes each
removed `Sprite2D`/`AnimatedSprite2D`'s own geometry/material before
`group.remove()`.

Exercised on the packaged `.app` via the new `l` key
(`WEBGL_lose_context.loseContext()`, then `restoreContext()` after 2s):

```json
{
  "contextLoss": { "lostCount": 1, "restoredCount": 1 },
  "spriteCount": 230,
  "effectFailures": []
}
```

A post-restore click against a freshly rebuilt sprite (new object IDs,
confirming `populateActors()` actually ran again) also resolved correctly
— `{ "spriteId": 249, "latencyMs": 21 }`, `clickMissCount` unchanged —
so hit-testing (pure CPU-side raycasting against the rebuilt `Sprite2D`
transforms) is fully recovered.

**What did not recover: the actual pixels.** The canvas goes solid white
after the restore and stays that way — confirmed on two separate restore
cycles, screenshot: `shots/06-context-loss-no-visual-recovery.png`. This
is not a bug in this probe's code; it's traced to `three@0.185.1`'s
`WebGPURenderer` (`three/build/three.webgpu.js`, the exact installed
build): its default `_onDeviceLost` handler sets a private
`this._isDeviceLost = true` latch on `webglcontextlost`, and both
`_renderScene()` (the guts of `render()`) and `compute()` early-return
whenever that latch is set — but **the module has zero references to
`webglcontextrestored`** anywhere, so nothing ever clears the latch. Its
public `init()` is also memoized (`if (this._initPromise !== null) return
this._initPromise;`), so calling it again after a restore is a no-op, not
a re-initialization. In this three.js version, once a
`WebGPURenderer`/WebGL2-backend device is lost, `render()` is a *permanent*
silent no-op for that renderer instance's remaining lifetime — there is no
supported recovery path short of disposing the renderer and constructing
an entirely new one (which would mean re-running most of this file's
`boot()`, not just `populateActors()`). That's a real product risk to
flag, not just a probe footnote: a driver reset, a GPU switch on
display-sleep/wake, or any other real-world context loss would strand a
shipped app on a permanently blank canvas until the user force-quits and
relaunches it. `pmset displaysleepnow` sleep/wake itself was **not**
exercised this session (the `l`-key/`WEBGL_lose_context` path already
reproduced the failure mode `pmset` was meant to probe for); it remains a
manual owner step if a real sleep/wake-triggered loss is ever suspected of
behaving differently from the synthetic one exercised here.

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
  Tauri's CSP at all). **Product implication, stated precisely**: adopting
  `'unsafe-eval'` in a renderer surface's `script-src` is conditional on
  U05 holding for that surface — the generated-behavior runtime (the thing
  `'unsafe-eval'` would otherwise be a privilege escalation risk for) must
  stay isolated in the simulation *service*, never load into the
  renderer's WKWebView/JS realm. That's the architecture today ("the
  world/simulation service is authoritative; the renderer never decides
  outcomes", per the repo invariants), so `'unsafe-eval'` here widens what
  the *renderer's own* trusted first-party code can do, not what generated
  content can do — it does not, by itself, weaken the generated-code
  sandbox. It is still a real CSP floor to carry into `apps/client` and
  `apps/desktop` once those adopt `three-flatland`, and it should be
  re-checked against U05 whenever that boundary changes. The alternative
  that would remove the requirement entirely is patching `koota`'s
  accessor generation to avoid `new Function(...)` (e.g. a generic
  interpreted accessor, or a build-time codegen step instead of a
  runtime one) — worth a follow-up upstream issue/PR against `koota`
  rather than treating `'unsafe-eval'` as permanent.
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
  `three-flatland`'s `events/HitTestMode` exports — confirmed working on
  the packaged `.app` itself via 14/14 real `cliclick`-driven hits (p50 =
  28ms, p95 = 31ms click-to-visible; see Results §3 — the preview-route's
  8.0ms was real but was never packaged-bundle evidence, and the original
  timing model it was measured with had since been found to double-count
  misses and under-count real latency; both are fixed and re-measured
  directly against the packaged binary now).
- **`WebGPURenderer` (`three@0.185.1`) does not recover from
  `webglcontextlost`/`webglcontextrestored` — confirmed from its own
  source, not just observed behavior.** `_onDeviceLost` sets a
  private `_isDeviceLost` latch that `_renderScene()`/`compute()` check
  and early-return on, and the shipped `three.webgpu.js` build has no
  `webglcontextrestored` handling anywhere to clear it; `init()` is
  memoized so calling it again isn't a re-initialization either. CPU-side
  state (the ECS/sprite objects this probe's app code owns, and raycasting
  against them) recovers correctly after `populateActors()` rebuilds; GPU
  output does not — `render()` becomes a permanent silent no-op for that
  renderer instance. See Results §3's context-loss subsection for the
  full trace and the product-risk framing (real hardware context loss —
  driver reset, GPU switch on sleep/wake — would strand a shipped app on
  a blank canvas with this exact renderer/version combination).
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
its WebGL2 fallback backend, at a stable ~59fps (17ms frame times), on this
machine, where `navigator.gpu` is unconditionally unavailable to WKWebView
(per `webgpu-wkwebview`'s probe). Real input latency is measured directly
against the packaged `.app`: 14/14 real (`cliclick`-driven) clicks resolved
correctly, p50 = 28ms / p95 = 31ms click-to-visible (Results §3) —
superseding the earlier `vite preview` route's 8.0ms, which was real for
what it measured but was never packaged-bundle evidence, and was measured
with a timing model that has since been fixed (it started on misses and
stopped a frame too early).

**This specific packaged bundle loads its content**: the ad-hoc-signed
`.app` built by `sign-and-run.sh` renders the identical scene, at the same
~59fps/17ms frame times, with zero effect failures across a 60s
steady-state run and a 30s effect-burst run captured directly against the
packaged binary (Results §3). The blank-WKWebView finding from the prior
session was real but was a CSP configuration gap (`script-src` missing
`'unsafe-eval'`, required by `three-flatland`'s `koota` dependency), not a
packaging or rendering defect — fixed in `src-tauri/tauri.conf.json` and
`tauri.dev.conf.json`, verified by A/B (remove the directive → blank
window returns with the identical `EvalError`; restore it → renders every
time).

**One real limit found, not fixed (upstream)**: `webglcontextlost` /
`webglcontextrestored` recovery is *partial*, not complete. This probe's
app-level state (stale-selection clearing, sprite/ECS rebuild, disposing
old geometry/material, raycast hit-testing) all correctly recovers —
verified on the packaged `.app` via the new `l` key (`lostCount: 1`,
`restoredCount: 1`, `spriteCount: 230` rebuilt, a post-restore click
resolving correctly). But `three@0.185.1`'s `WebGPURenderer` itself never
resumes rendering after a device-lost event in this version (traced to its
own source — see Findings) — the canvas stays permanently blank after any
context loss, packaged or not. This is out of this probe's fix scope (it
would require disposing and reconstructing the entire renderer, not just
the sprite scene graph) and is recorded here as a real product risk: a
driver reset or a GPU switch on display-sleep/wake would strand a shipped
app exactly this way until relaunched.

P02/P05's packaged-bundle criterion is satisfied for this machine's
WebGL2-fallback path **for the steady-state and click-input cases**; the
context-loss-recovery case is only partially satisfied (app state: yes;
rendering: no, upstream). Two carry-forward items: (1) the CSP constraint
itself — **any Panthea surface that imports `three-flatland` must include
`'unsafe-eval'` in `script-src`** until `koota` (or `three-flatland`) ships
a non-`eval` accessor path, conditional on U05 holding (see Findings) —
track this against `apps/client`/`apps/desktop` when they adopt
`three-flatland`; (2) the `WebGPURenderer` context-loss limitation — if a
real (not synthetic) context loss is a plausible scenario for the shipped
product on target hardware, that needs either an upstream three.js fix/PR,
a pinned-version workaround, or an explicit "relaunch on GPU loss"
recovery strategy at the app-shell level before this can be called fully
resolved.
