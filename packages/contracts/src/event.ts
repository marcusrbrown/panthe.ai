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
  parseArray,
  parseBoolean,
  parseCausationId,
  parseCorrelationId,
  parseEntityId,
  parseEventId,
  parseFiniteNumber,
  parseNonNegativeInteger,
  parseNonNegativeNumber,
  parseResourceAmount,
  parseSchemaVersion,
  parseString,
  type ResourceAmount,
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

export interface ResourceGatheredEvent extends EventEnvelope {
  readonly kind: "resource-gathered";
  readonly entityId: EntityId;
  readonly resource: string;
  readonly amount: number;
}

export interface ResourceProducedEvent extends EventEnvelope {
  readonly kind: "resource-produced";
  readonly entityId: EntityId;
  readonly output: string;
  readonly quantity: number;
}

export interface ResourceTradedEvent extends EventEnvelope {
  readonly kind: "resource-traded";
  readonly entityId: EntityId;
  readonly counterpartyId: EntityId;
  readonly give: readonly ResourceAmount[];
  readonly receive: readonly ResourceAmount[];
}

export interface ResourceConsumedEvent extends EventEnvelope {
  readonly kind: "resource-consumed";
  readonly entityId: EntityId;
  readonly resource: string;
  readonly amount: number;
}

export type WorldEvent =
  | EntityMovedEvent
  | RealmTransitionedEvent
  | ResourceGatheredEvent
  | ResourceProducedEvent
  | ResourceTradedEvent
  | ResourceConsumedEvent;

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
    case "resource-gathered": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const resource = parseString(input.resource, "resource");
      if (!resource.ok) return resource;
      const amount = parseNonNegativeNumber(input.amount, "amount");
      if (!amount.ok) return amount;
      return ok({
        ...envelope,
        kind: "resource-gathered",
        entityId: entityId.value,
        resource: resource.value,
        amount: amount.value,
      });
    }
    case "resource-produced": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const output = parseString(input.output, "output");
      if (!output.ok) return output;
      const quantity = parseNonNegativeNumber(input.quantity, "quantity");
      if (!quantity.ok) return quantity;
      return ok({
        ...envelope,
        kind: "resource-produced",
        entityId: entityId.value,
        output: output.value,
        quantity: quantity.value,
      });
    }
    case "resource-traded": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const counterpartyId = parseEntityId(
        input.counterpartyId,
        "counterpartyId",
      );
      if (!counterpartyId.ok) return counterpartyId;
      const give = parseArray(input.give, "give", parseResourceAmount);
      if (!give.ok) return give;
      const receive = parseArray(input.receive, "receive", parseResourceAmount);
      if (!receive.ok) return receive;
      return ok({
        ...envelope,
        kind: "resource-traded",
        entityId: entityId.value,
        counterpartyId: counterpartyId.value,
        give: give.value,
        receive: receive.value,
      });
    }
    case "resource-consumed": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const resource = parseString(input.resource, "resource");
      if (!resource.ok) return resource;
      const amount = parseNonNegativeNumber(input.amount, "amount");
      if (!amount.ok) return amount;
      return ok({
        ...envelope,
        kind: "resource-consumed",
        entityId: entityId.value,
        resource: resource.value,
        amount: amount.value,
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
