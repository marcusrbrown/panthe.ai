// The projection codec: `WorldState` keeps its entities in `Map`s for O(1)
// lookup, but `JSON.stringify` silently drops a `Map`'s contents (it
// serializes to `{}`), and packages/persistence stores projections as one
// opaque JSON document. `encode`/`decode` are the one place that boundary
// is crossed, so nothing else in packages/world needs to know or care
// that the stored form isn't a `Map`.
//
// `decode` parses rather than casts: its input comes back out of storage
// (or, via persistence's import path, out of an archive file), so it is
// validated the same way any other untrusted boundary in packages/contracts
// is -- shape, field types, and referential integrity (an actor's or
// building's `locationId` must name a location that actually exists; a
// location's `realm` must be a known realm; a building's `owner` must name
// a known actor).

import {
  type EntityId,
  type EventId,
  fail,
  type InhabitantDrives,
  isRecord,
  type LegendId,
  type LocationEdge,
  ok,
  type ParseResult,
  parseArray,
  parseBoolean,
  parseConsequence,
  parseEntityId,
  parseEnum,
  parseEventId,
  parseGoalText,
  parseLegendId,
  parseMemoryBalance,
  parseNonNegativeInteger,
  parseNonNegativeNumber,
  parseOptionalBoolean,
  parseOptionalString,
  parsePetitionBalance,
  parsePetitionRequest,
  parseRecipes,
  parseReportContent,
  parseSalience,
  parseString,
  REALMS,
  type RejectionReasonCode,
  TRANSPORT_KINDS,
  UNMET_NEED_REASONS,
  WITNESSED_EVENT_KINDS,
} from "@panthea/contracts";
import { memoryBalanceOf } from "./memory";
import {
  type ActiveGoal,
  type ActorState,
  BUILDING_STATUSES,
  type BuildingBase,
  type BuildingIgnition,
  type BuildingState,
  type BuildingStatus,
  type FavorState,
  type LegendRecord,
  type LocationState,
  type MemoryEntry,
  needKey,
  type OpenNeed,
  type Petition,
  type PetitionCause,
  type RelationshipState,
  relationshipKey,
  type WorldState,
} from "./state";

/**
 * The JSON-safe encoded form of a `WorldState`: entries arrays instead of
 * `Map`s, everything else unchanged. Round-trips through
 * `JSON.stringify`/`JSON.parse` losslessly.
 */
export interface EncodedWorldState {
  readonly tick: number;
  readonly simTime: number;
  readonly lastSequence: number;
  readonly locations: readonly (readonly [EntityId, EncodedLocationState])[];
  readonly actors: readonly (readonly [EntityId, EncodedActorState])[];
  readonly buildings: readonly (readonly [EntityId, EncodedBuildingState])[];
  readonly legends: readonly (readonly [LegendId, LegendRecord])[];
  readonly memories: readonly (readonly [EntityId, readonly MemoryEntry[]])[];
  readonly relationships: readonly (readonly [string, RelationshipState])[];
  readonly goals: readonly (readonly [EntityId, ActiveGoal])[];
  readonly needs: readonly (readonly [string, OpenNeed])[];
  readonly causes: readonly (readonly [EntityId, readonly PetitionCause[]])[];
  readonly petitions: readonly (readonly [EventId, Petition])[];
  readonly repairGrants: readonly (readonly [EntityId, EntityId])[];
  readonly rules: WorldState["rules"];
  readonly recipes: WorldState["recipes"];
}

type EncodedLocationState = Omit<LocationState, "edges"> & {
  readonly edges: readonly LocationEdge[];
};
type EncodedActorState = Omit<ActorState, "inventory"> & {
  readonly inventory: readonly (readonly [string, number])[];
};
type EncodedBuildingState = Omit<BuildingState, "inventory"> & {
  readonly inventory: readonly (readonly [string, number])[];
};

function encodeInventory(
  inventory: ReadonlyMap<string, number>,
): readonly (readonly [string, number])[] {
  return [...inventory.entries()];
}

/** Encodes `state` into the JSON-safe form persistence stores. */
export function encode(state: WorldState): EncodedWorldState {
  return {
    tick: state.tick,
    simTime: state.simTime,
    lastSequence: state.lastSequence,
    locations: [...state.locations.entries()],
    actors: [...state.actors.entries()].map(
      ([id, actor]) =>
        [
          id,
          { ...actor, inventory: encodeInventory(actor.inventory) },
        ] as const,
    ),
    buildings: [...state.buildings.entries()].map(
      ([id, building]) =>
        [
          id,
          { ...building, inventory: encodeInventory(building.inventory) },
        ] as const,
    ),
    legends: [...state.legends.entries()],
    memories: [...state.memories.entries()],
    relationships: [...state.relationships.entries()],
    goals: [...state.goals.entries()],
    needs: [...state.needs.entries()],
    causes: [...state.causes.entries()],
    petitions: [...state.petitions.entries()],
    repairGrants: [...state.repairGrants.entries()],
    rules: state.rules,
    recipes: state.recipes,
  };
}

/** Thrown by `decode` when its input is not a well-formed encoded `WorldState`. */
export class WorldStateDecodeError extends Error {
  constructor(
    readonly path: string,
    readonly reason: RejectionReasonCode,
    message: string,
  ) {
    super(path ? `${path}: ${message}` : message);
    this.name = "WorldStateDecodeError";
  }
}

