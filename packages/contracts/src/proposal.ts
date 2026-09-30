// Proposals are the only way routines, fixtures, and the operator can
// attempt to change committed world state. Every proposal is revalidated
// against expected entity revisions at execution time (packages/world);
// this module only owns the wire shape and its parse-don't-validate
// parser. A proposal never mutates state by existing -- only a validator's
// commit does that. Rules derive required capabilities and costs from
// world and content state, never from a proposal-declared field: a
// proposal that declares `preconditions`, `requiredCapabilities`, `costs`,
// or `modelRequestId` is rejected outright, since nothing evaluates those
// fields against any authority.
//
// Observation records live here too: every proposal cites the observation
// it was made from, so the two shapes are tightly coupled.

import {
  type Brand,
  type EntityId,
  type EntityRevision,
  type EventId,
  fail,
  idFactory,
  idParser,
  isRecord,
  ok,
  type ParseResult,
  parseArray,
  parseEntityId,
  parseEntityRevision,
  parseEventId,
  parseNonNegativeInteger,
  parseNonNegativeNumber,
  parseResourceAmount,
  parseSchemaVersion,
  parseString,
  type ResourceAmount,
} from "./ids";

// --- Observation records -----------------------------------------------------

export type ObservationId = Brand<string, "ObservationId">;
export const parseObservationId = idParser<"ObservationId">();
export const createObservationId = idFactory<"ObservationId">("obs");

export const OBSERVATION_SCHEMA_VERSIONS = [1] as const;

export interface ObservationRecord {
  readonly schemaVersion: number;
  readonly id: ObservationId;
  readonly observer: EntityId;
  readonly stateRevision: number;
  readonly factsRead: readonly string[];
  readonly source: ProposalSource;
}

export function parseObservationRecord(
  input: unknown,
): ParseResult<ObservationRecord> {
  if (!isRecord(input)) {
    return fail("", "expected an observation record object");
  }
  const schemaVersion = parseSchemaVersion(
    input.schemaVersion,
    OBSERVATION_SCHEMA_VERSIONS,
  );
  if (!schemaVersion.ok) return schemaVersion;
  const id = parseObservationId(input.id, "id");
  if (!id.ok) return id;
  const observer = parseEntityId(input.observer, "observer");
  if (!observer.ok) return observer;
  const stateRevision = parseNonNegativeInteger(
    input.stateRevision,
    "stateRevision",
  );
  if (!stateRevision.ok) return stateRevision;
  const factsRead = parseArray(input.factsRead, "factsRead", parseString);
  if (!factsRead.ok) return factsRead;
  const source = parseProposalSource(input.source, "source");
  if (!source.ok) return source;
  return ok({
    schemaVersion: schemaVersion.value,
    id: id.value,
    observer: observer.value,
    stateRevision: stateRevision.value,
    factsRead: factsRead.value,
    source: source.value,
  });
}

// --- Proposal source -----------------------------------------------------

export const PROPOSAL_SOURCES = [
  "routine",
  "fixture",
  "operator",
  "model",
  "director",
] as const;
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];

function parseProposalSource(
  value: unknown,
  path: string,
): ParseResult<ProposalSource> {
  if (
    typeof value !== "string" ||
    !(PROPOSAL_SOURCES as readonly string[]).includes(value)
  ) {
    return fail(path, `unknown proposal source: ${String(value)}`);
  }
  return ok(value as ProposalSource);
}

// --- Proposal envelope and kinds ----------------------------------------------

export const PROPOSAL_SCHEMA_VERSIONS = [1] as const;

/** Fields the current contract does not define; a proposal declaring any of these is rejected outright. */
const REMOVED_AUTHORITY_FIELDS = [
  "preconditions",
  "requiredCapabilities",
  "costs",
  "modelRequestId",
] as const;

export interface ProposalBase {
  readonly schemaVersion: number;
  readonly actor: EntityId;
  readonly targets: readonly EntityId[];
  readonly expectedRevisions: readonly EntityRevision[];
  readonly source: ProposalSource;
  readonly observationId: ObservationId;
}

export interface MoveProposal extends ProposalBase {
  readonly kind: "move";
  readonly to: EntityId;
}

export interface RealmTransitionProposal extends ProposalBase {
  readonly kind: "realm-transition";
  readonly to: EntityId;
  readonly via: EntityId;
}

export interface GatherProposal extends ProposalBase {
  readonly kind: "gather";
  readonly resource: string;
  readonly amount: number;
}

export interface ProduceProposal extends ProposalBase {
  readonly kind: "produce";
  readonly output: string;
  readonly quantity: number;
}

