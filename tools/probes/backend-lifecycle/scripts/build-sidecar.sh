#!/usr/bin/env bash
# Compiles src/sidecar.ts into a standalone Bun binary named for the Tauri
# `externalBin` target triple convention, e.g. `panthea-sim-aarch64-apple-darwin`.
# Run from anywhere; paths are resolved relative to this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$PROBE_DIR/../../.." && pwd)"

# Override for other targets, e.g. PANTHEA_SIDECAR_TARGET=bun-linux-x64
# PANTHEA_SIDECAR_TRIPLE=x86_64-unknown-linux-gnu. Default is this
# machine's target (Apple Silicon macOS) per the M0 probe scope.
TARGET="${PANTHEA_SIDECAR_TARGET:-bun-darwin-arm64}"
TRIPLE="${PANTHEA_SIDECAR_TRIPLE:-aarch64-apple-darwin}"

OUT_DIR="$REPO_ROOT/apps/desktop/src-tauri/binaries"
OUT_FILE="$OUT_DIR/panthea-sim-$TRIPLE"

mkdir -p "$OUT_DIR"

echo "build-sidecar: compiling $PROBE_DIR/src/sidecar.ts -> $OUT_FILE (target=$TARGET)"
cd "$PROBE_DIR"
bun build --compile --target="$TARGET" src/sidecar.ts --outfile "$OUT_FILE"
chmod 755 "$OUT_FILE"

echo "build-sidecar: wrote $OUT_FILE"
ls -lh "$OUT_FILE"
