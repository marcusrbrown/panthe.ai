// Local causal trace store and "follow this event" query. Local causal
// recording and inspection are always on; external telemetry export is a
// separate, opt-in concern not implemented by this package yet (see
// docs/README.md invariants and ADR-0006).

export * from "./query";
export * from "./trace";
