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
  parseEnum,
  parseEventId,
  parseFiniteNumber,
  parseNonNegativeInteger,
  parseNonNegativeNumber,
  parseOptionalBoolean,
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

/** A deity's strike damaged a building that did not catch fire. `actor` is the deity, so what witnesses remember can name who did it. */
export interface BuildingDamagedEvent extends EventEnvelope {
  readonly kind: "building-damaged";
  readonly entityId: EntityId;
  readonly amount: number;
  readonly actor: EntityId;
}

/**
 * What started a fire, stored on the ignition event itself and never worked
 * out later. A strike is a root: the proposal that committed it is its cause.
 * A spread names the source building's own ignition event, and carries the
 * actor forward from it, so a chain of fires still answers who began it.
 */
export type FireCause =
  | { readonly kind: "strike"; readonly actor: EntityId }
  | {
      readonly kind: "spread";
      readonly from: EventId;
      readonly actor: EntityId;
    };

export interface BuildingIgnitedEvent extends EventEnvelope {
  readonly kind: "building-ignited";
  readonly entityId: EntityId;
  readonly cause: FireCause;
}

/** `cause` is the ignition event that started this building's fire. */
export interface BuildingBurnTickedEvent extends EventEnvelope {
  readonly kind: "building-burn-ticked";
  readonly entityId: EntityId;
  readonly fireIntensity: number;
  readonly ticksBurning: number;
  readonly cause: EventId;
}