export interface TradeProposal extends ProposalBase {
  readonly kind: "trade";
  readonly counterparty: EntityId;
  readonly give: readonly ResourceAmount[];
  readonly receive: readonly ResourceAmount[];
}

export interface ConsumeProposal extends ProposalBase {
  readonly kind: "consume";
  readonly resource: string;
  readonly amount: number;
}

export interface StrikeProposal extends ProposalBase {
  readonly kind: "strike";
  readonly target: EntityId;
  readonly power: number;
}

export interface RepairProposal extends ProposalBase {
  readonly kind: "repair";
  readonly structure: EntityId;
}

export interface WorshipProposal extends ProposalBase {
  readonly kind: "worship";
  readonly deity: EntityId;
  readonly offering?: ResourceAmount;
}

/** A legend/claim ("I own the tavern") never grants state by itself: it may not assert expected entity revisions either. */
export interface ClaimProposal extends ProposalBase {
  readonly kind: "claim";
  readonly assertion: string;
}

/**
 * A narrative record, distinct from a claim: it commits regardless of
 * whether the assertion is true, since it records that someone told the
 * story -- never that the story is fact. `linkedEventId` cites an event
 * that exists in the log as the narrator's evidence; the world does not
 * judge whether it supports the story, so it makes the legend event-linked,
 * never certified. A second, disputed telling of the same event is simply
 * another legend, never a replacement for the first.
 */
export interface LegendProposal extends ProposalBase {
  readonly kind: "legend";
  readonly assertion: string;
  readonly linkedEventId?: EventId;
}

/**
 * One actor tells another, at the same place, something it says happened.
 * The content is the teller's own account and may be wrong or invented: the
 * world records that it was told, never that it is true. `linkedEventId`
 * cites an event the teller witnessed; the rules refuse a citation the teller
 * has no first-hand memory of.
 */
export interface ReportProposal extends ProposalBase {
  readonly kind: "report";
  readonly listener: EntityId;
  readonly content: string;
  readonly linkedEventId?: EventId;
}

export type Proposal =
  | MoveProposal
  | RealmTransitionProposal
  | GatherProposal
  | ProduceProposal
  | TradeProposal
  | ConsumeProposal
  | StrikeProposal
  | RepairProposal
  | WorshipProposal
  | ClaimProposal
  | LegendProposal
  | ReportProposal;

export type ProposalKind = Proposal["kind"];

// `satisfies Record<ProposalKind, true>` makes a new proposal kind fail to
// compile here until it is listed, so content that names a world action
// (god abilities) tracks the proposal contract.
const PROPOSAL_KIND_SET = {
  move: true,
  "realm-transition": true,
  gather: true,
  produce: true,
  trade: true,
  consume: true,
  strike: true,
  repair: true,
  worship: true,
  claim: true,
  legend: true,
  report: true,
} as const satisfies Record<ProposalKind, true>;

export const PROPOSAL_KINDS = Object.keys(
  PROPOSAL_KIND_SET,
) as readonly ProposalKind[];