function parseLocationEdge(
  value: unknown,
  path: string,
): ParseResult<LocationEdge> {
  if (!isRecord(value)) return fail(path, "expected a location edge entry");
  const to = parseString(value.to, `${path}.to`);
  if (!to.ok) return to;
  const transport = parseEnum(
    value.transport,
    `${path}.transport`,
    TRANSPORT_KINDS,
  );
  if (!transport.ok) return transport;
  const bidirectional = parseBoolean(
    value.bidirectional,
    `${path}.bidirectional`,
  );
  if (!bidirectional.ok) return bidirectional;
  return ok({
    to: to.value,
    transport: transport.value,
    bidirectional: bidirectional.value,
  });
}

function parseLocationState(
  value: unknown,
  path: string,
): ParseResult<LocationState> {
  if (!isRecord(value)) return fail(path, "expected a location state object");
  const id = parseEntityId(value.id, `${path}.id`);
  if (!id.ok) return id;
  const realm = parseEnum(value.realm, `${path}.realm`, REALMS);
  if (!realm.ok) return realm;
  const name = parseString(value.name, `${path}.name`);
  if (!name.ok) return name;
  const edges = parseArray(value.edges, `${path}.edges`, parseLocationEdge);
  if (!edges.ok) return edges;
  const revision = parseNonNegativeInteger(value.revision, `${path}.revision`);
  if (!revision.ok) return revision;
  const requiredCapability = parseOptionalString(
    value.requiredCapability,
    `${path}.requiredCapability`,
  );
  if (!requiredCapability.ok) return requiredCapability;
  return ok({
    id: id.value,
    realm: realm.value,
    name: name.value,
    edges: edges.value,
    revision: revision.value,
    ...(requiredCapability.value === undefined
      ? {}
      : { requiredCapability: requiredCapability.value }),
  });
}

function parseLocationEntry(
  value: unknown,
  path: string,
): ParseResult<readonly [EntityId, LocationState]> {
  if (!Array.isArray(value) || value.length !== 2) {
    return fail(path, "expected a [id, location] entry");
  }
  const id = parseEntityId(value[0], `${path}[0]`);
  if (!id.ok) return id;
  const state = parseLocationState(value[1], `${path}[1]`);
  if (!state.ok) return state;
  if (id.value !== state.value.id) {
    return fail(
      `${path}[0]`,
      `entry key "${id.value}" does not match its own id field "${state.value.id}"`,
    );
  }
  return ok([id.value, state.value] as const);
}

function parseInventoryEntry(
  value: unknown,
  path: string,
): ParseResult<readonly [string, number]> {
  if (!Array.isArray(value) || value.length !== 2) {
    return fail(path, "expected a [resource, amount] entry");
  }
  const resource = parseString(value[0], `${path}[0]`);
  if (!resource.ok) return resource;
  const amount = parseNonNegativeNumber(value[1], `${path}[1]`);
  if (!amount.ok) return amount;
  return ok([resource.value, amount.value] as const);
}

function parseInventory(
  value: unknown,
  path: string,
): ParseResult<ReadonlyMap<string, number>> {
  const entries = parseArray(value, path, parseInventoryEntry);
  if (!entries.ok) return entries;
  const seen = new Set<string>();
  for (const [resource] of entries.value) {
    if (seen.has(resource)) {
      return fail(path, `duplicate resource in inventory: ${resource}`);
    }
    seen.add(resource);
  }
  return ok(new Map(entries.value));
}

function parseFavor(value: unknown, path: string): ParseResult<FavorState> {
  if (!isRecord(value)) return fail(path, "expected a favor entry");
  const source = parseEntityId(value.source, `${path}.source`);
  if (!source.ok) return source;
  const effect = parseString(value.effect, `${path}.effect`);
  if (!effect.ok) return effect;
  const expiresAtTick = parseNonNegativeInteger(
    value.expiresAtTick,
    `${path}.expiresAtTick`,
  );
  if (!expiresAtTick.ok) return expiresAtTick;
  return ok({
    source: source.value,
    effect: effect.value,
    expiresAtTick: expiresAtTick.value,
  });
}

function parseFavors(
  value: unknown,
  path: string,
): ParseResult<readonly FavorState[] | undefined> {
  if (value === undefined) return ok(undefined);
  return parseArray(value, path, parseFavor);
}

function parseDrives(
  value: unknown,
  path: string,
): ParseResult<InhabitantDrives | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value)) return fail(path, "expected a drives object");
  const thrift = parseNonNegativeNumber(value.thrift, `${path}.thrift`);
  if (!thrift.ok) return thrift;
  const appetite = parseNonNegativeNumber(value.appetite, `${path}.appetite`);
  if (!appetite.ok) return appetite;
  const greed = parseNonNegativeNumber(value.greed, `${path}.greed`);
  if (!greed.ok) return greed;
  const piety = parseNonNegativeNumber(value.piety, `${path}.piety`);
  if (!piety.ok) return piety;
  return ok({
    thrift: thrift.value,
    appetite: appetite.value,
    greed: greed.value,
    piety: piety.value,
  });
}

