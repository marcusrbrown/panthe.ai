# WebGPU-in-WKWebView feasibility probe

Question: does an embedded `WKWebView` on this machine expose `navigator.gpu`,
and can it obtain a GPU adapter + device? Tauri v2 uses WKWebView as its
macOS renderer, so this decides WebGPU/Three.js renderer feasibility for the
Tauri direction without building a full app.

## How to run

```sh
cd tools/probes/webgpu-wkwebview
swift probe.swift
```

No Xcode project needed — `probe.swift` links only system frameworks
(`Cocoa`, `WebKit`) and runs as a plain Swift script. It performs two runs:

- **(a)** default `WKWebViewConfiguration` / `WKPreferences`.
- **(b)** same, but first enumerates `WKPreferences._features()` /
  `_experimentalFeatures()` / `_internalDebugFeatures()` (private WebKit SPI,
  resolved dynamically via the ObjC runtime so the script still compiles if a
  selector is missing/renamed), prints every feature flag whose `key`/`name`
  contains "gpu", and force-enables all of them via `_setEnabled:forFeature:`
  before creating the web view.

Each run loads inline HTML that evaluates `typeof navigator.gpu`,
`navigator.gpu?.requestAdapter()`, `adapter?.requestDevice()`, and
`navigator.userAgent`, then posts the JSON result back via
`window.webkit.messageHandlers.result`. A 15s timeout guards each run.

**Caveat**: this runs as an ad-hoc, unsigned `swift <file>` process, not a
signed `.app` bundle (which is what a packaged Tauri app is). If WebKit's GPU
process gating depends on code-signing/entitlements rather than purely on the
feature flag, that could independently suppress WebGPU here even if the flag
mechanism itself works. Worth a second data point inside an actual signed
`.app` if this result is going to gate the renderer decision.

## Environment

```
$ sw_vers
ProductName:    macOS
ProductVersion: 15.7.9
BuildVersion:   24G830

$ defaults read /Applications/Safari.app/Contents/Info.plist CFBundleShortVersionString
26.6.1

$ defaults read /System/Library/Frameworks/WebKit.framework/Resources/Info.plist CFBundleVersion
20621

$ defaults read /System/Library/Frameworks/WebKit.framework/Resources/Info.plist CFBundleShortVersionString
20621.3.11.11.3

$ swift --version
Apple Swift version 6.2.4 (swiftlang-6.2.4.1.4 clang-1700.6.4.2)
Target: arm64-apple-macosx15.0
```

Machine: Apple M1 Pro.

## Results

Command run: `swift probe.swift` (single invocation performs both runs a/b).

