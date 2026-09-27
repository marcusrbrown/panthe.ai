// Versioned wire and storage contracts for M1: branded identifiers, parse-
// don't-validate parsers, and the shared vocabulary every other package
// (world, persistence, telemetry, simulation, client) decodes untrusted
// input through. See
// docs/plans/2026-09-27-001-feat-m1-persistent-living-world-plan.md
// (Unit 1) for the design rationale.

export * from "./archive";
export * from "./content";
export * from "./event";
export * from "./ids";
export * from "./proposal";
export * from "./snapshot";
