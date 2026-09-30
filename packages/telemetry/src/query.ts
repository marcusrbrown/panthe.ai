// "Follow this event" query: walks from an event or a proposal outcome
// through observation -> model request (when a model produced the proposal)
// -> proposal -> validation -> event -> projection change -> presentation
// receipts, in order.

import type { Database } from "bun:sqlite";
import {
  causalChain,
  type EventId,
  type RejectionReasonCode,
} from "@panthea/contracts";
import {
  type EventSource,
  getModelRequestByProposalId,
  getObservation,
  getProposalOutcomeByEventId,
  getProposalOutcomeByProposalId,
  listReceiptsByEvent,
  type ModelRequestRow,
  type ObservationEntry,
  type ProposalId,
  type ProposalOutcomeRow,
  type ReceiptRow,
} from "./trace";

export type TraceStep =
  | {
      readonly step: "observation";
      readonly record: ObservationEntry["record"];
    }
  | { readonly step: "model-request"; readonly request: ModelRequestRow }
  | {
      readonly step: "proposal";
      readonly proposalId: ProposalId;
      readonly record: ProposalOutcomeRow["proposal"];
    }
  | {
      readonly step: "validation";
      readonly outcome: "committed" | "rejected";
      readonly reason?: RejectionReasonCode;
    }
  | { readonly step: "event"; readonly eventId: EventId }
  | { readonly step: "projection-change"; readonly revision: number }
  | {
      readonly step: "receipt";
      readonly sessionId: ReceiptRow["sessionId"];
      readonly presentedAtMs: ReceiptRow["presentedAtMs"];
    };

export interface FollowResult {
  readonly found: boolean;
  readonly steps: readonly TraceStep[];
}

/** The event hop, its projection change (the event's own committed sequence, since `commitTick` writes events and projections in one transaction), and every receipt recorded against it. */
function eventSteps(
  db: Database,
  eventSource: EventSource,
  eventId: EventId,
): readonly TraceStep[] {
  const steps: TraceStep[] = [{ step: "event", eventId }];
  const event = eventSource.getEvent(eventId);
  if (event) {
    steps.push({ step: "projection-change", revision: event.sequence });
  }
  for (const receipt of listReceiptsByEvent(db, eventId)) {
    steps.push({
      step: "receipt",
      sessionId: receipt.sessionId,
      presentedAtMs: receipt.presentedAtMs,
    });
  }
  return steps;
}

/**
 * The steps up to and including validation for one proposal outcome:
 * observation (if still resolvable), the model request that produced the
 * proposal (if a model did), the proposal, and its validation outcome.
 */
function causeSteps(db: Database, outcome: ProposalOutcomeRow): TraceStep[] {
  const steps: TraceStep[] = [];
  // A proposal refused for an observation conflict cited an id that is bound
  // to different evidence; showing that record would misattribute it.
  const observation =
    outcome.reason === "observation-conflict"
      ? undefined
      : getObservation(db, outcome.observationId);
  if (observation) {
    steps.push({ step: "observation", record: observation.record });
  }
  const request = getModelRequestByProposalId(db, outcome.proposalId);
  if (request) {
    steps.push({ step: "model-request", request });
  }
  steps.push({
    step: "proposal",
    proposalId: outcome.proposalId,
    record: outcome.proposal,
  });
  steps.push({
    step: "validation",
    outcome: outcome.outcome,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
  });
  return steps;
}

/**
 * Walks the causal chain of one committed event, root first: for each event
 * on the chain, the observation, model request, proposal, and validation that
 * produced it (when a proposal committed it), the event itself, its projection
 * change, and every presentation receipt recorded against it. Works for any
 * event a proposal committed, not only its first.
 *
 * The chain comes from the events themselves (`causalChain`): a fire's burn
 * ticks and destruction walk back through any spread to the ignition, and the
 * ignition is the strike's own event with its proposal; a relationship change
 * walks back through the memory that caused it to the event witnessed, or to
 * the report heard and the event it cited. An event nothing else caused (an
 * income event, a strike, a proposal's own event) is a chain of one: its own
 * proposal hops, if it has them, then the event.
 */
export function followEvent(
  db: Database,
  eventSource: EventSource,
  eventId: EventId,
): FollowResult {
  const chain = causalChain((id) => eventSource.getEvent(id), eventId);
  if (chain.length === 0) {
    return { found: false, steps: [] };
  }
  return {
    found: true,
    steps: chain.flatMap((event) => {
      const outcome = getProposalOutcomeByEventId(db, event.id);
      return [
        ...(outcome ? causeSteps(db, outcome) : []),
        ...eventSteps(db, eventSource, event.id),
      ];
    }),
  };
}

/**
 * Walks the causal chain starting from a proposal (covers the rejected
 * path, which never reaches a committed event): observation, proposal,
 * validation, and, for a committed outcome, each event it committed in
 * order with that event's projection change and receipts.
 */
export function followProposal(
  db: Database,
  eventSource: EventSource,
  proposalId: ProposalId,
): FollowResult {
  const outcome = getProposalOutcomeByProposalId(db, proposalId);
  if (!outcome) {
    return { found: false, steps: [] };
  }
  return {
    found: true,
    steps: [
      ...causeSteps(db, outcome),
      ...outcome.eventIds.flatMap((eventId) =>
        eventSteps(db, eventSource, eventId),
      ),
    ],
  };
}
