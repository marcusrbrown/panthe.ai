#!/usr/bin/env bash
# Scans the compiled sidecar binary for build-host leakage: the builder's
# $HOME, the builder's username, or the value of any live env var whose
# name matches *_KEY/*_TOKEN/*_SECRET. Fails (non-zero exit) if any are
# found -- a compiled binary should never embed anything from the machine
# or environment that built it. Mirrors
# tools/probes/backend-lifecycle/scripts/scan-binary.sh's approach; the
# probe tree stays untouched as M0 evidence.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$SIM_DIR/../.." && pwd)"

# Same derivation as build-sidecar.sh -- see there for rationale. Only used
# to find the default binary path when none is passed as $1.
detect_host_triple() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  if [[ "$os" != "Darwin" ]]; then
    echo "scan-binary: unsupported OS '$os' -- this script only auto-derives a target for macOS (M0/M1 scope); set PANTHEA_SIDECAR_TRIPLE explicitly, or pass the binary path as \$1" >&2
    exit 1
  fi
  case "$arch" in
    arm64) echo "aarch64-apple-darwin" ;;
    x86_64) echo "x86_64-apple-darwin" ;;
    *)
      echo "scan-binary: unrecognized macOS architecture '$arch'" >&2
      exit 1
      ;;
  esac
}

if [[ $# -ge 1 ]]; then
  BINARY="$1"
elif [[ -n "${PANTHEA_SIDECAR_TRIPLE:-}" ]]; then
  BINARY="$REPO_ROOT/apps/desktop/src-tauri/binaries/panthea-sim-$PANTHEA_SIDECAR_TRIPLE"
else
  BINARY="$REPO_ROOT/apps/desktop/src-tauri/binaries/panthea-sim-$(detect_host_triple)"
fi

if [[ ! -f "$BINARY" ]]; then
  echo "scan-binary: $BINARY not found; run scripts/build-sidecar.sh first" >&2
  exit 1
fi

echo "scan-binary: scanning $BINARY"
STRINGS_OUT="$(mktemp)"
trap 'rm -f "$STRINGS_OUT"' EXIT
strings -a "$BINARY" >"$STRINGS_OUT"

fail=0

if grep -qF "$HOME" "$STRINGS_OUT"; then
  echo "scan-binary: FAIL - build-host \$HOME ($HOME) found in binary" >&2
  fail=1
fi

USERNAME="$(id -un)"
if grep -qF "$USERNAME" "$STRINGS_OUT"; then
  echo "scan-binary: FAIL - build-host username ($USERNAME) found in binary" >&2
  fail=1
fi

# Any live env value whose name matches *_KEY/*_TOKEN/*_SECRET (length >= 8,
# to skip trivial/placeholder values), present literally in the binary.
while IFS='=' read -r name value; do
  if [[ "$name" =~ (_KEY|_TOKEN|_SECRET)$ ]] && [[ ${#value} -ge 8 ]]; then
    if grep -qF "$value" "$STRINGS_OUT"; then
      echo "scan-binary: FAIL - value of env var $name found in binary" >&2
      fail=1
    fi
  fi
done < <(env)

if [[ "$fail" -eq 0 ]]; then
  echo "scan-binary: PASS - no \$HOME, username, or *_KEY/*_TOKEN/*_SECRET env values found"
fi

exit "$fail"
