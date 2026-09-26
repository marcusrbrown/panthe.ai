// Acceptance fixtures and manual comparison tools live here. Placeholder
// until the first headless scenario fixture lands (M1).

export interface PackageStatus {
  readonly package: "tools-scenarios";
  readonly ready: false;
}

export const status: PackageStatus = {
  package: "tools-scenarios",
  ready: false,
};