/** `cause` is the ignition event that started this building's fire. */
export interface BuildingDestroyedEvent extends EventEnvelope {
  readonly kind: "building-destroyed";
  readonly entityId: EntityId;
  readonly disposedInventory: readonly ResourceAmount[];
  readonly cause: EventId;
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
 * Records that a narrative was told, never that it is true. `entityId` is
 * the narrator; `assertion` is their free-form, possibly false story.
 * `linkedEventId`, when present, is the narrator's cited evidence: an event
 * that exists in the log, and nothing more. The world does not judge whether
 * that event supports the assertion, so a link makes a legend "event-linked",
 * never certified. The legend's own identity is the identity of this event.
 */
export interface LegendRecordedEvent extends EventEnvelope {
  readonly kind: "legend-recorded";
  readonly entityId: EntityId;
  readonly assertion: string;
  readonly linkedEventId?: EventId;
}

/** Most characters of report text a proposal, an event, or a stored belief may hold. A D23 tunable (docs/product/defaults.md); a prompt-sized account, not a document. */
export const MAX_REPORT_LENGTH = 280;

/** What a happening did to someone, as a witness or a listener understands it. `target` is who or what suffered or was served, when someone was. */
export interface Consequence {
  readonly effect: "harm" | "kindness";
  readonly agent: EntityId;
  readonly target?: EntityId;
}

/**
 * One actor told another something, at the same place. The content is the
 * teller's own account: possibly wrong, never certified, and never rewritten
 * by the world. `claim` is what the teller asserts happened, in structure: it
 * may be false, and it is the only thing that gives the listener a consequence.
 * `linkedEventId`, when present, is an event the teller witnessed and cites as
 * provenance; it teaches the listener nothing by itself.
 */
export interface ReportToldEvent extends EventEnvelope {
  readonly kind: "report-told";
  readonly entityId: EntityId;
  readonly listenerId: EntityId;
  readonly content: string;
  readonly claim?: Consequence;
  readonly linkedEventId?: EventId;
}

/** Kinds that happen at no place: a report is heard only by its listener, a memory and a feeling are inside someone's head. Nobody perceives them, so nobody witnesses them. */
export const UNPLACED_EVENT_KINDS = [
  "report-told",
  "memory-recorded",
  "relationship-changed",
] as const;

/** The kinds an actor can witness. */
export type WitnessedEventKind = Exclude<
  WorldEvent["kind"],
  (typeof UNPLACED_EVENT_KINDS)[number]
>;

export interface MemoryRecordedBase extends EventEnvelope {
  readonly kind: "memory-recorded";
  /** Whose memory this is. */
  readonly entityId: EntityId;
  /** The committed event this memory rests on: the event witnessed, or the report heard. */
  readonly sourceEventId: EventId;
  /** How memorable this is; a full memory evicts its least salient entry first. A positive whole number. */
  readonly salience: number;
  readonly subjects: readonly EntityId[];
  readonly consequence?: Consequence;
}

/** The actor was there when the event happened. */
export interface WitnessedMemoryRecordedEvent extends MemoryRecordedBase {
  readonly memoryKind: "witnessed";
  readonly eventKind: WitnessedEventKind;
}

/** The actor was told, and holds the teller's account as a belief: attributed, possibly false, never resolved to the truth. */
export interface ToldMemoryRecordedEvent extends MemoryRecordedBase {
  readonly memoryKind: "told";
  readonly teller: EntityId;
  readonly content: string;
  readonly linkedEventId?: EventId;
}

export type MemoryRecordedEvent =
  | WitnessedMemoryRecordedEvent
  | ToldMemoryRecordedEvent;

/**
 * A relationship changed because of one memory: `entityId` now feels
 * differently toward `toward`. `memoryEventId` is the `memory-recorded` event
 * that formed the memory, so the change explains itself from the log alone.
 * `allied` is present only when the change flipped the alliance.
 */
export interface RelationshipChangedEvent extends EventEnvelope {
  readonly kind: "relationship-changed";
  readonly entityId: EntityId;
  readonly toward: EntityId;
  readonly affinityDelta: number;
  readonly grudgeDelta: number;
  readonly allied?: boolean;
  readonly memoryEventId: EventId;
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
  | LegendRecordedEvent
  | ReportToldEvent
  | MemoryRecordedEvent
  | RelationshipChangedEvent;

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
  "report-told": true,
  "memory-recorded": true,
  "relationship-changed": true,
};

/** Every event kind, kept exhaustive by the record above: adding a kind to `WorldEvent` fails typecheck until it is listed here. */
export const WORLD_EVENT_KINDS = Object.keys(
  EVENT_KIND_SET,
) as readonly WorldEvent["kind"][];

/** Every kind an actor can witness: all of them but the unplaced ones. */
export const WITNESSED_EVENT_KINDS = WORLD_EVENT_KINDS.filter(
  (kind): kind is WitnessedEventKind =>
    !(UNPLACED_EVENT_KINDS as readonly string[]).includes(kind),
);

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
      case "report-told":
        return [event.entityId, event.listenerId];
      case "relationship-changed":
        return [event.entityId, event.toward];
      case "memory-recorded":
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

/**
 * The event `event` follows from, when it names one: a burn or destruction
 * follows the ignition that started the fire; a spread follows the source
 * building's ignition; a memory follows the event it rests on; a report
 * follows the event it cites; a relationship change follows the memory that
 * caused it. A strike ignition, or any event a proposal committed with nothing
 * cited, is a root: its own proposal is its cause, and the trace holds that.
 */
export function eventCause(event: WorldEvent): EventId | undefined {
  switch (event.kind) {
    case "building-burn-ticked":
    case "building-destroyed":
      return event.cause;
    case "building-ignited":
      return event.cause.kind === "spread" ? event.cause.from : undefined;
    case "memory-recorded":
      return event.sourceEventId;
    case "report-told":
      return event.linkedEventId;
    case "relationship-changed":
      return event.memoryEventId;
    default:
      return undefined;
  }
}

/**
 * The chain of events that led to `eventId`, root first and ending at that
 * event, walked from the log alone with `getEvent` (so it needs no trace).
 * The chain ends early where the log has no such event; an unknown
 * `eventId` gives an empty chain.
 */
export function causalChain(
  getEvent: (id: EventId) => WorldEvent | undefined,
  eventId: EventId,
): readonly WorldEvent[] {
  const chain: WorldEvent[] = [];
  const seen = new Set<EventId>();
  let current = getEvent(eventId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    const cause = eventCause(current);
    current = cause === undefined ? undefined : getEvent(cause);
  }
  return chain;
}

export const LATEST_EVENT_SCHEMA_VERSION = 1;
const EVENT_SCHEMA_VERSIONS = [LATEST_EVENT_SCHEMA_VERSION] as const;

function parseInteger(value: unknown, path: string): ParseResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fail(path, "expected an integer");
  }
  return ok(value);
}

