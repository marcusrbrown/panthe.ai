// What an actor can perceive, as a pure function of committed state (plus a
// bounded window of recent committed events the caller already holds).
// Nothing here reads the trace, a frame, or memory; a model-driven actor
// reasons only from this snapshot, so anything absent from it is unknown to
// that actor.
//
// The rule today is co-location: an actor perceives the location it stands
// in, the living actors and the buildings there, and events that happened
// there. `perceivedLocations` is the one place that rule lives. A sensing
// power (a costed divine sense reaching other locations) widens the set it
// returns; the rest of this module filters by that set and already carries a
// `locationId` on everything it reports.

import type { EntityId, ResourceAmount, WorldEvent } from "@panthea/contracts";
import { outgoingEdges } from "./geography";
import {
  type ActorState,
  type BuildingState,
  getActor,
  getBuilding,
  getLocation,
  toEntityId,
  type WorldState,
} from "./state";
import { DIVINE_CAPACITY_RESOURCE } from "./worship";

/** Most events a snapshot carries: the latest perceived ones, so a prompt stays inside the context bound. */
export const MAX_PERCEIVED_EVENTS = 8;

export interface PerceivedSelf {
  readonly id: EntityId;
  readonly revision: number;
  readonly isDeity: boolean;
  /** Everything the actor holds, by resource name. */
  readonly inventory: readonly ResourceAmount[];
  /** The `divinity` held: what a strike spends. */
  readonly divinity: number;
}

/** Another actor as seen from outside: identity, place, and revision. Its goods are not seen. */
export interface PerceivedActor {
  readonly id: EntityId;
  readonly locationId: EntityId;
  readonly revision: number;
  readonly isDeity: boolean;
}

export interface PerceivedBuilding {
  readonly id: EntityId;
  readonly locationId: EntityId;
  readonly name: string;
  readonly status: BuildingState["status"];
  readonly combustible: boolean;
  readonly owner?: EntityId;
  readonly revision: number;
}

/** A way out of the observer's location. */
export interface PerceivedExit {
  readonly to: EntityId;
  readonly name: string;
  readonly realm: string;
  readonly transport: string;
}

export interface PerceptionSnapshot {
  readonly observer: EntityId;
  readonly tick: number;
  /** The last committed event sequence the snapshot was taken at; what an observation records as `stateRevision`. */
  readonly stateRevision: number;
  readonly self: PerceivedSelf;
  readonly location: {
    readonly id: EntityId;
    readonly name: string;
    readonly realm: string;
    readonly revision: number;
  };
  readonly exits: readonly PerceivedExit[];
  readonly actors: readonly PerceivedActor[];
  readonly buildings: readonly PerceivedBuilding[];
  /** Perceived events, oldest first. */
  readonly events: readonly WorldEvent[];
}

/**
 * The locations `actor` perceives. Co-location only: the one it stands in.
 * A sensing power would add the locations it reaches (and charge for them)
 * here.
 */
export function perceivedLocations(
  _state: WorldState,
  actor: ActorState,
): ReadonlySet<EntityId> {
  return new Set([actor.locationId]);
}

function isMove(
  event: WorldEvent,
): event is Extract<
  WorldEvent,
  { kind: "entity-moved" | "realm-transitioned" }
> {
  return event.kind === "entity-moved" || event.kind === "realm-transitioned";
}

/**
 * Where an actor was when `event` happened, from the window alone: the
 * destination of its latest move before the event; else its current place if
 * it has not moved within the window; else unknown, because the window then
 * holds only a later move and never says where the actor came from. Unknown
 * places are never perceived, so an event is not credited to a location it
 * may not have happened in.
 */
function actorLocationAt(
  state: WorldState,
  actorId: EntityId,
  event: WorldEvent,
  window: readonly WorldEvent[],
): EntityId | undefined {
  let before: EntityId | undefined;
  let beforeSequence = -1;
  let movedLater = false;
  for (const candidate of window) {
    if (!isMove(candidate) || candidate.entityId !== actorId) continue;
    if (candidate.sequence < event.sequence) {
      if (candidate.sequence > beforeSequence) {
        before = candidate.to;
        beforeSequence = candidate.sequence;
      }
    } else if (candidate.sequence > event.sequence) {
      movedLater = true;
    }
  }
  if (before !== undefined) return before;
  if (movedLater) return undefined;
  return getActor(state, actorId)?.locationId;
}

