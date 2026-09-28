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
  type LegendId,
  ok,
  type ParseResult,
  parseArray,
  parseBoolean,
  parseCausationId,
  parseCorrelationId,
  parseEntityId,
  parseEventId,
  parseFiniteNumber,
  parseLegendId,
  parseNonNegativeInteger,
  parseNonNegativeNumber,
  parseOptionalString,
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

export interface BuildingDamagedEvent extends EventEnvelope {
  readonly kind: "building-damaged";
  readonly entityId: EntityId;
  readonly amount: number;
}

export interface BuildingIgnitedEvent extends EventEnvelope {
  readonly kind: "building-ignited";
  readonly entityId: EntityId;
}

export interface BuildingBurnTickedEvent extends EventEnvelope {
  readonly kind: "building-burn-ticked";
  readonly entityId: EntityId;
  readonly fireIntensity: number;
  readonly ticksBurning: number;
}

export interface BuildingDestroyedEvent extends EventEnvelope {
  readonly kind: "building-destroyed";
  readonly entityId: EntityId;
  readonly disposedInventory: readonly ResourceAmount[];
}

export interface RepairProgressedEvent extends EventEnvelope {
  readonly kind: "repair-progressed";
  readonly entityId: EntityId;
  readonly structureId: EntityId;
  readonly resource: string;
  readonly amount: number;
}

export interface BuildingRepairedEvent extends EventEnvelope {
  readonly kind: "building-repaired";
  readonly entityId: EntityId;
}

export interface WorshipPerformedEvent extends EventEnvelope {
  readonly kind: "worship-performed";
  readonly entityId: EntityId;
  readonly deity: EntityId;
  readonly offering?: ResourceAmount;
  readonly favorEffect: string;
  readonly favorExpiresAtTick: number;
}

export interface IncomeEarnedEvent extends EventEnvelope {
  readonly kind: "income-earned";
  readonly entityId: EntityId;
  readonly buildingId: EntityId;
  readonly amount: number;
}

/**
 * Records that a narrative was told, never that it is fact: `verified` is
 * exactly whether `linkedEventId` is present, so a rumor and a linked,
 * verified telling of the same happening are distinguished by this event
 * alone -- no separate lookup required.
 */
export interface LegendRecordedEvent extends EventEnvelope {
  readonly kind: "legend-recorded";
  readonly entityId: EntityId;
  readonly legendId: LegendId;
  readonly assertion: string;
  readonly linkedEventId?: EventId;
  readonly verified: boolean;
}

export type WorldEvent =
  | EntityMovedEvent
  | RealmTransitionedEvent
  | ResourceGatheredEvent
  | ResourceProducedEvent
  | ResourceTradedEvent
  | ResourceConsumedEvent
  | BuildingDamagedEvent
  | BuildingIgnitedEvent
  | BuildingBurnTickedEvent
  | BuildingDestroyedEvent
  | RepairProgressedEvent
  | BuildingRepairedEvent
  | WorshipPerformedEvent
  | IncomeEarnedEvent
  | LegendRecordedEvent;

const EVENT_KIND_SET: Record<WorldEvent["kind"], true> = {
  "entity-moved": true,
  "realm-transitioned": true,
  "resource-gathered": true,
  "resource-produced": true,
  "resource-traded": true,
  "resource-consumed": true,
  "building-damaged": true,
  "building-ignited": true,
  "building-burn-ticked": true,
  "building-destroyed": true,
  "repair-progressed": true,
  "building-repaired": true,
  "worship-performed": true,
  "income-earned": true,
  "legend-recorded": true,
};

/** Every event kind, kept exhaustive by the record above: adding a kind to `WorldEvent` fails typecheck until it is listed here. */
export const WORLD_EVENT_KINDS = Object.keys(
  EVENT_KIND_SET,
) as readonly WorldEvent["kind"][];

/**
 * The actor, building, location, and deity ids an event touches, in the
 * order its payload names them and without repeats. A client uses these
 * to decide which committed events concern what it is showing.
 */
