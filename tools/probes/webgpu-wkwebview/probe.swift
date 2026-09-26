// Empirical probe: does an embedded WKWebView on this OS expose WebGPU
// (navigator.gpu) and can it obtain an adapter + device?
//
// Run: swift probe.swift
//
// No Xcode project required. Uses only system frameworks (Cocoa, WebKit)
// available to the Swift toolchain via `swift` script execution.

import Cocoa
import WebKit

// MARK: - Dynamic private-API bridging
//
// WKPreferences._features / _experimentalFeatures / _internalDebugFeatures
// and _WKFeature are private WebKit SPI, not exposed to Swift/ObjC headers
// available here. We resolve and invoke them dynamically via the ObjC
// runtime (class_getClassMethod / class_getInstanceMethod +
// method_getImplementation), guarded by `responds(to:)` checks, so this
// script still compiles and runs correctly even if a selector is absent
// or renamed in a future WebKit build.

typealias ClassArrayIMP = @convention(c) (AnyClass, Selector) -> NSArray?
typealias SetEnabledForFeatureIMP = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void

func callClassArrayMethod(_ cls: AnyClass, _ selectorName: String) -> [AnyObject]? {
  let sel = Selector(selectorName)
  guard let method = class_getClassMethod(cls, sel) else { return nil }
  let imp = method_getImplementation(method)
  let fn = unsafeBitCast(imp, to: ClassArrayIMP.self)
  guard let arr = fn(cls, sel) else { return nil }
  return arr as? [AnyObject]
}

func featureProperty(_ feature: AnyObject, _ key: String) -> Any? {
  guard feature.responds(to: Selector(key)) else { return nil }
  return feature.value(forKey: key)
}

func setEnabled(_ enabled: Bool, forFeature feature: AnyObject, on preferences: WKPreferences) -> Bool {
  let sel = Selector("_setEnabled:forFeature:")
  guard preferences.responds(to: sel),
    let method = class_getInstanceMethod(WKPreferences.self, sel)
  else {
    return false
  }
  let imp = method_getImplementation(method)
  let fn = unsafeBitCast(imp, to: SetEnabledForFeatureIMP.self)
  fn(preferences, sel, enabled, feature)
  return true
}

struct FeatureInfo {
  let source: String
  let key: String
  let name: String
  let defaultValue: Bool
}

func boolValue(_ any: Any?) -> Bool {
  if let b = any as? Bool { return b }
  if let n = any as? NSNumber { return n.boolValue }
  return false
}

/// Returns (all GPU-related feature descriptions, raw feature objects) so the
/// caller can both print info and pass the objects back into setEnabled().
func collectGPUFeatures(preferences: WKPreferences) -> ([FeatureInfo], [AnyObject]) {
  var infos: [FeatureInfo] = []
  var rawObjects: [AnyObject] = []
  let sources = ["_features", "_experimentalFeatures", "_internalDebugFeatures"]
  for source in sources {
    guard let features = callClassArrayMethod(WKPreferences.self, source) else {
      print("  [selector missing] WKPreferences.\(source)")
      continue
    }
    for feature in features {
      let name = (featureProperty(feature, "name") as? String) ?? ""
      let key = (featureProperty(feature, "key") as? String) ?? ""
      guard name.localizedCaseInsensitiveContains("gpu") || key.localizedCaseInsensitiveContains("gpu") else {
        continue
      }
      let defaultVal = boolValue(featureProperty(feature, "defaultValue"))
      infos.append(FeatureInfo(source: source, key: key, name: name, defaultValue: defaultVal))
      rawObjects.append(feature)
    }
  }
  return (infos, rawObjects)
}

// MARK: - WKWebView driver

final class ResultHandler: NSObject, WKScriptMessageHandler {
  var result: String?
  var done = false
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    result = message.body as? String
    done = true
  }
}

let probeHTML = """
  <!DOCTYPE html><html><body><script>
  (async () => {
    const out = { userAgent: navigator.userAgent, gpuType: typeof navigator.gpu };
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        out.adapterObtained = !!adapter;
        if (adapter) {
          try { out.adapterFeatures = adapter.features ? Array.from(adapter.features) : null; } catch (e) { out.adapterFeaturesError = String(e); }
          try { out.adapterLimits = adapter.limits ? Object.fromEntries(Object.entries(adapter.limits)) : null; } catch (e) { out.adapterLimitsError = String(e); }
          try {
            if (adapter.requestAdapterInfo) { out.adapterInfo = await adapter.requestAdapterInfo(); }
            else if (adapter.info) { out.adapterInfo = adapter.info; }
          } catch (e) { out.adapterInfoError = String(e); }
          try {
            const device = await adapter.requestDevice();
            out.deviceObtained = !!device;
            if (device) {
              out.deviceFeatures = device.features ? Array.from(device.features) : null;
            }
          } catch (e) {
            out.deviceError = String(e);
          }
        }
      }
    } catch (e) {
      out.error = String(e);
    }
    window.webkit.messageHandlers.result.postMessage(JSON.stringify(out));
  })();
  </script></body></html>
  """

func runProbe(label: String, enableGPUFeatures: Bool) -> String {
  print("=== Run: \(label) ===")
  let preferences = WKPreferences()

  let (gpuFeatures, gpuFeatureObjects) = collectGPUFeatures(preferences: preferences)
  print("GPU-related feature flags found (\(gpuFeatures.count)):")
  for f in gpuFeatures {
    print("  [\(f.source)] key=\(f.key) name=\(f.name) default=\(f.defaultValue)")
  }

  if enableGPUFeatures {
    if gpuFeatureObjects.isEmpty {
      print("  (no GPU feature objects to enable)")
    }
    for feature in gpuFeatureObjects {
      let key = (featureProperty(feature, "key") as? String) ?? "?"
      let ok = setEnabled(true, forFeature: feature, on: preferences)
      print("  setEnabled(true) for \(key): \(ok ? "invoked" : "selector missing")")
    }
  }

  let configuration = WKWebViewConfiguration()
  configuration.preferences = preferences
  let contentController = WKUserContentController()
  let handler = ResultHandler()
  contentController.add(handler, name: "result")
  configuration.userContentController = contentController

  let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
  webView.loadHTMLString(probeHTML, baseURL: nil)

  let deadline = Date().addingTimeInterval(15)
  while !handler.done && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
  }

  let output = handler.result ?? "{\"error\":\"timeout, no message received\"}"
  print("JS result: \(output)")
  print("")
  return output
}

_ = NSApplication.shared  // ensure app-context lazily initialized before WebKit use

let defaultResult = runProbe(label: "(a) default WKWebViewConfiguration", enableGPUFeatures: false)
let enabledResult = runProbe(label: "(b) private WebGPU feature(s) force-enabled", enableGPUFeatures: true)

print("=== Summary ===")
print("default: \(defaultResult)")
print("enabled: \(enabledResult)")
