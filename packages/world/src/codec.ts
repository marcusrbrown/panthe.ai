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
  parseEntityId,
  parseEnum,
  parseLegendId,
  parseNonNegativeInteger,
  parseNonNegativeNumber,
  parseOptionalBoolean,
  parseOptionalString,
  parseRecipes,
  parseString,
  REALMS,
  type RejectionReasonCode,
  TRANSPORT_KINDS,
} from "@panthea/contracts";
import {
  type ActorState,
  BUILDING_STATUSES,
  type BuildingState,
  type FavorState,
  type LegendRecord,
  type LocationState,
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
  const fireIntensity = parseOptionalNonNegativeNumber(
    value.fireIntensity,
    `${path}.fireIntensity`,
  );
  if (!fireIntensity.ok) return fireIntensity;
  const ticksBurning = parseOptionalNonNegativeInteger(
    value.ticksBurning,
    `${path}.ticksBurning`,
  );
  if (!ticksBurning.ok) return ticksBurning;
  const repairProgress = parseOptionalNonNegativeNumber(
    value.repairProgress,
    `${path}.repairProgress`,
  );
  if (!repairProgress.ok) return repairProgress;
  const revision = parseNonNegativeInteger(value.revision, `${path}.revision`);
  if (!revision.ok) return revision;
  return ok({
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
    status: status.value,
    ...(fireIntensity.value === undefined
      ? {}
      : { fireIntensity: fireIntensity.value }),
    ...(ticksBurning.value === undefined
      ? {}
      : { ticksBurning: ticksBurning.value }),
    ...(repairProgress.value === undefined
      ? {}
      : { repairProgress: repairProgress.value }),
    revision: revision.value,
  });
}

function parseOptionalNonNegativeNumber(
  value: unknown,
  path: string,
): ParseResult<number | undefined> {
  if (value === undefined) return ok(undefined);
  return parseNonNegativeNumber(value, path);
}

function parseOptionalNonNegativeInteger(
  value: unknown,
  path: string,
): ParseResult<number | undefined> {
  if (value === undefined) return ok(undefined);
  return parseNonNegativeInteger(value, path);
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
  return ok({
    catchUpCapMs: catchUpCapMs.value,
    catchUpChunkMs: catchUpChunkMs.value,
    checkpointIntervalMs: checkpointIntervalMs.value,
    maxProposalsPerTick: maxProposalsPerTick.value,
    fireBalance: fireBalance.value,
    economyBalance: economyBalance.value,
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

  const rules = parseWorldRules(value.rules, "rules");
  if (!rules.ok) return rules;

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
