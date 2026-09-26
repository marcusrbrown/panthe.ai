// Content validation and import tools live here. Placeholder until the
// first content-pack validator lands.

export interface PackageStatus {
  readonly package: "tools-content";
  readonly ready: false;
}

export const status: PackageStatus = {
  package: "tools-content",
  ready: false,
};