function parseOptionalEventId(
  value: unknown,
  path: string,
): ParseResult<EventId | undefined> {
  if (value === undefined) return ok(undefined);
  return parseEventId(value, path);
}

function parseFireCause(value: unknown, path: string): ParseResult<FireCause> {
  if (!isRecord(value)) return fail(path, "expected a fire cause object");
  const actor = parseEntityId(value.actor, `${path}.actor`);
  if (!actor.ok) return actor;
  if (value.kind === "strike") {
    return ok({ kind: "strike", actor: actor.value });
  }
  if (value.kind === "spread") {
    const from = parseEventId(value.from, `${path}.from`);
    if (!from.ok) return from;
    return ok({ kind: "spread", from: from.value, actor: actor.value });
  }
  return fail(path, `unknown fire cause: ${String(value.kind)}`);
}

const CONSEQUENCE_EFFECTS = ["harm", "kindness"] as const;

/** Parses a memory's optional consequence; `undefined` when absent. */
export function parseConsequence(
  value: unknown,
  path: string,
): ParseResult<Consequence | undefined> {
  if (value === undefined) return ok(undefined);
  if (!isRecord(value)) return fail(path, "expected a consequence object");
  const effect = parseEnum(value.effect, `${path}.effect`, CONSEQUENCE_EFFECTS);
  if (!effect.ok) return effect;
  const agent = parseEntityId(value.agent, `${path}.agent`);
  if (!agent.ok) return agent;
  const target =
    value.target === undefined
      ? ok<EntityId | undefined>(undefined)
      : parseEntityId(value.target, `${path}.target`);
  if (!target.ok) return target;
  return ok({
    effect: effect.value,
    agent: agent.value,
    ...(target.value === undefined ? {} : { target: target.value }),
  });
}

/** Report text: non-empty and at most `MAX_REPORT_LENGTH` characters. */
export function parseReportContent(
  value: unknown,
  path: string,
): ParseResult<string> {
  const content = parseString(value, path);
  if (!content.ok) return content;
  if (content.value.length > MAX_REPORT_LENGTH) {
    return fail(path, `expected at most ${MAX_REPORT_LENGTH} characters`);
  }
  return content;
}

/** A memory's salience: a positive whole number. */
export function parseSalience(
  value: unknown,
  path: string,
): ParseResult<number> {
  const salience = parseNonNegativeInteger(value, path);
  if (!salience.ok) return salience;
  if (salience.value < 1) return fail(path, "expected a positive integer");
  return salience;
}

