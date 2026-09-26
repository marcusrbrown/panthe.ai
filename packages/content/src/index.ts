// Pack loading, lore manifests, and realm definitions live here (M2+).
// Placeholder until the first content-pack loader lands.

export interface PackageStatus {
  readonly package: "content";
  readonly ready: false;
}

export const status: PackageStatus = {
  package: "content",
  ready: false,
};
