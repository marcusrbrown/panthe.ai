// Live world state: entities instantiated from an authored ContentPack, plus
// the persisted PRNG state that keeps every random rule deterministic
// across replay and restore.
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
  Consequence,
  ContentPack,
  EntityId,
  EventEnvelope,
  EventId,
  InhabitantDrives,
  LegendId,
  LocationEdge,
  PetitionRequest,
  Realm,
  Recipe,
  ResourceAmount,
  UnmetNeedReason,
  WitnessedEventKind,
  WorldEvent,
  WorldRules,
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

/** An active worship effect: a source, a code-defined effect label, and the tick it expires at -- never wired into another system's rules directly. */
export interface FavorState {
  readonly source: EntityId;
  readonly effect: string;
  readonly expiresAtTick: number;
}

/** An actor's live state: an entity capable of proposing and being targeted. */
export interface ActorState {
  readonly id: EntityId;
  readonly locationId: EntityId;
  readonly alive: boolean;
  /** Whether this actor is an authored deity, authorized to be worshipped and to strike. Absent means it is not. */
  readonly isDeity?: boolean;
  /**
   * Capabilities this actor actually holds, as granted by world state (not
   * self-declared by a proposal). A restricted location's
   * `requiredCapability` is checked against this set, never against a
   * proposal's `requiredCapabilities` field, so a proposal can never grant
   * itself passage by merely claiming a capability.
   */
  readonly capabilities: readonly string[];
  /** Resources this actor holds, keyed by resource name. A resource absent from the map means zero. A deity's divine capacity is the "divinity" resource, spent and replenished through the same inventory mechanism as any other good. */
  readonly inventory: ReadonlyMap<string, number>;
  /**
   * Drive weights that make this actor's routine choices deterministic
   * (thrift, appetite, greed, piety). Absent means this actor is not
   * routine-driven -- a fixture or scenario actor a caller controls
   * directly, never `packages/world/src/routines.ts`.
   */
  readonly drives?: InhabitantDrives;
  /** Where a mortal's routine takes it back to after it has gone elsewhere (to pray). Set from its authored starting place; absent for a fixture actor. */
  readonly home?: EntityId;
  /** The resource this actor gathers when no more pressing action is eligible. Absent means it never gathers. */
  readonly gathers?: string;
  /** A resource this actor seeks to buy when it lacks some and can afford it. Absent means it wants nothing in particular. */
  readonly wants?: string;
  /** Worship effects currently in force, each checked against the current tick at read time -- an expired entry is never pruned by a mutation or an event, only ignored by `isFavorActive`. */
  readonly favors?: readonly FavorState[];
  /** Bumped whenever this actor's location, realm, or inventory changes. */
  readonly revision: number;
}

export const BUILDING_STATUSES = [
  "operational",
  "damaged",
  "burning",
  "destroyed",
  "repairing",
] as const;
export type BuildingStatus = (typeof BUILDING_STATUSES)[number];

/** What started a building's current fire, stored when it ignites and never inferred later: the ignition event, and the actor whose strike began the fire (carried through any spread). */
export interface BuildingIgnition {
  readonly eventId: EventId;
  /** The actor whose strike began the fire; absent when the quiet-world director did. */
  readonly actor?: EntityId;
}

/** What every building has, whatever its status. */
export interface BuildingBase {
  readonly id: EntityId;
  readonly locationId: EntityId;
  readonly name: string;
  readonly material: string;
  /** Whether fire can spread to and ignite this building; a non-combustible building never catches fire. */
  readonly combustible: boolean;
  readonly services: readonly string[];
  readonly inventory: ReadonlyMap<string, number>;
  readonly owner?: EntityId;
  readonly revision: number;
}

type NoFire = {
  readonly fireIntensity?: never;
  readonly ticksBurning?: never;
  readonly ignition?: never;
};
type NoRepair = { readonly repairProgress?: never };

/**
 * A building's live state: the authored structure plus its current
 * inventory, ownership, and fire/repair lifecycle: operational ->
 * damaged/burning -> destroyed -> repairing -> operational. Services and
 * income are exposed only while operational.
 *
 * A union on `status`, so the fields of a phase exist exactly in that phase. A
 * burning building has its fire's severity (`fireIntensity`, growing each tick
 * until it crosses the content-authored threshold and destroys the building),
 * `ticksBurning`, and the `ignition` that started the fire (burn ticks,
 * destruction, and spread all cite it). A repairing building has the
 * materials committed toward repair so far. No other status has either.
 */
