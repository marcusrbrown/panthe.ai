// The projection codec: `WorldState` keeps its entities in `Map`s for O(1)
// lookup, but `JSON.stringify` silently drops a `Map`'s contents (it
// serializes to `{}`), and packages/persistence stores projections as one
// opaque JSON document. `encode`/`decode` are the one place that boundary
// is crossed, so nothing else in packages/world needs to know or care
// that the stored form isn't a `Map`.

import type { EntityId } from "@panthea/contracts";
import type { ActorState, LocationState, WorldState } from "./state";

/**
 * The JSON-safe encoded form of a `WorldState`: entries arrays instead of
 * `Map`s, everything else unchanged. Round-trips through
 * `JSON.stringify`/`JSON.parse` losslessly.
 */
export interface EncodedWorldState {
  readonly tick: number;
  readonly simTime: number;
  readonly lastSequence: number;
  readonly locations: readonly (readonly [EntityId, LocationState])[];
  readonly actors: readonly (readonly [EntityId, ActorState])[];
}

/** Encodes `state` into the JSON-safe form persistence stores. */
export function encode(state: WorldState): EncodedWorldState {
  return {
    tick: state.tick,
    simTime: state.simTime,
    lastSequence: state.lastSequence,
    locations: [...state.locations.entries()],
    actors: [...state.actors.entries()],
  };
}

/**
 * Decodes a previously `encode`d value back into a live `WorldState`. Trusts
 * its input: this is our own round-tripped data coming back from storage,
 * not untrusted external input.
 */
export function decode(value: EncodedWorldState): WorldState {
  return {
    tick: value.tick,
    simTime: value.simTime,
    lastSequence: value.lastSequence,
    locations: new Map(value.locations),
    actors: new Map(value.actors),
  };
}
