// Committed world events: the append-only source of truth. Every event
// carries its own schema version, independent of the SQLite schema and
// independent of proposal schema versions.

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
  parseSchemaVersion,
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

export const LATEST_EVENT_SCHEMA_VERSION = 1;
const EVENT_SCHEMA_VERSIONS = [LATEST_EVENT_SCHEMA_VERSION] as const;

export function parseEvent(input: unknown): ParseResult<WorldEvent> {
  if (!isRecord(input)) {
    return fail("", "expected an event object");
  }

  const schemaVersion = parseSchemaVersion(
    input.schemaVersion,
    EVENT_SCHEMA_VERSIONS,
  );
  if (!schemaVersion.ok) return schemaVersion;

  const id = parseEventId(input.id, "id");
  if (!id.ok) return id;
  const sequence = parseNonNegativeInteger(input.sequence, "sequence");
  if (!sequence.ok) return sequence;
  const simTime = parseFiniteNumber(input.simTime, "simTime");
  if (!simTime.ok) return simTime;
  const correlationId = parseCorrelationId(
    input.correlationId,
    "correlationId",
  );
  if (!correlationId.ok) return correlationId;
  const causationId = parseCausationId(input.causationId, "causationId");
  if (!causationId.ok) return causationId;
  const approximate = parseBoolean(input.approximate, "approximate");
  if (!approximate.ok) return approximate;

  const envelope: EventEnvelope = {
    schemaVersion: schemaVersion.value,
    id: id.value,
    sequence: sequence.value,
    simTime: simTime.value,
    correlationId: correlationId.value,
    causationId: causationId.value,
    approximate: approximate.value,
  };

  switch (input.kind) {
    case "entity-moved": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const to = parseEntityId(input.to, "to");
      if (!to.ok) return to;
      return ok({
        ...envelope,
        kind: "entity-moved",
        entityId: entityId.value,
        to: to.value,
      });
    }
    case "realm-transitioned": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const to = parseEntityId(input.to, "to");
      if (!to.ok) return to;
      const via = parseEntityId(input.via, "via");
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
        `unknown event kind: ${String(input.kind)}`,
        "unknown-kind",
      );
  }
}
