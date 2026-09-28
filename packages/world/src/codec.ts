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
// is -- shape, field types, and referential integrity (an actor's
// `locationId` must name a location that actually exists; a location's
// `realm` must be a known realm).

import {
  type EntityId,
  fail,
  isRecord,
  type LocationEdge,
  ok,
  type ParseResult,
  parseArray,
  parseBoolean,
  parseEntityId,
  parseEnum,
  parseNonNegativeInteger,
  parseNonNegativeNumber,
  parseOptionalString,
  parseString,
  REALMS,
  type RejectionReasonCode,
  TRANSPORT_KINDS,
} from "@panthea/contracts";
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
  const capabilities = parseArray(
    value.capabilities,
    `${path}.capabilities`,
    parseString,
  );
  if (!capabilities.ok) return capabilities;
  const revision = parseNonNegativeInteger(value.revision, `${path}.revision`);
  if (!revision.ok) return revision;
  return ok({
    id: id.value,
    locationId: locationId.value,
    alive: alive.value,
    capabilities: capabilities.value,
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

/** Fails if `entries` contains the same key twice -- `new Map` would otherwise silently keep only the last one. */
function findDuplicateKey<T>(
  entries: readonly (readonly [EntityId, T])[],
): EntityId | undefined {
  const seen = new Set<EntityId>();
  for (const [key] of entries) {
    if (seen.has(key)) {
      return key;
    }
    seen.add(key);
  }
  return undefined;
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
  const actorEntries = parseArray(value.actors, "actors", (item, path) =>
    parseActorEntry(item, path, knownLocationIds),
  );
  if (!actorEntries.ok) return actorEntries;
  const duplicateActorKey = findDuplicateKey(actorEntries.value);
  if (duplicateActorKey !== undefined) {
    return fail("actors", `duplicate actor id: ${duplicateActorKey}`);
  }
  const actors = new Map(actorEntries.value);

  return ok({
    tick: tick.value,
    simTime: simTime.value,
    lastSequence: lastSequence.value,
    locations,
    actors,
  });
}

/**
 * Decodes a value out of storage back into a live `WorldState`. Parses
 * rather than casts: `value` is untrusted (persistence's own JSON column,
 * or an imported archive's), so every field, entry shape, and cross-entity
 * reference (an actor's `locationId`, a location's `realm`) is checked.
 * Throws `WorldStateDecodeError` on the first failure, matching
 * `ProjectionCodec.decode`'s throw-on-failure contract.
 */
export function decode(value: unknown): WorldState {
  const parsed = parseEncodedWorldState(value);
  if (!parsed.ok) {
    throw new WorldStateDecodeError(parsed.path, parsed.reason, parsed.message);
  }
  return parsed.value;
}