function parseMemoryRecorded(
  input: Record<string, unknown>,
  envelope: EventEnvelope,
): ParseResult<MemoryRecordedEvent> {
  const entityId = parseEntityId(input.entityId, "entityId");
  if (!entityId.ok) return entityId;
  const sourceEventId = parseEventId(input.sourceEventId, "sourceEventId");
  if (!sourceEventId.ok) return sourceEventId;
  const salience = parseSalience(input.salience, "salience");
  if (!salience.ok) return salience;
  const subjects = parseArray(input.subjects, "subjects", parseEntityId);
  if (!subjects.ok) return subjects;
  const consequence = parseConsequence(input.consequence, "consequence");
  if (!consequence.ok) return consequence;
  const base = {
    ...envelope,
    kind: "memory-recorded" as const,
    entityId: entityId.value,
    sourceEventId: sourceEventId.value,
    salience: salience.value,
    subjects: subjects.value,
    ...(consequence.value === undefined
      ? {}
      : { consequence: consequence.value }),
  };

  switch (input.memoryKind) {
    case "witnessed": {
      const eventKind = parseEnum(
        input.eventKind,
        "eventKind",
        WITNESSED_EVENT_KINDS,
      );
      if (!eventKind.ok) return eventKind;
      return ok({
        ...base,
        memoryKind: "witnessed",
        eventKind: eventKind.value,
      });
    }
    case "told": {
      const teller = parseEntityId(input.teller, "teller");
      if (!teller.ok) return teller;
      const content = parseReportContent(input.content, "content");
      if (!content.ok) return content;
      const linkedEventId = parseOptionalEventId(
        input.linkedEventId,
        "linkedEventId",
      );
      if (!linkedEventId.ok) return linkedEventId;
      return ok({
        ...base,
        memoryKind: "told",
        teller: teller.value,
        content: content.value,
        ...(linkedEventId.value === undefined
          ? {}
          : { linkedEventId: linkedEventId.value }),
      });
    }
    default:
      return fail(
        "memoryKind",
        `unknown memory kind: ${String(input.memoryKind)}`,
      );
  }
}

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
      const actor = parseEntityId(input.actor, "actor");
      if (!actor.ok) return actor;
      return ok({
        ...envelope,
        kind: "building-damaged",
        entityId: entityId.value,
        amount: amount.value,
        actor: actor.value,
      });
    }
    case "building-ignited": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const cause = parseFireCause(input.cause, "cause");
      if (!cause.ok) return cause;
      return ok({
        ...envelope,
        kind: "building-ignited",
        entityId: entityId.value,
        cause: cause.value,
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
      const cause = parseEventId(input.cause, "cause");
      if (!cause.ok) return cause;
      return ok({
        ...envelope,
        kind: "building-burn-ticked",
        entityId: entityId.value,
        fireIntensity: fireIntensity.value,
        ticksBurning: ticksBurning.value,
        cause: cause.value,
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
      const cause = parseEventId(input.cause, "cause");
      if (!cause.ok) return cause;
      return ok({
        ...envelope,
        kind: "building-destroyed",
        entityId: entityId.value,
        disposedInventory: disposedInventory.value,
        cause: cause.value,
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
      const assertion = parseString(input.assertion, "assertion");
      if (!assertion.ok) return assertion;
      const linkedEventIdRaw = parseOptionalString(
        input.linkedEventId,
        "linkedEventId",
      );
      if (!linkedEventIdRaw.ok) return linkedEventIdRaw;
      return ok({
        ...envelope,
        kind: "legend-recorded",
        entityId: entityId.value,
        assertion: assertion.value,
        ...(linkedEventIdRaw.value === undefined
          ? {}
          : { linkedEventId: linkedEventIdRaw.value as EventId }),
      });
    }
    case "report-told": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const listenerId = parseEntityId(input.listenerId, "listenerId");
      if (!listenerId.ok) return listenerId;
      const content = parseReportContent(input.content, "content");
      if (!content.ok) return content;
      const claim = parseConsequence(input.claim, "claim");
      if (!claim.ok) return claim;
      const linkedEventId = parseOptionalEventId(
        input.linkedEventId,
        "linkedEventId",
      );
      if (!linkedEventId.ok) return linkedEventId;
      return ok({
        ...envelope,
        kind: "report-told",
        entityId: entityId.value,
        listenerId: listenerId.value,
        content: content.value,
        ...(claim.value === undefined ? {} : { claim: claim.value }),
        ...(linkedEventId.value === undefined
          ? {}
          : { linkedEventId: linkedEventId.value }),
      });
    }
    case "memory-recorded":
      return parseMemoryRecorded(input, envelope);
    case "relationship-changed": {
      const entityId = parseEntityId(input.entityId, "entityId");
      if (!entityId.ok) return entityId;
      const toward = parseEntityId(input.toward, "toward");
      if (!toward.ok) return toward;
      const affinityDelta = parseInteger(input.affinityDelta, "affinityDelta");
      if (!affinityDelta.ok) return affinityDelta;
      const grudgeDelta = parseNonNegativeInteger(
        input.grudgeDelta,
        "grudgeDelta",
      );
      if (!grudgeDelta.ok) return grudgeDelta;
      const allied = parseOptionalBoolean(input.allied, "allied");
      if (!allied.ok) return allied;
      const memoryEventId = parseEventId(input.memoryEventId, "memoryEventId");
      if (!memoryEventId.ok) return memoryEventId;
      return ok({
        ...envelope,
        kind: "relationship-changed",
        entityId: entityId.value,
        toward: toward.value,
        affinityDelta: affinityDelta.value,
        grudgeDelta: grudgeDelta.value,
        ...(allied.value === undefined ? {} : { allied: allied.value }),
        memoryEventId: memoryEventId.value,
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