function parseActorState(
  value: unknown,
  path: string,
  knownLocationIds: ReadonlySet<EntityId>,
): ParseResult<ActorState> {
  if (!isRecord(value)) return fail(path, "expected an actor state object");
  const id = parseEntityId(value.id, `${path}.id`);
  if (!id.ok) return id;
  const locationId = parseEntityId(value.locationId, `${path}.locationId`);
  if (!locationId.ok) return locationId;
  if (!knownLocationIds.has(locationId.value)) {
    return fail(
      `${path}.locationId`,
      `actor references unknown location: ${locationId.value}`,
    );
  }
  const alive = parseBoolean(value.alive, `${path}.alive`);
  if (!alive.ok) return alive;
  const isDeity = parseOptionalBoolean(value.isDeity, `${path}.isDeity`);
  if (!isDeity.ok) return isDeity;
  const capabilities = parseArray(
    value.capabilities,
    `${path}.capabilities`,
    parseString,
  );
  if (!capabilities.ok) return capabilities;
  const inventory = parseInventory(value.inventory, `${path}.inventory`);
  if (!inventory.ok) return inventory;
  const drives = parseDrives(value.drives, `${path}.drives`);
  if (!drives.ok) return drives;
  const home =
    value.home === undefined
      ? ok<EntityId | undefined>(undefined)
      : parseEntityId(value.home, `${path}.home`);
  if (!home.ok) return home;
  const gathers = parseOptionalString(value.gathers, `${path}.gathers`);
  if (!gathers.ok) return gathers;
  const wants = parseOptionalString(value.wants, `${path}.wants`);
  if (!wants.ok) return wants;
  const favors = parseFavors(value.favors, `${path}.favors`);
  if (!favors.ok) return favors;
  const revision = parseNonNegativeInteger(value.revision, `${path}.revision`);
  if (!revision.ok) return revision;
  return ok({
    id: id.value,
    locationId: locationId.value,
    alive: alive.value,
    ...(isDeity.value === undefined ? {} : { isDeity: isDeity.value }),
    capabilities: capabilities.value,
    inventory: inventory.value,
    ...(drives.value === undefined ? {} : { drives: drives.value }),
    ...(home.value === undefined ? {} : { home: home.value }),
    ...(gathers.value === undefined ? {} : { gathers: gathers.value }),
    ...(wants.value === undefined ? {} : { wants: wants.value }),
    ...(favors.value === undefined ? {} : { favors: favors.value }),
    revision: revision.value,
  });
}

function parseActorEntry(
  value: unknown,
  path: string,
  knownLocationIds: ReadonlySet<EntityId>,
): ParseResult<readonly [EntityId, ActorState]> {
  if (!Array.isArray(value) || value.length !== 2) {
    return fail(path, "expected a [id, actor] entry");
  }
  const id = parseEntityId(value[0], `${path}[0]`);
  if (!id.ok) return id;
  const state = parseActorState(value[1], `${path}[1]`, knownLocationIds);
  if (!state.ok) return state;
  if (id.value !== state.value.id) {
    return fail(
      `${path}[0]`,
      `entry key "${id.value}" does not match its own id field "${state.value.id}"`,
    );
  }
  return ok([id.value, state.value] as const);
}

function parseBuildingState(
  value: unknown,
  path: string,
  knownLocationIds: ReadonlySet<EntityId>,
  knownActorIds: ReadonlySet<EntityId>,
): ParseResult<BuildingState> {
  if (!isRecord(value)) return fail(path, "expected a building state object");
  const id = parseEntityId(value.id, `${path}.id`);
  if (!id.ok) return id;
  const locationId = parseEntityId(value.locationId, `${path}.locationId`);
  if (!locationId.ok) return locationId;
  if (!knownLocationIds.has(locationId.value)) {
    return fail(
      `${path}.locationId`,
      `building references unknown location: ${locationId.value}`,
    );
  }
  const name = parseString(value.name, `${path}.name`);
  if (!name.ok) return name;
  const material = parseString(value.material, `${path}.material`);
  if (!material.ok) return material;
  const combustible = parseBoolean(value.combustible, `${path}.combustible`);
  if (!combustible.ok) return combustible;
  const services = parseArray(value.services, `${path}.services`, parseString);
  if (!services.ok) return services;
  const inventory = parseInventory(value.inventory, `${path}.inventory`);
  if (!inventory.ok) return inventory;
  const ownerRaw = parseOptionalString(value.owner, `${path}.owner`);
  if (!ownerRaw.ok) return ownerRaw;
  if (ownerRaw.value !== undefined) {
    const owner = parseEntityId(ownerRaw.value, `${path}.owner`);
    if (!owner.ok) return owner;
    if (!knownActorIds.has(owner.value)) {
      return fail(
        `${path}.owner`,
        `building references unknown owner: ${owner.value}`,
      );
    }
  }
  const status = parseEnum(value.status, `${path}.status`, BUILDING_STATUSES);
  if (!status.ok) return status;
  const revision = parseNonNegativeInteger(value.revision, `${path}.revision`);
  if (!revision.ok) return revision;
  const base: BuildingBase = {
    id: id.value,
    locationId: locationId.value,
    name: name.value,
    material: material.value,
    combustible: combustible.value,
    services: services.value,
    inventory: inventory.value,
    ...(ownerRaw.value === undefined
      ? {}
      : { owner: ownerRaw.value as EntityId }),
    revision: revision.value,
  };

  // The fields of a status exist exactly in that status.
  const only = (field: string, allowed: BuildingStatus): ParseResult<null> =>
    value[field] !== undefined && status.value !== allowed
      ? fail(
          `${path}.${field}`,
          `only a ${allowed} building has ${field}, not a ${status.value} one`,
        )
      : ok(null);
  for (const [field, allowed] of [
    ["fireIntensity", "burning"],
    ["ticksBurning", "burning"],
    ["ignition", "burning"],
    ["repairProgress", "repairing"],
  ] as const) {
    const checked = only(field, allowed);
    if (!checked.ok) return checked;
  }

  switch (status.value) {
    case "burning": {
      const fireIntensity = parseNonNegativeNumber(
        value.fireIntensity,
        `${path}.fireIntensity`,
      );
      if (!fireIntensity.ok) return fireIntensity;
      const ticksBurning = parseNonNegativeInteger(
        value.ticksBurning,
        `${path}.ticksBurning`,
      );
      if (!ticksBurning.ok) return ticksBurning;
      const ignition = parseIgnition(value.ignition, `${path}.ignition`);
      if (!ignition.ok) return ignition;
      return ok({
        ...base,
        status: "burning",
        fireIntensity: fireIntensity.value,
        ticksBurning: ticksBurning.value,
        ignition: ignition.value,
      });
    }
    case "repairing": {
      const repairProgress = parseNonNegativeNumber(
        value.repairProgress,
        `${path}.repairProgress`,
      );
      if (!repairProgress.ok) return repairProgress;
      return ok({
        ...base,
        status: "repairing",
        repairProgress: repairProgress.value,
      });
    }
    case "operational":
    case "damaged":
    case "destroyed":
      return ok({ ...base, status: status.value });
  }
}