```
=== Run: (a) default WKWebViewConfiguration ===
GPU-related feature flags found (21):
  [_features] key=CaptureAudioInGPUProcessEnabled name=GPU Process: Audio Capture default=true
  [_features] key=BlockMediaLayerRehostingInWebContentProcess name=GPU Process: Block Media Layer Re-hosting default=true
  [_features] key=UseGPUProcessForCanvasRenderingEnabled name=GPU Process: Canvas Rendering default=true
  [_features] key=UseGPUProcessForDOMRenderingEnabled name=GPU Process: DOM Rendering default=true
  [_features] key=UseGPUProcessForMediaEnabled name=GPU Process: Media default=true
  [_features] key=UseGPUProcessForDisplayCapture name=GPU Process: Screen and Window capture default=true
  [_features] key=CaptureVideoInGPUProcessEnabled name=GPU Process: Video Capture default=true
  [_features] key=UseGPUProcessForWebGLEnabled name=GPU Process: WebGL default=true
  [_features] key=WebRTCPlatformCodecsInGPUProcessEnabled name=GPU Process: WebRTC Platform Codecs default=true
  [_features] key=WebGPUHDREnabled name=WebGPU support for HDR default=false
  [_features] key=WebXRWebGPUBindingsEnabled name=WebGPU support for WebXR default=false
  [_features] key=WebGPUEnabled name=WebGPU default=false
  [_experimentalFeatures] key=UseGPUProcessForCanvasRenderingEnabled name=GPU Process: Canvas Rendering default=true
  [_experimentalFeatures] key=UseGPUProcessForDOMRenderingEnabled name=GPU Process: DOM Rendering default=true
  [_experimentalFeatures] key=WebGPUHDREnabled name=WebGPU support for HDR default=false
  [_experimentalFeatures] key=WebGPUEnabled name=WebGPU default=false
  [_internalDebugFeatures] key=CaptureAudioInGPUProcessEnabled name=GPU Process: Audio Capture default=true
  [_internalDebugFeatures] key=BlockMediaLayerRehostingInWebContentProcess name=GPU Process: Block Media Layer Re-hosting default=true
  [_internalDebugFeatures] key=CaptureVideoInGPUProcessEnabled name=GPU Process: Video Capture default=true
  [_internalDebugFeatures] key=UseGPUProcessForWebGLEnabled name=GPU Process: WebGL default=true
  [_internalDebugFeatures] key=WebXRWebGPUBindingsEnabled name=WebGPU support for WebXR default=false
JS result: {"userAgent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)","gpuType":"undefined"}

=== Run: (b) private WebGPU feature(s) force-enabled ===
GPU-related feature flags found (21):
  [same 21 entries as above]
  setEnabled(true) for CaptureAudioInGPUProcessEnabled: invoked
  setEnabled(true) for BlockMediaLayerRehostingInWebContentProcess: invoked
  setEnabled(true) for UseGPUProcessForCanvasRenderingEnabled: invoked
  setEnabled(true) for UseGPUProcessForDOMRenderingEnabled: invoked
  setEnabled(true) for UseGPUProcessForMediaEnabled: invoked
  setEnabled(true) for UseGPUProcessForDisplayCapture: invoked
  setEnabled(true) for CaptureVideoInGPUProcessEnabled: invoked
  setEnabled(true) for UseGPUProcessForWebGLEnabled: invoked
  setEnabled(true) for WebRTCPlatformCodecsInGPUProcessEnabled: invoked
  setEnabled(true) for WebGPUHDREnabled: invoked
  setEnabled(true) for WebXRWebGPUBindingsEnabled: invoked
  setEnabled(true) for WebGPUEnabled: invoked
  [... repeated for _experimentalFeatures / _internalDebugFeatures duplicates of the same keys ...]
JS result: {"userAgent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)","gpuType":"undefined"}

=== Summary ===
default: {"userAgent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)","gpuType":"undefined"}
enabled: {"userAgent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)","gpuType":"undefined"}
```

Wall time for both runs: ~3.7s (no timeout hit; JS resolved immediately since
`navigator.gpu` was undefined and nothing to await).

### Findings

- `navigator.gpu` is `undefined` in **both** runs — default config and after
  force-enabling every discovered GPU-related private feature flag.
- No adapter or device was obtained in either run (never reached that code
  path since `navigator.gpu` itself doesn't exist).
- Three private feature flags are genuinely WebGPU-related:
  `WebGPUEnabled` (default `false`), `WebGPUHDREnabled` (default `false`),
  `WebXRWebGPUBindingsEnabled` (default `false`). The other 18 "GPU"-matching
  flags are `GPU Process: *` — they control whether canvas/WebGL/media/audio
  capture/WebRTC codecs run in WebKit's separate GPU process, unrelated to
  the WebGPU JS API.
- `_setEnabled:forFeature:` was present and callable (`responds(to:)` true,
  invocation succeeded with no crash) for every flag, including
  `WebGPUEnabled`. It did not change the outcome — `navigator.gpu` remained
  `undefined` after enabling.
- `navigator.userAgent` reports Safari/WebKit `605.1.15` (the generic legacy
  WebKit UA string embedded WKWebView always reports; not indicative of the
  actual 20621.x engine build, confirmed separately via `defaults read`).

### Bottom line

On this machine (macOS 15.7.9, WebKit 20621.3.11.11.3, Apple M1 Pro),
WebGPU is **not exposed** to an embedded WKWebView, even after forcing the
private `WebGPUEnabled` feature flag on via the same private SPI Safari's own
internal Feature Flags UI would use. Either this WebKit build's WebGPU
implementation is not wired to that flag for third-party WKWebView hosts, or
it requires a signed `.app` bundle context this ad-hoc script doesn't have
(see caveat above). Either way, treat Tauri/WKWebView-native WebGPU as
**not currently viable** on this OS/hardware without further evidence from a
signed app-bundle test; plan the renderer path assuming a WebGPU fallback
(e.g. WebGL2 via Three.js, or moving the WebGPU-consuming code off WKWebView
entirely) is required for the macOS target.