export function parseProposal(input: unknown): ParseResult<Proposal> {
  if (!isRecord(input)) {
    return fail("", "expected a proposal object");
  }

  for (const field of REMOVED_AUTHORITY_FIELDS) {
    if (input[field] !== undefined) {
      return fail(
        field,
        `${field} is not a supported proposal field; rules derive it from world and content state`,
        "unauthorized-claim",
      );
    }
  }

  const schemaVersion = parseSchemaVersion(
    input.schemaVersion,
    PROPOSAL_SCHEMA_VERSIONS,
  );
  if (!schemaVersion.ok) return schemaVersion;

  const actor = parseEntityId(input.actor, "actor");
  if (!actor.ok) return actor;

  const targets = parseArray(input.targets, "targets", parseEntityId);
  if (!targets.ok) return targets;

  const expectedRevisions = parseArray(
    input.expectedRevisions,
    "expectedRevisions",
    parseEntityRevision,
  );
  if (!expectedRevisions.ok) return expectedRevisions;

  const source = parseProposalSource(input.source, "source");
  if (!source.ok) return source;

  const observationId = parseObservationId(
    input.observationId,
    "observationId",
  );
  if (!observationId.ok) return observationId;

  const base: ProposalBase = {
    schemaVersion: schemaVersion.value,
    actor: actor.value,
    targets: targets.value,
    expectedRevisions: expectedRevisions.value,
    source: source.value,
    observationId: observationId.value,
  };

  switch (input.kind) {
    case "move": {
      const to = parseEntityId(input.to, "to");
      if (!to.ok) return to;
      return ok({ ...base, kind: "move", to: to.value });
    }
    case "realm-transition": {
      const to = parseEntityId(input.to, "to");
      if (!to.ok) return to;
      const via = parseEntityId(input.via, "via");
      if (!via.ok) return via;
      return ok({
        ...base,
        kind: "realm-transition",
        to: to.value,
        via: via.value,
      });
    }
    case "gather": {
      const resource = parseString(input.resource, "resource");
      if (!resource.ok) return resource;
      const amount = parseNonNegativeNumber(input.amount, "amount");
      if (!amount.ok) return amount;
      return ok({
        ...base,
        kind: "gather",
        resource: resource.value,
        amount: amount.value,
      });
    }
    case "produce": {
      const output = parseString(input.output, "output");
      if (!output.ok) return output;
      const quantity = parseNonNegativeNumber(input.quantity, "quantity");
      if (!quantity.ok) return quantity;
      return ok({
        ...base,
        kind: "produce",
        output: output.value,
        quantity: quantity.value,
      });
    }
    case "trade": {
      const counterparty = parseEntityId(input.counterparty, "counterparty");
      if (!counterparty.ok) return counterparty;
      const give = parseArray(input.give, "give", parseResourceAmount);
      if (!give.ok) return give;
      const receive = parseArray(input.receive, "receive", parseResourceAmount);
      if (!receive.ok) return receive;
      return ok({
        ...base,
        kind: "trade",
        counterparty: counterparty.value,
        give: give.value,
        receive: receive.value,
      });
    }
    case "consume": {
      const resource = parseString(input.resource, "resource");
      if (!resource.ok) return resource;
      const amount = parseNonNegativeNumber(input.amount, "amount");
      if (!amount.ok) return amount;
      return ok({
        ...base,
        kind: "consume",
        resource: resource.value,
        amount: amount.value,
      });
    }
    case "strike": {
      const target = parseEntityId(input.target, "target");
      if (!target.ok) return target;
      const power = parseNonNegativeNumber(input.power, "power");
      if (!power.ok) return power;
      return ok({
        ...base,
        kind: "strike",
        target: target.value,
        power: power.value,
      });
    }
    case "repair": {
      const structure = parseEntityId(input.structure, "structure");
      if (!structure.ok) return structure;
      return ok({ ...base, kind: "repair", structure: structure.value });
    }
    case "worship": {
      const deity = parseEntityId(input.deity, "deity");
      if (!deity.ok) return deity;
      const offering =
        input.offering === undefined
          ? ok<ResourceAmount | undefined>(undefined)
          : parseResourceAmount(input.offering, "offering");
      if (!offering.ok) return offering;
      return ok({
        ...base,
        kind: "worship",
        deity: deity.value,
        ...(offering.value === undefined ? {} : { offering: offering.value }),
      });
    }
    case "claim": {
      if (base.expectedRevisions.length > 0) {
        return fail(
          "expectedRevisions",
          "a claim may not assert expected entity revisions",
          "unauthorized-claim",
        );
      }
      const assertion = parseString(input.assertion, "assertion");
      if (!assertion.ok) return assertion;
      return ok({ ...base, kind: "claim", assertion: assertion.value });
    }
    case "legend": {
      const assertion = parseString(input.assertion, "assertion");
      if (!assertion.ok) return assertion;
      const linkedEventId =
        input.linkedEventId === undefined
          ? ok<EventId | undefined>(undefined)
          : parseEventId(input.linkedEventId, "linkedEventId");
      if (!linkedEventId.ok) return linkedEventId;
      return ok({
        ...base,
        kind: "legend",
        assertion: assertion.value,
        ...(linkedEventId.value === undefined
          ? {}
          : { linkedEventId: linkedEventId.value }),
      });
    }
    case "report": {
      const listener = parseEntityId(input.listener, "listener");
      if (!listener.ok) return listener;
      const content = parseString(input.content, "content");
      if (!content.ok) return content;
      const linkedEventId =
        input.linkedEventId === undefined
          ? ok<EventId | undefined>(undefined)
          : parseEventId(input.linkedEventId, "linkedEventId");
      if (!linkedEventId.ok) return linkedEventId;
      return ok({
        ...base,
        kind: "report",
        listener: listener.value,
        content: content.value,
        ...(linkedEventId.value === undefined
          ? {}
          : { linkedEventId: linkedEventId.value }),
      });
    }
    default:
      return fail(
        "kind",
        `unknown proposal kind: ${String(input.kind)}`,
        "unknown-kind",
      );
  }
}
