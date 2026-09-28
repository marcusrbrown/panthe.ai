// Live world state: entities instantiated from an authored ContentPack, plus
// the persisted PRNG state that keeps every random rule deterministic across
// replay and restore (Key Technical Decisions, "Determinism boundary").
//
// Content-authored IDs (plain strings validated by packages/contracts'
// content parser) are reused directly as the live EntityId for locations:
// there is no separate ID-minting step for map geography, which keeps
// authored content, live state, and event payloads referencing the same
// identifiers end to end.
//
// packages/world never depends on SQLite or any storage engine: everything
// here is a plain immutable value plus pure functions over it. Persistence
// treats these shapes as the opaque projection payload described in
// packages/contracts' `SyncFrame.state`.

import type {
  ContentPack,
  EntityId,
  EventEnvelope,
  LocationEdge,
  Realm,
  WorldEvent,
} from "@panthea/contracts";

/** A location's live state: the authored graph node plus a revision counter. */
export interface LocationState {
  readonly id: EntityId;
  readonly realm: Realm;
  readonly name: string;
  readonly edges: readonly LocationEdge[];
  readonly requiredCapability?: string;
  /**
   * Bumped whenever an actor arrives at or departs from this location, so a
   * proposal that named this location's revision in `expectedRevisions` can
   * be caught as stale if occupancy changed since observation.
   */
  readonly revision: number;
}

/** An actor's live state: an entity capable of proposing and being targeted. */
export interface ActorState {
  readonly id: EntityId;
  readonly locationId: EntityId;
  readonly alive: boolean;
  /**
   * Capabilities this actor actually holds, as granted by world state (not
   * self-declared by a proposal). A restricted location's
   * `requiredCapability` is checked against this set, never against a
   * proposal's `requiredCapabilities` field, so a proposal can never grant
   * itself passage by merely claiming a capability.
   */
  readonly capabilities: readonly string[];
  /** Bumped whenever this actor's location (and therefore realm) changes. */
  readonly revision: number;
}

export interface WorldState {
  /** Monotonic tick counter; advances by exactly one per committed tick. */
  readonly tick: number;
  /** Simulated milliseconds elapsed; advances by each tick's elapsed time. */
  readonly simTime: number;
  /**
   * The sequence number of the last event committed anywhere in this
   * world's history -- global and contiguous across every tick, matching
   * packages/persistence's `commitTick` contiguity requirement. Bumped by
   * `ReducerRegistry.apply` (actions.ts) to the applied event's own
   * `sequence`, never reset per tick, so `runTick` can always number a new
   * tick's events starting from `state.lastSequence + 1` regardless of how
   * many prior ticks committed.
   */
  readonly lastSequence: number;
  readonly locations: ReadonlyMap<EntityId, LocationState>;
  readonly actors: ReadonlyMap<EntityId, ActorState>;
}

/**
 * A rule handler's committed-event payload, before the tick pipeline
 * (actions.ts) assigns the shared envelope fields (id, sequence, simTime,
 * correlationId, causationId, approximate). Rule handlers stay pure and
 * focused on "what happened"; only the tick loop knows the running
 * sequence number and the proposal's causal identifiers. Distributes over
 * `WorldEvent` so a new event kind gets a draft counterpart for free.
 */
export type WorldEventDraft<E = WorldEvent> = E extends EventEnvelope
  ? Omit<E, keyof EventEnvelope>
  : never;

/**
 * Brands a known-good, non-empty string as an `EntityId`. Content ids are
 * reused directly as live entity ids (see module docs), so this is the one
 * place that conversion happens; it is exported so fixtures, scenarios, and
 * content-derived entities (buildings, inhabitants) can do the same
 * conversion. A trusted cast, not a parse: the caller already knows the
 * string is a valid, non-empty id (content already passed through
 * packages/contracts' parser).
 */
export function toEntityId(raw: string): EntityId {
  return raw as EntityId;
}

/**
 * Builds the initial live world state from a validated content pack: every
 * authored location becomes a `LocationState` at revision 0. No actors are
 * created here; they are seeded separately by `withActor` (fixtures,
 * scenarios) or by content that authors inhabitants.
 */
export function createInitialWorldState(pack: ContentPack): WorldState {
  const locations = new Map<EntityId, LocationState>();
  for (const location of pack.locations) {
    const id = toEntityId(location.id);
    locations.set(id, {
      id,
      realm: location.realm,
      name: location.name,
      edges: location.edges,
      revision: 0,
      ...(location.requiredCapability === undefined
        ? {}
        : { requiredCapability: location.requiredCapability }),
    });
  }
  return {
    tick: 0,
    simTime: 0,
    lastSequence: 0,
    locations,
    actors: new Map(),
  };
}

/** Adds or replaces an actor. Pure: returns a new `WorldState`. */
export function withActor(state: WorldState, actor: ActorState): WorldState {
  const actors = new Map(state.actors);
  actors.set(actor.id, actor);
  return { ...state, actors };
}

export function getActor(
  state: WorldState,
  id: EntityId,
): ActorState | undefined {
  return state.actors.get(id);
}

export function getLocation(
  state: WorldState,
  id: EntityId,
): LocationState | undefined {
  return state.locations.get(id);
}

/**
 * Looks up an entity's current revision across every entity kind the world
 * tracks, so `expectedRevisions` checks (packages/world/src/validate.ts) are
 * a single kind-agnostic pre-check rather than one per proposal kind.
 * Returns `undefined` if no entity with this id exists in either map.
 */
export function getEntityRevision(
  state: WorldState,
  id: EntityId,
): number | undefined {
  return state.actors.get(id)?.revision ?? state.locations.get(id)?.revision;
}

// --- Deterministic PRNG -----------------------------------------------------
//
// mulberry32, matching the deterministic-layout pattern already used at
// apps/probe-renderer/src/Scene.tsx. The PRNG's entire state is one 32-bit
// integer that world rules take in and return the next value of, per Key
// Technical Decisions' determinism boundary: "a seeded PRNG persisted in the
// world store drives every random rule, so replays and restored snapshots
// continue identically."

export interface PrngState {
  readonly seed: number;
}

export function createPrng(seed: number): PrngState {
  return { seed: seed >>> 0 };
}

/** Returns the next float in `[0, 1)` and the next `PrngState` to thread forward. */
export function nextPrngValue(state: PrngState): {
  readonly value: number;
  readonly state: PrngState;
} {
  let t = (state.seed + 0x6d2b79f5) >>> 0;
  const nextSeed = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: { seed: nextSeed } };
}
