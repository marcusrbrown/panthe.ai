// Committed world events: the append-only source of truth per Key Technical
// Decisions ("append-only event log is the source of truth; projection
// tables are updated in the same transaction and are rebuildable from the
// log"). Every event carries its own schema version, independent of the
// SQLite user_version (packages/persistence's concern) and independent of
// proposal schema versions. An upcaster registry decodes any prior payload
// version to the latest form before structural parsing, so packages/world
// only ever consumes latest-form events.

import {
  type CausationId,
  type CorrelationId,
  type EntityId,
  type EventId,
  fail,
  isRecord,
  ok,
  type ParseResult,
  parseBoolean,
  parseCausationId,
  parseCorrelationId,
  parseEntityId,
  parseEventId,
  parseFiniteNumber,
  parseNonNegativeInteger,
} from "./ids";

export interface EventEnvelope {
  readonly schemaVersion: number;
  readonly id: EventId;
  readonly sequence: number;
  readonly simTime: number;
  readonly correlationId: CorrelationId;
  readonly causationId: CausationId;
  readonly approximate: boolean;
}

export interface EntityMovedEvent extends EventEnvelope {
  readonly kind: "entity-moved";
  readonly entityId: EntityId;
  readonly to: EntityId;
}

export interface RealmTransitionedEvent extends EventEnvelope {
  readonly kind: "realm-transitioned";
  readonly entityId: EntityId;
  readonly to: EntityId;
  readonly via: EntityId;
}

export type WorldEvent = EntityMovedEvent | RealmTransitionedEvent;

export const LATEST_EVENT_SCHEMA_VERSION = 2;

type RawEvent = Record<string, unknown>;
type Upcaster = (raw: RawEvent) => RawEvent;

/**
 * v1 "entity-moved" events used the field name `entity`; v2 renamed it to
 * `entityId` for consistency with every other event kind. A lossless
 * rename, seeded here per the plan's "at minimum the pipeline + test."
 */
const upcasters = new Map<number, Upcaster>([
  [
    1,
    (raw) => {
      if (raw.kind !== "entity-moved") {
        return { ...raw, schemaVersion: 2 };
      }
      const { entity, ...rest } = raw;
      return { ...rest, entityId: entity, schemaVersion: 2 };
    },
  ],
]);

function upcastToLatest(raw: RawEvent): ParseResult<RawEvent> {
  let current = raw;
  const seen = new Set<number>();
  for (;;) {
    const version = current.schemaVersion;
    if (typeof version !== "number" || !Number.isInteger(version)) {
      return fail("schemaVersion", "expected an integer schema version");
    }
    if (version === LATEST_EVENT_SCHEMA_VERSION) {
      return ok(current);
    }
    if (seen.has(version)) {
      return fail(
        "schemaVersion",
        "upcast cycle detected",
        "unsupported-version",
      );
    }
    seen.add(version);
    const upcast = upcasters.get(version);
    if (!upcast) {
      return fail(
        "schemaVersion",
        `unsupported schema version: ${version}`,
        "unsupported-version",
      );
    }
    current = upcast(current);
  }
}

export function parseEvent(input: unknown): ParseResult<WorldEvent> {
  if (!isRecord(input)) {
    return fail("", "expected an event object");
  }

  const upcasted = upcastToLatest(input);
  if (!upcasted.ok) return upcasted;
  const raw = upcasted.value;

  const id = parseEventId(raw.id, "id");
  if (!id.ok) return id;
  const sequence = parseNonNegativeInteger(raw.sequence, "sequence");
  if (!sequence.ok) return sequence;
  const simTime = parseFiniteNumber(raw.simTime, "simTime");
  if (!simTime.ok) return simTime;
  const correlationId = parseCorrelationId(raw.correlationId, "correlationId");
  if (!correlationId.ok) return correlationId;
  const causationId = parseCausationId(raw.causationId, "causationId");
  if (!causationId.ok) return causationId;
  const approximate = parseBoolean(raw.approximate, "approximate");
  if (!approximate.ok) return approximate;

  const envelope: EventEnvelope = {
    schemaVersion: LATEST_EVENT_SCHEMA_VERSION,
    id: id.value,
    sequence: sequence.value,
    simTime: simTime.value,
    correlationId: correlationId.value,
    causationId: causationId.value,
    approximate: approximate.value,
  };

  switch (raw.kind) {
    case "entity-moved": {
      const entityId = parseEntityId(raw.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const to = parseEntityId(raw.to, "to");
      if (!to.ok) return to;
      return ok({
        ...envelope,
        kind: "entity-moved",
        entityId: entityId.value,
        to: to.value,
      });
    }
    case "realm-transitioned": {
      const entityId = parseEntityId(raw.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const to = parseEntityId(raw.to, "to");
      if (!to.ok) return to;
      const via = parseEntityId(raw.via, "via");
      if (!via.ok) return via;
      return ok({
        ...envelope,
        kind: "realm-transitioned",
        entityId: entityId.value,
        to: to.value,
        via: via.value,
      });
    }
    default:
      return fail(
        "kind",
        `unknown event kind: ${String(raw.kind)}`,
        "unknown-kind",
      );
  }
}
