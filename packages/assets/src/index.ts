// Generation adapters, provenance, and the asset registry live here (M4+).
// Placeholder until the first generation adapter lands.

export interface PackageStatus {
  readonly package: "assets";
  readonly ready: false;
}

export const status: PackageStatus = {
  package: "assets",
  ready: false,
};