function parseIgnition(
  value: unknown,
  path: string,
): ParseResult<BuildingIgnition> {
  if (!isRecord(value)) return fail(path, "expected an ignition object");
  const eventId = parseEventId(value.eventId, `${path}.eventId`);
  if (!eventId.ok) return eventId;
  const actor =
    value.actor === undefined
      ? ok<EntityId | undefined>(undefined)
      : parseEntityId(value.actor, `${path}.actor`);
  if (!actor.ok) return actor;
  return ok({
    eventId: eventId.value,
    ...(actor.value === undefined ? {} : { actor: actor.value }),
  });
}

function parseBuildingEntry(
  value: unknown,
  path: string,
  knownLocationIds: ReadonlySet<EntityId>,
  knownActorIds: ReadonlySet<EntityId>,
): ParseResult<readonly [EntityId, BuildingState]> {
  if (!Array.isArray(value) || value.length !== 2) {
    return fail(path, "expected a [id, building] entry");
  }
  const id = parseEntityId(value[0], `${path}[0]`);
  if (!id.ok) return id;
  const state = parseBuildingState(
    value[1],
    `${path}[1]`,
    knownLocationIds,
    knownActorIds,
  );
  if (!state.ok) return state;
  if (id.value !== state.value.id) {
    return fail(
      `${path}[0]`,
      `entry key "${id.value}" does not match its own id field "${state.value.id}"`,
    );
  }
  return ok([id.value, state.value] as const);
}

/** Fails if `entries` contains the same key twice -- `new Map` would otherwise silently keep only the last one. */
function findDuplicateKey<K, T>(
  entries: readonly (readonly [K, T])[],
): K | undefined {
  const seen = new Set<K>();
  for (const [key] of entries) {
    if (seen.has(key)) {
      return key;
    }
    seen.add(key);
  }
  return undefined;
}

function parseWorldRules(
  value: unknown,
  path: string,
): ParseResult<WorldState["rules"]> {
  if (!isRecord(value)) return fail(path, "expected a rules object");
  const catchUpCapMs = parseNonNegativeInteger(
    value.catchUpCapMs,
    `${path}.catchUpCapMs`,
  );
  if (!catchUpCapMs.ok) return catchUpCapMs;
  const catchUpChunkMs = parseNonNegativeInteger(
    value.catchUpChunkMs,
    `${path}.catchUpChunkMs`,
  );
  if (!catchUpChunkMs.ok) return catchUpChunkMs;
  const checkpointIntervalMs = parseNonNegativeInteger(
    value.checkpointIntervalMs,
    `${path}.checkpointIntervalMs`,
  );
  if (!checkpointIntervalMs.ok) return checkpointIntervalMs;
  const maxProposalsPerTick = parseNonNegativeInteger(
    value.maxProposalsPerTick,
    `${path}.maxProposalsPerTick`,
  );
  if (!maxProposalsPerTick.ok) return maxProposalsPerTick;
  const fireBalance = parseNumberRecord(
    value.fireBalance,
    `${path}.fireBalance`,
  );
  if (!fireBalance.ok) return fireBalance;
  const economyBalance = parseNumberRecord(
    value.economyBalance,
    `${path}.economyBalance`,
  );
  if (!economyBalance.ok) return economyBalance;
  const memoryBalance =
    value.memoryBalance === undefined
      ? ok<Readonly<Record<string, number>> | undefined>(undefined)
      : parseMemoryBalance(value.memoryBalance, `${path}.memoryBalance`);
  if (!memoryBalance.ok) return memoryBalance;
  const petitionBalance =
    value.petitionBalance === undefined
      ? ok<Readonly<Record<string, number>> | undefined>(undefined)
      : parsePetitionBalance(value.petitionBalance, `${path}.petitionBalance`);
  if (!petitionBalance.ok) return petitionBalance;
  return ok({
    catchUpCapMs: catchUpCapMs.value,
    catchUpChunkMs: catchUpChunkMs.value,
    checkpointIntervalMs: checkpointIntervalMs.value,
    maxProposalsPerTick: maxProposalsPerTick.value,
    fireBalance: fireBalance.value,
    economyBalance: economyBalance.value,
    ...(memoryBalance.value === undefined
      ? {}
      : { memoryBalance: memoryBalance.value }),
    ...(petitionBalance.value === undefined
      ? {}
      : { petitionBalance: petitionBalance.value }),
  });
}

function parseLegendRecord(
  value: unknown,
  path: string,
): ParseResult<LegendRecord> {
  if (!isRecord(value)) return fail(path, "expected a legend record object");
  const id = parseLegendId(value.id, `${path}.id`);
  if (!id.ok) return id;
  const narrator = parseEntityId(value.narrator, `${path}.narrator`);
  if (!narrator.ok) return narrator;
  const assertion = parseString(value.assertion, `${path}.assertion`);
  if (!assertion.ok) return assertion;
  const linkedEventIdRaw = parseOptionalString(
    value.linkedEventId,
    `${path}.linkedEventId`,
  );
  if (!linkedEventIdRaw.ok) return linkedEventIdRaw;
  return ok({
    id: id.value,
    narrator: narrator.value,
    assertion: assertion.value,
    ...(linkedEventIdRaw.value === undefined
      ? {}
      : { linkedEventId: linkedEventIdRaw.value as EventId }),
  });
}

