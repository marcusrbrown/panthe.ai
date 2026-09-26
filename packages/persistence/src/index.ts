// Transactions, snapshots, migrations, and replay live here (M1+).
// Placeholder until the first persistence systems land.

export interface PackageStatus {
  readonly package: "persistence";
  readonly ready: false;
}

export const status: PackageStatus = {
  package: "persistence",
  ready: false,
};