/** The location an event happened in, or `undefined` when the window and state cannot place it. */
function eventLocation(
  state: WorldState,
  event: WorldEvent,
  window: readonly WorldEvent[],
): EntityId | undefined {
  switch (event.kind) {
    // Arrivals happen where the mover arrives.
    case "entity-moved":
    case "realm-transitioned":
      return event.to;
    // Buildings do not move: they place their own events.
    case "building-damaged":
    case "building-ignited":
    case "building-burn-ticked":
    case "building-destroyed":
    case "building-repaired":
      return getBuilding(state, event.entityId)?.locationId;
    case "repair-progressed":
      return getBuilding(state, event.structureId)?.locationId;
    case "income-earned":
      return getBuilding(state, event.buildingId)?.locationId;
    // The rest are an actor doing something where it stood.
    case "resource-gathered":
    case "resource-produced":
    case "resource-consumed":
    case "resource-traded":
    case "worship-performed":
    case "legend-recorded":
      return actorLocationAt(state, event.entityId, event, window);
  }
}

function sortedInventory(
  inventory: ReadonlyMap<string, number>,
): readonly ResourceAmount[] {
  return [...inventory.entries()]
    .filter(([, amount]) => amount > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([resource, amount]) => ({ resource, amount }));
}

function compareIds(a: { readonly id: string }, b: { readonly id: string }) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The snapshot of what `actorId` perceives right now, or `undefined` when it
 * is unknown or dead. `recentEvents` is the bounded window of recently
 * committed events the caller holds (the world keeps no event log); events
 * outside the actor's perceived locations, or that the window cannot place,
 * are left out. Pure: same state and window, same snapshot.
 */
export function perceive(
  state: WorldState,
  actorId: EntityId,
  recentEvents: readonly WorldEvent[] = [],
): PerceptionSnapshot | undefined {
  const actor = getActor(state, actorId);
  if (!actor?.alive) return undefined;
  const here = getLocation(state, actor.locationId);
  if (!here) return undefined;

  const locations = perceivedLocations(state, actor);

  const exits: PerceivedExit[] = [];
  const seenExits = new Set<EntityId>();
  for (const edge of outgoingEdges(state, actor.locationId)) {
    const to = toEntityId(edge.to);
    const destination = getLocation(state, to);
    if (!destination || seenExits.has(to)) continue;
    seenExits.add(to);
    exits.push({
      to: destination.id,
      name: destination.name,
      realm: destination.realm,
      transport: edge.transport,
    });
  }
  exits.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

  const actors: PerceivedActor[] = [];
  for (const other of state.actors.values()) {
    if (other.id === actorId || !other.alive) continue;
    if (!locations.has(other.locationId)) continue;
    actors.push({
      id: other.id,
      locationId: other.locationId,
      revision: other.revision,
      isDeity: other.isDeity === true,
    });
  }
  actors.sort(compareIds);

  const buildings: PerceivedBuilding[] = [];
  for (const building of state.buildings.values()) {
    if (!locations.has(building.locationId)) continue;
    buildings.push({
      id: building.id,
      locationId: building.locationId,
      name: building.name,
      status: building.status,
      combustible: building.combustible,
      ...(building.owner === undefined ? {} : { owner: building.owner }),
      revision: building.revision,
    });
  }
  buildings.sort(compareIds);

  const events = [...recentEvents]
    .sort((a, b) => a.sequence - b.sequence)
    .filter((event) => {
      const at = eventLocation(state, event, recentEvents);
      return at !== undefined && locations.has(at);
    })
    .slice(-MAX_PERCEIVED_EVENTS);

  return {
    observer: actorId,
    tick: state.tick,
    stateRevision: state.lastSequence,
    self: {
      id: actorId,
      revision: actor.revision,
      isDeity: actor.isDeity === true,
      inventory: sortedInventory(actor.inventory),
      divinity: actor.inventory.get(DIVINE_CAPACITY_RESOURCE) ?? 0,
    },
    location: {
      id: here.id,
      name: here.name,
      realm: here.realm,
      revision: here.revision,
    },
    exits,
    actors,
    buildings,
    events,
  };
}