function parseLegendEntry(
  value: unknown,
  path: string,
): ParseResult<readonly [LegendId, LegendRecord]> {
  if (!Array.isArray(value) || value.length !== 2) {
    return fail(path, "expected a [id, legend] entry");
  }
  const id = parseLegendId(value[0], `${path}[0]`);
  if (!id.ok) return id;
  const record = parseLegendRecord(value[1], `${path}[1]`);
  if (!record.ok) return record;
  if (id.value !== record.value.id) {
    return fail(
      `${path}[0]`,
      `entry key "${id.value}" does not match its own id field "${record.value.id}"`,
    );
  }
  return ok([id.value, record.value] as const);
}

function parseMemoryEntry(
  value: unknown,
  path: string,
): ParseResult<MemoryEntry> {
  if (!isRecord(value)) return fail(path, "expected a memory entry object");
  const id = parseEventId(value.id, `${path}.id`);
  if (!id.ok) return id;
  const sourceEventId = parseEventId(
    value.sourceEventId,
    `${path}.sourceEventId`,
  );
  if (!sourceEventId.ok) return sourceEventId;
  const salience = parseSalience(value.salience, `${path}.salience`);
  if (!salience.ok) return salience;
  const recordedAt = parseNonNegativeInteger(
    value.recordedAt,
    `${path}.recordedAt`,
  );
  if (!recordedAt.ok) return recordedAt;
  const subjects = parseArray(
    value.subjects,
    `${path}.subjects`,
    parseEntityId,
  );
  if (!subjects.ok) return subjects;
  const consequence = parseConsequence(
    value.consequence,
    `${path}.consequence`,
  );
  if (!consequence.ok) return consequence;
  const base = {
    id: id.value,
    sourceEventId: sourceEventId.value,
    salience: salience.value,
    recordedAt: recordedAt.value,
    subjects: subjects.value,
    ...(consequence.value === undefined
      ? {}
      : { consequence: consequence.value }),
  };

  switch (value.kind) {
    case "witnessed": {
      const eventKind = parseEnum(
        value.eventKind,
        `${path}.eventKind`,
        WITNESSED_EVENT_KINDS,
      );
      if (!eventKind.ok) return eventKind;
      return ok({ ...base, kind: "witnessed", eventKind: eventKind.value });
    }
    case "told": {
      const teller = parseEntityId(value.teller, `${path}.teller`);
      if (!teller.ok) return teller;
      const content = parseReportContent(value.content, `${path}.content`);
      if (!content.ok) return content;
      const linkedEventIdRaw = parseOptionalString(
        value.linkedEventId,
        `${path}.linkedEventId`,
      );
      if (!linkedEventIdRaw.ok) return linkedEventIdRaw;
      return ok({
        ...base,
        kind: "told",
        teller: teller.value,
        content: content.value,
        ...(linkedEventIdRaw.value === undefined
          ? {}
          : { linkedEventId: linkedEventIdRaw.value as EventId }),
      });
    }
    case "sign": {
      const god = parseEntityId(value.god, `${path}.god`);
      if (!god.ok) return god;
      const outcome = parseEnum(value.outcome, `${path}.outcome`, [
        "answered",
        "lapsed",
      ] as const);
      if (!outcome.ok) return outcome;
      const petitionId = parseEventId(value.petitionId, `${path}.petitionId`);
      if (!petitionId.ok) return petitionId;
      return ok({
        ...base,
        kind: "sign",
        god: god.value,
        outcome: outcome.value,
        petitionId: petitionId.value,
      });
    }
    default:
      return fail(`${path}.kind`, "expected a witnessed, told, or sign memory");
  }
}

function parseMemoryEntries(
  value: unknown,
  path: string,
  knownActorIds: ReadonlySet<EntityId>,
): ParseResult<readonly [EntityId, readonly MemoryEntry[]]> {
  if (!Array.isArray(value) || value.length !== 2) {
    return fail(path, "expected an [actor, memories] entry");
  }
  const owner = parseEntityId(value[0], `${path}[0]`);
  if (!owner.ok) return owner;
  if (!knownActorIds.has(owner.value)) {
    return fail(
      `${path}[0]`,
      `memories belong to unknown actor: ${owner.value}`,
    );
  }
  const entries = parseArray(value[1], `${path}[1]`, parseMemoryEntry);
  if (!entries.ok) return entries;
  return ok([owner.value, entries.value] as const);
}

function parseGoalEntry(
  value: unknown,
  path: string,
  knownActorIds: ReadonlySet<EntityId>,
): ParseResult<readonly [EntityId, ActiveGoal]> {
  if (!Array.isArray(value) || value.length !== 2) {
    return fail(path, "expected an [actor, goal] entry");
  }
  const owner = parseEntityId(value[0], `${path}[0]`);
  if (!owner.ok) return owner;
  if (!knownActorIds.has(owner.value)) {
    return fail(`${path}[0]`, `goal belongs to unknown actor: ${owner.value}`);
  }
  const record = value[1];
  if (!isRecord(record)) return fail(`${path}[1]`, "expected a goal");
  const text = parseGoalText(record.text, `${path}[1].text`);
  if (!text.ok) return text;
  const target = parseEntityId(record.target, `${path}[1].target`);
  if (!target.ok) return target;
  const eventId = parseEventId(record.eventId, `${path}[1].eventId`);
  if (!eventId.ok) return eventId;
  const sequence = parseNonNegativeInteger(
    record.sequence,
    `${path}[1].sequence`,
  );
  if (!sequence.ok) return sequence;
  return ok([
    owner.value,
    {
      text: text.value,
      target: target.value,
      eventId: eventId.value,
      sequence: sequence.value,
    },
  ] as const);
}

