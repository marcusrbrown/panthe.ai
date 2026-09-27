// Rules, actions, time, economy, conflict, and perception (M1+).
//
// Unit 3 delivers world core, geography, and the action pipeline: entities
// and the three-realm location graph (state.ts), pure adjacency/realm
// queries (geography.ts), execution-time proposal validation with a
// registry later units extend (validate.ts), and the tick scheduler plus
// event-reducer registry persistence replays to rebuild projections
// (actions.ts). packages/world never depends on SQLite or any storage
// engine; everything here is pure functions over plain values.

export * from "./actions";
export * from "./geography";
export * from "./state";
export * from "./validate";
