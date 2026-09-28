// Context, memory, planning, model routing, and fallback live here.
// Placeholder until the first agent systems land.

export interface PackageStatus {
  readonly package: "agents";
  readonly ready: false;
}

export const status: PackageStatus = {
  package: "agents",
  ready: false,
};