export function eventSubjects(event: WorldEvent): readonly EntityId[] {
  const ids: readonly EntityId[] = (() => {
    switch (event.kind) {
      case "entity-moved":
        return [event.entityId, event.to];
      case "realm-transitioned":
        return [event.entityId, event.to, event.via];
      case "resource-traded":
        return [event.entityId, event.counterpartyId];
      case "repair-progressed":
        return [event.entityId, event.structureId];
      case "worship-performed":
        return [event.entityId, event.deity];
      case "income-earned":
        return [event.entityId, event.buildingId];
      case "resource-gathered":
      case "resource-produced":
      case "resource-consumed":
      case "building-damaged":
      case "building-ignited":
      case "building-burn-ticked":
      case "building-destroyed":
      case "building-repaired":
      case "legend-recorded":
        return [event.entityId];
    }
  })();
  return [...new Set(ids)];
}

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
    case "building-damaged": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const amount = parseNonNegativeNumber(input.amount, "amount");
      if (!amount.ok) return amount;
      return ok({
        ...envelope,
        kind: "building-damaged",
        entityId: entityId.value,
        amount: amount.value,
      });
    }
    case "building-ignited": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      return ok({
        ...envelope,
        kind: "building-ignited",
        entityId: entityId.value,
      });
    }
    case "building-burn-ticked": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const fireIntensity = parseNonNegativeNumber(
        input.fireIntensity,
        "fireIntensity",
      );
      if (!fireIntensity.ok) return fireIntensity;
      const ticksBurning = parseNonNegativeInteger(
        input.ticksBurning,
        "ticksBurning",
      );
      if (!ticksBurning.ok) return ticksBurning;
      return ok({
        ...envelope,
        kind: "building-burn-ticked",
        entityId: entityId.value,
        fireIntensity: fireIntensity.value,
        ticksBurning: ticksBurning.value,
      });
    }
    case "building-destroyed": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const disposedInventory = parseArray(
        input.disposedInventory,
        "disposedInventory",
        parseResourceAmount,
      );
      if (!disposedInventory.ok) return disposedInventory;
      return ok({
        ...envelope,
        kind: "building-destroyed",
        entityId: entityId.value,
        disposedInventory: disposedInventory.value,
      });
    }
    case "repair-progressed": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const structureId = parseEntityId(input.structureId, "structureId");
      if (!structureId.ok) return structureId;
      const resource = parseString(input.resource, "resource");
      if (!resource.ok) return resource;
      const amount = parseNonNegativeNumber(input.amount, "amount");
      if (!amount.ok) return amount;
      return ok({
        ...envelope,
        kind: "repair-progressed",
        entityId: entityId.value,
        structureId: structureId.value,
        resource: resource.value,
        amount: amount.value,
      });
    }
    case "building-repaired": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      return ok({
        ...envelope,
        kind: "building-repaired",
        entityId: entityId.value,
      });
    }
    case "worship-performed": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const deity = parseEntityId(input.deity, "deity");
      if (!deity.ok) return deity;
      const offering =
        input.offering === undefined
          ? ok<ResourceAmount | undefined>(undefined)
          : parseResourceAmount(input.offering, "offering");
      if (!offering.ok) return offering;
      const favorEffect = parseString(input.favorEffect, "favorEffect");
      if (!favorEffect.ok) return favorEffect;
      const favorExpiresAtTick = parseNonNegativeInteger(
        input.favorExpiresAtTick,
        "favorExpiresAtTick",
      );
      if (!favorExpiresAtTick.ok) return favorExpiresAtTick;
      return ok({
        ...envelope,
        kind: "worship-performed",
        entityId: entityId.value,
        deity: deity.value,
        ...(offering.value === undefined ? {} : { offering: offering.value }),
        favorEffect: favorEffect.value,
        favorExpiresAtTick: favorExpiresAtTick.value,
      });
    }
    case "income-earned": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const buildingId = parseEntityId(input.buildingId, "buildingId");
      if (!buildingId.ok) return buildingId;
      const amount = parseNonNegativeNumber(input.amount, "amount");
      if (!amount.ok) return amount;
      return ok({
        ...envelope,
        kind: "income-earned",
        entityId: entityId.value,
        buildingId: buildingId.value,
        amount: amount.value,
      });
    }
    case "legend-recorded": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const legendId = parseLegendId(input.legendId, "legendId");
      if (!legendId.ok) return legendId;
      const assertion = parseString(input.assertion, "assertion");
      if (!assertion.ok) return assertion;
      const linkedEventIdRaw = parseOptionalString(
        input.linkedEventId,
        "linkedEventId",
      );
      if (!linkedEventIdRaw.ok) return linkedEventIdRaw;
      const verified = parseBoolean(input.verified, "verified");
      if (!verified.ok) return verified;
      if (verified.value !== (linkedEventIdRaw.value !== undefined)) {
        return fail(
          "verified",
          "verified must equal whether linkedEventId is present",
        );
      }
      return ok({
        ...envelope,
        kind: "legend-recorded",
        entityId: entityId.value,
        legendId: legendId.value,
        assertion: assertion.value,
        ...(linkedEventIdRaw.value === undefined
          ? {}
          : { linkedEventId: linkedEventIdRaw.value as EventId }),
        verified: verified.value,
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