const CAUSE_KINDS = [
  "damage",
  "fire",
  "theft",
  "spoilage",
  "need",
  "grudge",
] as const;

function parseCauseEntry(
  value: unknown,
  path: string,
  knownActorIds: ReadonlySet<EntityId>,
): ParseResult<readonly [EntityId, readonly PetitionCause[]]> {
  if (!Array.isArray(value) || value.length !== 2) {
    return fail(path, "expected an [actor, causes] entry");
  }
  const owner = parseEntityId(value[0], `${path}[0]`);
  if (!owner.ok) return owner;
  if (!knownActorIds.has(owner.value)) {
    return fail(`${path}[0]`, `causes belong to unknown actor: ${owner.value}`);
  }
  const causes = parseArray(value[1], `${path}[1]`, (item, at) => {
    if (!isRecord(item)) return fail(at, "expected a cause");
    const eventId = parseEventId(item.eventId, `${at}.eventId`);
    if (!eventId.ok) return eventId;
    const tick = parseNonNegativeInteger(item.tick, `${at}.tick`);
    if (!tick.ok) return tick;
    const kind = parseEnum(item.kind, `${at}.kind`, CAUSE_KINDS);
    if (!kind.ok) return kind;
    const offender =
      item.offender === undefined
        ? ok<EntityId | undefined>(undefined)
        : parseEntityId(item.offender, `${at}.offender`);
    if (!offender.ok) return offender;
    const building =
      item.building === undefined
        ? ok<EntityId | undefined>(undefined)
        : parseEntityId(item.building, `${at}.building`);
    if (!building.ok) return building;
    const resource = parseOptionalString(item.resource, `${at}.resource`);
    if (!resource.ok) return resource;
    return ok({
      eventId: eventId.value,
      tick: tick.value,
      kind: kind.value,
      ...(offender.value === undefined ? {} : { offender: offender.value }),
      ...(building.value === undefined ? {} : { building: building.value }),
      ...(resource.value === undefined ? {} : { resource: resource.value }),
    });
  });
  if (!causes.ok) return causes;
  return ok([owner.value, causes.value] as const);
}

function parsePetitionEntry(
  value: unknown,
  path: string,
  knownActorIds: ReadonlySet<EntityId>,
): ParseResult<readonly [EventId, Petition]> {
  if (!Array.isArray(value) || value.length !== 2) {
    return fail(path, "expected an [id, petition] entry");
  }
  const key = parseEventId(value[0], `${path}[0]`);
  if (!key.ok) return key;
  const record = value[1];
  if (!isRecord(record)) return fail(`${path}[1]`, "expected a petition");
  const id = parseEventId(record.id, `${path}[1].id`);
  if (!id.ok) return id;
  if (id.value !== key.value) {
    return fail(
      `${path}[0]`,
      `entry key "${key.value}" does not match its own id`,
    );
  }
  const petitioner = parseEntityId(record.petitioner, `${path}[1].petitioner`);
  if (!petitioner.ok) return petitioner;
  const god = parseEntityId(record.god, `${path}[1].god`);
  if (!god.ok) return god;
  for (const actor of [petitioner.value, god.value]) {
    if (!knownActorIds.has(actor)) {
      return fail(`${path}[1]`, `petition names unknown actor: ${actor}`);
    }
  }
  const cause = parseEventId(record.cause, `${path}[1].cause`);
  if (!cause.ok) return cause;
  const request = parsePetitionRequest(record.request, `${path}[1].request`);
  if (!request.ok) return request;
  const tick = parseNonNegativeInteger(record.tick, `${path}[1].tick`);
  if (!tick.ok) return tick;
  const status = parseEnum(record.status, `${path}[1].status`, [
    "open",
    "answered",
    "lapsed",
  ] as const);
  if (!status.ok) return status;
  return ok([
    key.value,
    {
      id: id.value,
      petitioner: petitioner.value,
      god: god.value,
      cause: cause.value,
      request: request.value,
      tick: tick.value,
      status: status.value,
    },
  ] as const);
}

function parseNeedEntry(
  value: unknown,
  path: string,
  knownActorIds: ReadonlySet<EntityId>,
): ParseResult<readonly [string, OpenNeed]> {
  if (!Array.isArray(value) || value.length !== 2) {
    return fail(path, "expected a [key, need] entry");
  }
  const key = parseString(value[0], `${path}[0]`);
  if (!key.ok) return key;
  const record = value[1];
  if (!isRecord(record)) return fail(`${path}[1]`, "expected a need");
  const actor = parseEntityId(record.actor, `${path}[1].actor`);
  if (!actor.ok) return actor;
  if (!knownActorIds.has(actor.value)) {
    return fail(`${path}[1]`, `need belongs to unknown actor: ${actor.value}`);
  }
  const resource = parseString(record.resource, `${path}[1].resource`);
  if (!resource.ok) return resource;
  if (key.value !== needKey(actor.value, resource.value)) {
    return fail(
      `${path}[0]`,
      `entry key "${key.value}" does not match its own need`,
    );
  }
  const reason = parseEnum(
    record.reason,
    `${path}[1].reason`,
    UNMET_NEED_REASONS,
  );
  if (!reason.ok) return reason;
  const eventId = parseEventId(record.eventId, `${path}[1].eventId`);
  if (!eventId.ok) return eventId;
  const tick = parseNonNegativeInteger(record.tick, `${path}[1].tick`);
  if (!tick.ok) return tick;
  return ok([
    key.value,
    {
      actor: actor.value,
      resource: resource.value,
      reason: reason.value,
      eventId: eventId.value,
      tick: tick.value,
    },
  ] as const);
}

