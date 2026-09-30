// Which sidecar binary a run uses. One rule for the scripted story and the
// real-inference run, so neither can quietly use a stale binary: the default
// rebuilds, and only --skip-build reuses whatever is already there.

import {
  buildSidecar,
  sidecarBinaryPath,
} from "../../m1-living-world/src/sidecar";

export interface BinaryDeps {
  readonly build: () => string;
  readonly existing: () => string;
}

const defaultDeps: BinaryDeps = {
  build: buildSidecar,
  existing: sidecarBinaryPath,
};

export function resolveSidecarBinary(
  skipBuild: boolean,
  deps: BinaryDeps = defaultDeps,
): string {
  return skipBuild ? deps.existing() : deps.build();
}
