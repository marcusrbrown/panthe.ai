// Versioned commands, events, content, and save schemas live here (M1+).
// Placeholder until the first contract types land.

export interface PackageStatus {
  readonly package: "contracts";
  readonly ready: false;
}

export const status: PackageStatus = {
  package: "contracts",
  ready: false,
};