function parseRelationshipEntry(
  value: unknown,
  path: string,
  knownActorIds: ReadonlySet<EntityId>,
): ParseResult<readonly [string, RelationshipState]> {
  if (!Array.isArray(value) || value.length !== 2) {
    return fail(path, "expected a [key, relationship] entry");
  }
  const key = parseString(value[0], `${path}[0]`);
  if (!key.ok) return key;
  const record = value[1];
  if (!isRecord(record)) return fail(`${path}[1]`, "expected a relationship");
  const from = parseEntityId(record.from, `${path}[1].from`);
  if (!from.ok) return from;
  const toward = parseEntityId(record.toward, `${path}[1].toward`);
  if (!toward.ok) return toward;
  for (const actor of [from.value, toward.value]) {
    if (!knownActorIds.has(actor)) {
      return fail(
        `${path}[1]`,
        `relationship references unknown actor: ${actor}`,
      );
    }
  }
  if (key.value !== relationshipKey(from.value, toward.value)) {
    return fail(
      `${path}[0]`,
      `entry key "${key.value}" does not match its own actors`,
    );
  }
  const affinity = record.affinity;
  if (typeof affinity !== "number" || !Number.isInteger(affinity)) {
    return fail(`${path}[1].affinity`, "expected an integer");
  }
  const grudge = parseNonNegativeInteger(record.grudge, `${path}[1].grudge`);
  if (!grudge.ok) return grudge;
  const allied = parseBoolean(record.allied, `${path}[1].allied`);
  if (!allied.ok) return allied;
  return ok([
    key.value,
    {
      from: from.value,
      toward: toward.value,
      affinity,
      grudge: grudge.value,
      allied: allied.value,
    },
  ] as const);
}

function parseNumberRecord(
  value: unknown,
  path: string,
): ParseResult<Readonly<Record<string, number>>> {
  if (!isRecord(value)) return fail(path, "expected a numeric record");
  const record: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      return fail(`${path}.${key}`, "expected a finite number");
    }
    record[key] = entry;
  }
  return ok(record);
}

