// This package is a workspace anchor only. Probes themselves are not
// TypeScript modules under src/ — see README.md for where they live.

export interface PackageStatus {
  readonly package: "tools-probes";
  readonly ready: false;
}

export const status: PackageStatus = {
  package: "tools-probes",
  ready: false,
};
