// Pure graph queries over the live location state built by
// `createInitialWorldState` (state.ts). Realm identity lives on each
// location, not on the graph structure: town and wilderness locations share
// one continuous graph distinguished only by their `realm` field, while
// Olympus and the Underworld are graphs an actor can only reach through an
// authored transport edge -- there is no structural notion of "the mortal
// graph" versus "the Olympus graph" here, only edges and the realms their
// endpoints declare.

import type { EntityId, LocationEdge, Realm } from "@panthea/contracts";
import {
  getLocation,
  type LocationState,
  toEntityId,
  type WorldState,
} from "./state";

/** Where mortals pray: the altar location of the authored map. A prayer is placed here, so anyone standing here saw it. */
export const ALTAR = toEntityId("altar");

/**
 * Every edge usable from `locationId`, including the synthetic reverse of
 * any neighboring location's `bidirectional: true` edge that points back at
 * it. Authored content only needs to declare a bidirectional edge once, from
 * either endpoint.
 */
export function outgoingEdges(
  state: WorldState,
  locationId: EntityId,
): readonly LocationEdge[] {
  const here = getLocation(state, locationId);
  const declared = here?.edges ?? [];
  const reverse: LocationEdge[] = [];
  for (const [otherId, other] of state.locations) {
    if (otherId === locationId) continue;
    for (const edge of other.edges) {
      if (edge.bidirectional && edge.to === locationId) {
        reverse.push({
          to: otherId,
          transport: edge.transport,
          bidirectional: edge.bidirectional,
        });
      }
    }
  }
  return [...declared, ...reverse];
}

export function findEdge(
  state: WorldState,
  fromId: EntityId,
  toId: EntityId,
): LocationEdge | undefined {
  return outgoingEdges(state, fromId).find((edge) => edge.to === toId);
}

export function isAdjacent(
  state: WorldState,
  fromId: EntityId,
  toId: EntityId,
): boolean {
  return findEdge(state, fromId, toId) !== undefined;
}

export function crossesRealm(
  state: WorldState,
  fromId: EntityId,
  toId: EntityId,
): boolean {
  const from = getLocation(state, fromId);
  const to = getLocation(state, toId);
  if (!from || !to) return false;
  return from.realm !== to.realm;
}

export function locationsInRealm(
  state: WorldState,
  realm: Realm,
): readonly LocationState[] {
  return [...state.locations.values()].filter((loc) => loc.realm === realm);
}