function parseEncodedWorldState(value: unknown): ParseResult<WorldState> {
  if (!isRecord(value)) {
    return fail("", "expected a world state object");
  }
  const tick = parseNonNegativeInteger(value.tick, "tick");
  if (!tick.ok) return tick;
  const simTime = parseNonNegativeNumber(value.simTime, "simTime");
  if (!simTime.ok) return simTime;
  const lastSequence = parseNonNegativeInteger(
    value.lastSequence,
    "lastSequence",
  );
  if (!lastSequence.ok) return lastSequence;

  const locationEntries = parseArray(
    value.locations,
    "locations",
    parseLocationEntry,
  );
  if (!locationEntries.ok) return locationEntries;
  const duplicateLocationKey = findDuplicateKey(locationEntries.value);
  if (duplicateLocationKey !== undefined) {
    return fail("locations", `duplicate location id: ${duplicateLocationKey}`);
  }
  const locations = new Map(locationEntries.value);

  const knownLocationIds = new Set(locations.keys());
  for (const [index, [, location]] of locationEntries.value.entries()) {
    for (const [edgeIndex, edge] of location.edges.entries()) {
      if (!knownLocationIds.has(edge.to as EntityId)) {
        return fail(
          `locations[${index}].edges[${edgeIndex}].to`,
          `edge targets unknown location: ${edge.to}`,
        );
      }
    }
  }

  const actorEntries = parseArray(value.actors, "actors", (item, path) =>
    parseActorEntry(item, path, knownLocationIds),
  );
  if (!actorEntries.ok) return actorEntries;
  const duplicateActorKey = findDuplicateKey(actorEntries.value);
  if (duplicateActorKey !== undefined) {
    return fail("actors", `duplicate actor id: ${duplicateActorKey}`);
  }
  const actors = new Map(actorEntries.value);
  const knownActorIds = new Set(actors.keys());

  const buildingEntries = parseArray(
    value.buildings,
    "buildings",
    (item, path) =>
      parseBuildingEntry(item, path, knownLocationIds, knownActorIds),
  );
  if (!buildingEntries.ok) return buildingEntries;
  const duplicateBuildingKey = findDuplicateKey(buildingEntries.value);
  if (duplicateBuildingKey !== undefined) {
    return fail("buildings", `duplicate building id: ${duplicateBuildingKey}`);
  }
  const buildings = new Map(buildingEntries.value);

  const legendEntries = parseArray(value.legends, "legends", parseLegendEntry);
  if (!legendEntries.ok) return legendEntries;
  const duplicateLegendKey = findDuplicateKey(legendEntries.value);
  if (duplicateLegendKey !== undefined) {
    return fail("legends", `duplicate legend id: ${duplicateLegendKey}`);
  }
  const legends = new Map(legendEntries.value);

  const memoryEntries = parseArray(value.memories, "memories", (item, path) =>
    parseMemoryEntries(item, path, knownActorIds),
  );
  if (!memoryEntries.ok) return memoryEntries;
  const duplicateMemoryOwner = findDuplicateKey(memoryEntries.value);
  if (duplicateMemoryOwner !== undefined) {
    return fail("memories", `duplicate memory owner: ${duplicateMemoryOwner}`);
  }
  const memories = new Map(memoryEntries.value);

  const relationshipEntries = parseArray(
    value.relationships,
    "relationships",
    (item, path) => parseRelationshipEntry(item, path, knownActorIds),
  );
  if (!relationshipEntries.ok) return relationshipEntries;
  const duplicateRelationship = findDuplicateKey(relationshipEntries.value);
  if (duplicateRelationship !== undefined) {
    return fail(
      "relationships",
      `duplicate relationship: ${duplicateRelationship}`,
    );
  }
  const relationships = new Map(relationshipEntries.value);

  const goalEntries = parseArray(value.goals, "goals", (item, path) =>
    parseGoalEntry(item, path, knownActorIds),
  );
  if (!goalEntries.ok) return goalEntries;
  const duplicateGoalOwner = findDuplicateKey(goalEntries.value);
  if (duplicateGoalOwner !== undefined) {
    return fail("goals", `duplicate goal owner: ${duplicateGoalOwner}`);
  }
  const goals = new Map(goalEntries.value);

  const needEntries = parseArray(value.needs, "needs", (item, path) =>
    parseNeedEntry(item, path, knownActorIds),
  );
  if (!needEntries.ok) return needEntries;
  const duplicateNeed = findDuplicateKey(needEntries.value);
  if (duplicateNeed !== undefined) {
    return fail("needs", `duplicate need: ${duplicateNeed}`);
  }
  const needs = new Map(needEntries.value);

  const causeEntries = parseArray(value.causes, "causes", (item, path) =>
    parseCauseEntry(item, path, knownActorIds),
  );
  if (!causeEntries.ok) return causeEntries;
  const duplicateCauseOwner = findDuplicateKey(causeEntries.value);
  if (duplicateCauseOwner !== undefined) {
    return fail("causes", `duplicate cause owner: ${duplicateCauseOwner}`);
  }
  const causes = new Map(causeEntries.value);

  const petitionEntries = parseArray(
    value.petitions,
    "petitions",
    (item, path) => parsePetitionEntry(item, path, knownActorIds),
  );
  if (!petitionEntries.ok) return petitionEntries;
  const duplicatePetition = findDuplicateKey(petitionEntries.value);
  if (duplicatePetition !== undefined) {
    return fail("petitions", `duplicate petition: ${duplicatePetition}`);
  }
  const petitions = new Map(petitionEntries.value);

  const grantEntries = parseArray(
    value.repairGrants,
    "repairGrants",
    (item, path) => {
      if (!Array.isArray(item) || item.length !== 2) {
        return fail(path, "expected a [recipient, building] entry");
      }
      const recipient = parseEntityId(item[0], `${path}[0]`);
      if (!recipient.ok) return recipient;
      if (!knownActorIds.has(recipient.value)) {
        return fail(`${path}[0]`, `grant to unknown actor: ${recipient.value}`);
      }
      const building = parseEntityId(item[1], `${path}[1]`);
      if (!building.ok) return building;
      if (!buildings.has(building.value)) {
        return fail(
          `${path}[1]`,
          `grant names unknown building: ${building.value}`,
        );
      }
      return ok([recipient.value, building.value] as const);
    },
  );
  if (!grantEntries.ok) return grantEntries;
  const repairGrants = new Map(grantEntries.value);

  const rules = parseWorldRules(value.rules, "rules");
  if (!rules.ok) return rules;

  // Only events forget and only events feel, so a stored world holds what its
  // own rules allow: no actor remembers more than the capacity, and no
  // relationship is beyond its limits.
  const capacity = memoryBalanceOf(rules.value, "capacity");
  for (const [owner, list] of memories) {
    if (list.length > capacity) {
      return fail(
        "memories",
        `${owner} holds ${list.length} memories, over the world's capacity of ${capacity}`,
      );
    }
  }
  const affinityLimit = memoryBalanceOf(rules.value, "affinityLimit");
  const grudgeLimit = memoryBalanceOf(rules.value, "grudgeLimit");
  for (const [key, relationship] of relationships) {
    if (Math.abs(relationship.affinity) > affinityLimit) {
      return fail(
        "relationships",
        `${key} has affinity ${relationship.affinity}, beyond the world's limit of ${affinityLimit}`,
      );
    }
    if (relationship.grudge > grudgeLimit) {
      return fail(
        "relationships",
        `${key} has grudge ${relationship.grudge}, beyond the world's limit of ${grudgeLimit}`,
      );
    }
  }

  const recipes = parseRecipes(value.recipes, "recipes");
  if (!recipes.ok) return recipes;

  return ok({
    tick: tick.value,
    simTime: simTime.value,
    lastSequence: lastSequence.value,
    locations,
    actors,
    buildings,
    legends,
    memories,
    relationships,
    goals,
    needs,
    causes,
    petitions,
    repairGrants,
    rules: rules.value,
    recipes: recipes.value,
  });
}

/**
 * Decodes a value out of storage back into a live `WorldState`. Parses
 * rather than casts: `value` is untrusted (persistence's own JSON column,
 * or an imported archive's), so every field, entry shape, and cross-entity
 * reference (an actor's or building's `locationId`, a building's `owner`, a
 * location's `realm`) is checked. Throws `WorldStateDecodeError` on the
 * first failure, matching `ProjectionCodec.decode`'s throw-on-failure
 * contract.
 */
export function decode(value: unknown): WorldState {
  const parsed = parseEncodedWorldState(value);
  if (!parsed.ok) {
    throw new WorldStateDecodeError(parsed.path, parsed.reason, parsed.message);
  }
  return parsed.value;
}