export type BuildingState = BuildingBase &
  (
    | ({
        readonly status: "operational" | "damaged" | "destroyed";
      } & NoFire &
        NoRepair)
    | ({
        readonly status: "burning";
        readonly fireIntensity: number;
        readonly ticksBurning: number;
        readonly ignition: BuildingIgnition;
      } & NoRepair)
    | ({
        readonly status: "repairing";
        readonly repairProgress: number;
      } & NoFire)
  );

/** A building without its status or the fields of a status: what a transition starts from. */
export function buildingBase(building: BuildingState): BuildingBase {
  return {
    id: building.id,
    locationId: building.locationId,
    name: building.name,
    material: building.material,
    combustible: building.combustible,
    services: building.services,
    inventory: building.inventory,
    ...(building.owner === undefined ? {} : { owner: building.owner }),
    revision: building.revision,
  };
}

/**
 * An attributed narrative record: the narrator's free-form, possibly false
 * assertion, plus the event they cited as evidence, if any. The world never
 * judges whether the event supports the assertion, so a legend is at most
 * event-linked (`isEventLinked`), never certified. `id` is derived from the
 * event that recorded it, so every telling has its own identity, and a
 * disputed second telling of the same happening is another `LegendRecord`,
 * never a replacement for the first. Never mutates any other part of
 * `WorldState`.
 */
export interface LegendRecord {
  readonly id: LegendId;
  readonly narrator: EntityId;
  readonly assertion: string;
  readonly linkedEventId?: EventId;
}

/** Whether a legend cites a committed event as its evidence. This says nothing about whether the assertion is true. */
export function isEventLinked(legend: LegendRecord): boolean {
  return legend.linkedEventId !== undefined;
}

/**
 * One thing an actor remembers, in its own memory. `id` is the id of the
 * `memory-recorded` event that formed it, so a memory is identified by, and
 * explained by, the log. `sourceEventId` is the committed event it rests on: the
 * event witnessed, or the report heard. `recordedAt` is the sequence of the
 * recording event, which is what "older" means when memories tie in salience.
 * A told memory is a belief: the teller's account, attributed and possibly
 * false, held apart from the events and legends of the world.
 */
export type MemoryEntry = {
  readonly id: EventId;
  readonly sourceEventId: EventId;
  readonly salience: number;
  readonly recordedAt: number;
  readonly subjects: readonly EntityId[];
  readonly consequence?: Consequence;
} & (
  | { readonly kind: "witnessed"; readonly eventKind: WitnessedEventKind }
  | {
      readonly kind: "told";
      readonly teller: EntityId;
      readonly content: string;
      readonly linkedEventId?: EventId;
    }
  | {
      /** A god's answer, or its silence, to a petition: favor is the affinity it leaves. */
      readonly kind: "sign";
      readonly god: EntityId;
      readonly outcome: "answered" | "lapsed";
      readonly petitionId: EventId;
    }
);

/** How one actor feels toward another. Changed only by `relationship-changed` events, each citing the memory that caused it. */
export interface RelationshipState {
  readonly from: EntityId;
  readonly toward: EntityId;
  /** Whole number, positive for liking, negative for disliking, bounded by the world's affinity limit. */
  readonly affinity: number;
  /** How many times `toward` has personally wronged `from`. */
  readonly grudge: number;
  readonly allied: boolean;
}

/** The key a relationship is held under. */
export function relationshipKey(from: EntityId, toward: EntityId): string {
  return `${from}>${toward}`;
}

/** A god's one active goal: its own words, the one target it named, and the `goal-set` event that recorded it. Changed only by goal events. */
export interface ActiveGoal {
  readonly text: string;
  readonly target: EntityId;
  readonly eventId: EventId;
  /** The `goal-set` event's sequence: what happened "since the goal was set" is measured from it. */
  readonly sequence: number;
}

/** A mortal's routine needs `resource` and cannot get it, as recorded by the event `eventId` on `tick`. Open until a `need-met` event closes it. */
export interface OpenNeed {
  readonly actor: EntityId;
  readonly resource: string;
  readonly reason: UnmetNeedReason;
  readonly eventId: EventId;
  readonly tick: number;
}

/** What a mortal can pray about: a recorded event that happened to it. */
export type PetitionCauseKind =
  | "damage"
  | "fire"
  | "theft"
  | "spoilage"
  | "need"
  | "grudge";

