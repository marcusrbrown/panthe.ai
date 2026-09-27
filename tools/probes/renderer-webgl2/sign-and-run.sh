#!/usr/bin/env bash
# M0 probe only — never release guidance. Ad-hoc codesigning and running an
# app from /tmp is not how Panthea is packaged or distributed; this script
# exists solely to get a signed `.app` bundle (required to observe WKWebView's
# real GPU-process behavior — see tools/probes/webgpu-wkwebview/README.md's
# caveat about ad-hoc `swift <file>` runs not reflecting a signed-app context)
# onto disk for the D25 renderer probe (P02/P05).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../../apps/probe-renderer"

echo "==> Building apps/probe-renderer (tauri build)..."
bun run tauri build

APP_SRC="src-tauri/target/release/bundle/macos/panthea-probe-renderer.app"
if [[ ! -d "$APP_SRC" ]]; then
  echo "error: expected app bundle not found at $APP_SRC" >&2
  find src-tauri/target/release/bundle -maxdepth 2 >&2 || true
  exit 1
fi

echo "==> Ad-hoc codesigning (signature identity '-')..."
codesign --force --deep -s - "$APP_SRC"

echo "==> Clearing quarantine attributes..."
xattr -cr "$APP_SRC"

DEST_DIR="/tmp/PantheaProbe"
mkdir -p "$DEST_DIR"
rm -rf "$DEST_DIR/panthea-probe-renderer.app"
cp -R "$APP_SRC" "$DEST_DIR/"

echo "==> Launching $DEST_DIR/panthea-probe-renderer.app"
open "$DEST_DIR/panthea-probe-renderer.app"

echo "==> Done. Console/stdout: use Console.app (process 'panthea-probe-renderer') or"
echo "    'log stream --predicate '"'"'process == \"panthea-probe-renderer\"'"'"''"
