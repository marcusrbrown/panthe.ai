// Correlation, local inspection, and export adapters live here (M1+).
// Local causal recording and inspection are always on; external telemetry
// export is opt-in and requires explicit operator configuration. Placeholder
// until the first local event/trace store lands.

export interface PackageStatus {
  readonly package: "telemetry";
  readonly ready: false;
}

export const status: PackageStatus = {
  package: "telemetry",
  ready: false,
};