export interface PetitionCause {
  readonly eventId: EventId;
  readonly tick: number;
  readonly kind: PetitionCauseKind;
  /** Who did it, when someone did and the world knows who. */
  readonly offender?: EntityId;
  readonly building?: EntityId;
  readonly resource?: string;
}

/** A petition: who asked which god, for what, about which cause, and how it stands. Rebuilt from the log. */
export interface Petition {
  /** The `petition-opened` event's id. */
  readonly id: EventId;
  readonly petitioner: EntityId;
  readonly god: EntityId;
  readonly cause: EventId;
  readonly request: PetitionRequest;
  readonly tick: number;
  readonly status: "open" | "answered" | "lapsed";
}

/** Whether `capabilities` satisfy a location's `requiredCapability`; the one rule move, realm-transition validation, and route search apply, exported so a caller can offer only what the rules would allow. */
export function hasCapability(
  capabilities: readonly string[],
  required: string | undefined,
): boolean {
  return required === undefined || capabilities.includes(required);
}

/** The key an open need is held under: one per mortal per resource. */
export function needKey(actor: EntityId, resource: string): string {
  return `${actor}|${resource}`;
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
   * `applyEvent` (actions.ts) to the applied event's own `sequence`, never
   * reset per tick, so `runTick` can always number a new tick's events
   * starting from `state.lastSequence + 1` regardless of how many prior
   * ticks committed.
   */
  readonly lastSequence: number;
  readonly locations: ReadonlyMap<EntityId, LocationState>;
  readonly actors: ReadonlyMap<EntityId, ActorState>;
  readonly buildings: ReadonlyMap<EntityId, BuildingState>;
  readonly legends: ReadonlyMap<LegendId, LegendRecord>;
  /**
   * What each actor remembers, oldest first, bounded by the memory capacity.
   * Deliberately outside `ActorState`: forming a memory must not bump an
   * actor's revision, or every witness's delayed proposal would go stale.
   */
  readonly memories: ReadonlyMap<EntityId, readonly MemoryEntry[]>;
  /** How actors feel toward one another, keyed by `relationshipKey`. */
  readonly relationships: ReadonlyMap<string, RelationshipState>;
  /**
   * Each god's active goal, at most one apiece. Private: nothing in the world
   * perceives it. Outside `ActorState`, like memories, so declaring a goal
   * never bumps an actor's revision and never stales a delayed proposal.
   */
  readonly goals: ReadonlyMap<EntityId, ActiveGoal>;
  /** Each mortal's open unmet needs, keyed by `needKey`. */
  readonly needs: ReadonlyMap<string, OpenNeed>;
  /** Each mortal's most recent prayable causes (newest last, bounded), recorded as the events happen. A need is a cause too, held in `needs`. */
  readonly causes: ReadonlyMap<EntityId, readonly PetitionCause[]>;
  /** Every petition ever opened, by its event id. */
  readonly petitions: ReadonlyMap<EventId, Petition>;
  /** The building a mortal was last blessed planks for: its repair routine mends that one first. */
  readonly repairGrants: ReadonlyMap<EntityId, EntityId>;
  /** Numeric balance content (catch-up, fire, economy); never mutated by any event or by `runTick` itself. */
  readonly rules: WorldRules;
  /** Recipes `produce` proposals convert inputs to outputs through; never mutated. */
  readonly recipes: Readonly<Record<string, Recipe>>;
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

/** Same trusted-cast rationale as `toEntityId`, for deterministically-derived legend ids (see `applyEvent`'s `legend-recorded` reducer). */
export function toLegendId(raw: string): LegendId {
  return raw as LegendId;
}

function toInventoryMap(
  amounts: readonly ResourceAmount[] | undefined,
): ReadonlyMap<string, number> {
  const inventory = new Map<string, number>();
  for (const amount of amounts ?? []) {
    inventory.set(amount.resource, amount.amount);
  }
  return inventory;
}

/** The capability every deity inhabitant starts with. A location's `requiredCapability` names it, and it is what opens the divine realms. */
export const DIVINE_CAPABILITY = "divine";

/**
 * Builds the initial live world state from a validated content pack: every
 * authored location becomes a `LocationState` at revision 0, every
 * authored inhabitant becomes an `ActorState` (alive, its own inventory and
 * drives baked in), and every authored building becomes a `BuildingState`,
 * all at revision 0. `rules` and `recipes` are copied from the pack
 * unchanged and never mutated afterward.
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

  const actors = new Map<EntityId, ActorState>();
  for (const inhabitant of pack.inhabitants) {
    const id = toEntityId(inhabitant.id);
    actors.set(id, {
      id,
      locationId: toEntityId(inhabitant.locationId),
      alive: true,
      ...(inhabitant.deity ? { isDeity: true } : {}),
      ...(inhabitant.drives === undefined
        ? {}
        : { home: toEntityId(inhabitant.locationId) }),
      capabilities: inhabitant.deity ? [DIVINE_CAPABILITY] : [],
      inventory: toInventoryMap(inhabitant.startingInventory),
      ...(inhabitant.drives === undefined ? {} : { drives: inhabitant.drives }),
      ...(inhabitant.gathers === undefined
        ? {}
        : { gathers: inhabitant.gathers }),
      ...(inhabitant.wants === undefined ? {} : { wants: inhabitant.wants }),
      revision: 0,
    });
  }

  const buildings = new Map<EntityId, BuildingState>();
  for (const building of pack.buildings) {
    const id = toEntityId(building.id);
    buildings.set(id, {
      id,
      locationId: toEntityId(building.locationId),
      name: building.name,
      material: building.material,
      combustible: building.combustible,
      services: building.services,
      inventory: toInventoryMap(building.inventory),
      status: "operational",
      revision: 0,
      ...(building.owner === undefined
        ? {}
        : { owner: toEntityId(building.owner) }),
    });
  }

  return {
    tick: 0,
    simTime: 0,
    lastSequence: 0,
    locations,
    actors,
    buildings,
    legends: new Map(),
    memories: new Map(),
    relationships: new Map(),
    goals: new Map(),
    needs: new Map(),
    causes: new Map(),
    petitions: new Map(),
    repairGrants: new Map(),
    rules: pack.rules,
    recipes: pack.recipes,
  };
}

/** Whether `favor` is still in force at `currentTick` -- the sole place expiry is checked; expired favors are never pruned from state or reported by an event. */
export function isFavorActive(favor: FavorState, currentTick: number): boolean {
  return currentTick < favor.expiresAtTick;
}

/** The subset of `actor.favors` still in force at `currentTick`. */
export function activeFavors(
  actor: ActorState,
  currentTick: number,
): readonly FavorState[] {
  return (actor.favors ?? []).filter((favor) =>
    isFavorActive(favor, currentTick),
  );
}

/** Adds or replaces an actor. Pure: returns a new `WorldState`. */
export function withActor(state: WorldState, actor: ActorState): WorldState {
  const actors = new Map(state.actors);
  actors.set(actor.id, actor);
  return { ...state, actors };
}

/** Adds or replaces a building. Pure: returns a new `WorldState`. */
export function withBuilding(
  state: WorldState,
  building: BuildingState,
): WorldState {
  const buildings = new Map(state.buildings);
  buildings.set(building.id, building);
  return { ...state, buildings };
}

/** Adds a legend record. Never mutates any other part of `WorldState` (a legend is never a replacement for an existing one, even about the same happening). */
export function withLegend(
  state: WorldState,
  record: LegendRecord,
): WorldState {
  const legends = new Map(state.legends);
  legends.set(record.id, record);
  return { ...state, legends };
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

export function getBuilding(
  state: WorldState,
  id: EntityId,
): BuildingState | undefined {
  return state.buildings.get(id);
}

/** The services a building actually offers right now: its authored list while operational, none otherwise -- a burning, damaged, destroyed, or repairing building exposes no services. */
export function effectiveServices(building: BuildingState): readonly string[] {
  return building.status === "operational" ? building.services : [];
}

/**
 * Looks up an entity's current revision across every entity kind the world
 * tracks, so `expectedRevisions` checks (packages/world/src/validate.ts) are
 * a single kind-agnostic pre-check rather than one per proposal kind.
 * Returns `undefined` if no entity with this id exists in any of them.
 */
export function getEntityRevision(
  state: WorldState,
  id: EntityId,
): number | undefined {
  return (
    state.actors.get(id)?.revision ??
    state.locations.get(id)?.revision ??
    state.buildings.get(id)?.revision
  );
}

// --- Deterministic PRNG -----------------------------------------------------
//
// mulberry32, matching the deterministic-layout pattern already used at
// the removed M0 renderer probe (`git show ce9e5a4:apps/probe-renderer/src/Scene.tsx`). The PRNG's entire state is one 32-bit
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
