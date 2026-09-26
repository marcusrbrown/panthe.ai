// Correlation, local inspection, and export adapters live here (M1+).
// Telemetry is opt-in and local-first by default; hosted export requires
// explicit operator configuration. Placeholder until the first local
// event/trace store lands.

export interface PackageStatus {
  readonly package: "telemetry";
  readonly ready: false;
}

export const status: PackageStatus = {
  package: "telemetry",
  ready: false,
};
