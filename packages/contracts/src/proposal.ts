// Proposals are the only way routines, fixtures, the operator, and
// (reserved for M2) models can attempt to change committed world state.
// Every proposal is revalidated against expected entity revisions at
// execution time (packages/world, Unit 3+); this module only owns the wire
// shape and its parse-don't-validate parser. A proposal never mutates state
// by existing -- only a validator's commit does that.
//
// Observation records live here too (not a separate file, per the plan's
// "observation may live in proposal.ts if cleaner"): every proposal cites
// the observation it was made from, so the two shapes are tightly coupled.

import {
  type Brand,
  type EntityId,
  type EntityRevision,
  fail,
  idFactory,
  idParser,
  isRecord,
  ok,
  type ParseResult,
  parseArray,
  parseEntityId,
  parseEntityRevision,
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

// --- Proposal source and model reservation -----------------------------------

export const PROPOSAL_SOURCES = [
  "routine",
  "fixture",
  "operator",
  "model-reserved",
] as const;
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];

export type ModelRequestId = Brand<string, "ModelRequestId">;
export const parseModelRequestId = idParser<"ModelRequestId">();

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

/**
 * Starting byte-size cap for a serialized proposal (~16 KiB). A configurable
 * constant per Key Technical Decisions ("Proposal intake is bounded now,
 * before M2 makes it a model path"); revisit once packages/persistence
 * exposes real configuration (Unit 2+).
 */
export const PROPOSAL_BYTE_LIMIT = 16 * 1024;

export interface ProposalBase {
  readonly schemaVersion: number;
  readonly actor: EntityId;
  readonly targets: readonly EntityId[];
  readonly preconditions: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly costs: readonly ResourceAmount[];
  readonly expectedRevisions: readonly EntityRevision[];
  readonly source: ProposalSource;
  readonly modelRequestId?: ModelRequestId;
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

/**
 * A legend/claim ("I own the tavern") never grants state by itself: the
 * parser rejects a claim carrying costs, required capabilities, or expected
 * revisions with reason "unauthorized-claim" naming the offending field.
 */
export interface ClaimProposal extends ProposalBase {
  readonly kind: "claim";
  readonly assertion: string;
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
  | ClaimProposal;

function estimateByteSize(value: unknown): number | undefined {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return undefined;
  }
}

export function parseProposal(input: unknown): ParseResult<Proposal> {
  if (!isRecord(input)) {
    return fail("", "expected a proposal object");
  }

  const size = estimateByteSize(input);
  if (size === undefined) {
    return fail("", "proposal payload is not serializable");
  }
  if (size > PROPOSAL_BYTE_LIMIT) {
    return fail(
      "",
      `proposal exceeds the ${PROPOSAL_BYTE_LIMIT}-byte limit`,
      "over-limit",
    );
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

  const preconditions = parseArray(
    input.preconditions,
    "preconditions",
    parseString,
  );
  if (!preconditions.ok) return preconditions;

  const requiredCapabilities = parseArray(
    input.requiredCapabilities,
    "requiredCapabilities",
    parseString,
  );
  if (!requiredCapabilities.ok) return requiredCapabilities;

  const costs = parseArray(input.costs, "costs", parseResourceAmount);
  if (!costs.ok) return costs;

  const expectedRevisions = parseArray(
    input.expectedRevisions,
    "expectedRevisions",
    parseEntityRevision,
  );
  if (!expectedRevisions.ok) return expectedRevisions;

  const source = parseProposalSource(input.source, "source");
  if (!source.ok) return source;

  const modelRequestId =
    input.modelRequestId === undefined
      ? ok<ModelRequestId | undefined>(undefined)
      : parseModelRequestId(input.modelRequestId, "modelRequestId");
  if (!modelRequestId.ok) return modelRequestId;

  const observationId = parseObservationId(
    input.observationId,
    "observationId",
  );
  if (!observationId.ok) return observationId;

  const base: ProposalBase = {
    schemaVersion: schemaVersion.value,
    actor: actor.value,
    targets: targets.value,
    preconditions: preconditions.value,
    requiredCapabilities: requiredCapabilities.value,
    costs: costs.value,
    expectedRevisions: expectedRevisions.value,
    source: source.value,
    ...(modelRequestId.value === undefined
      ? {}
      : { modelRequestId: modelRequestId.value }),
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
      if (base.costs.length > 0) {
        return fail(
          "costs",
          "a claim may not carry costs",
          "unauthorized-claim",
        );
      }
      if (base.requiredCapabilities.length > 0) {
        return fail(
          "requiredCapabilities",
          "a claim may not require capabilities",
          "unauthorized-claim",
        );
      }
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
    default:
      return fail(
        "kind",
        `unknown proposal kind: ${String(input.kind)}`,
        "unknown-kind",
      );
  }
}
